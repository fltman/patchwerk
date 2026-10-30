// A live source as a track. Everything in Patchwerk reads the music through a reader, so this is
// another reader: the same questions, answered from the last few seconds instead of a whole file.
// Soundwerk tells it what it knows for certain (the Clock, the drum hits, the shape of the DJ's set)
// and sends its sound, which goes through the same band and spectrum maths as the offline analysis.
// Normalising can't see the whole track, so it uses the same percentiles over a rolling window.
import { BANDS, FFT_SIZE, SPEC_BINS, SPEC_MAX_HZ, SPEC_MIN_HZ, clamp01, percentile } from './analysis.js';
import { createFFT } from './fft.js';

export const HEAD = 8;          // sampleRate, position, bpm, running, kicks, snares, hats, kinds
const HISTORY = 1024;           // frames kept: about 20 s at 50 a second
const FRAME_RATE = 50;
const RENORM = 25;              // frames between fresh percentiles
const SLOW = 100;               // frames in the slow loudness behind `energy`: about 2 s
const FOLLOW = 0.1;             // how fast the beat follows the Clock, per frame
const JUMP = 1;                 // beats out: not drift, the Clock started over
const LISTEN = [
  // for a patch with no drum module of that kind: the same bands the offline analysis uses
  { name: 'kick', band: [30, 150], gap: 0.12, energy: true },
  { name: 'snare', band: [1500, 5000], gap: 0.1 },
  { name: 'hat', band: [7000, 16000], gap: 0.06 },
];
const ONSET = 0.5;              // share of the recent loudest rise that counts as a hit
const bandNames = Object.keys(BANDS);
const mod = (x, n) => ((x % n) + n) % n;

export class LiveAnalysis {
  constructor({ clock = () => performance.now() / 1000 } = {}) {
    this.clock = clock;
    this.samples = new Float32Array(FFT_SIZE);
    this.running = false;
    this.bpm = 120;
    this.frozen = 0;            // time so far, while stopped
    this.since = null;          // clock at which time last started moving
    this.anchorT = 0;           // the beat is anchorBeat at time anchorT, moving at the tempo
    this.anchorBeat = 0;
    this.counts = null;
    this.kinds = 0;
    this.hits = { kick: null, snare: null, hat: null };
    this.frames = 0;
    this.index = 0;
    this.now = { level: 0, bass: 0, lowmid: 0, mid: 0, high: 0, treble: 0, energy: 0 };
    this.arc = null;
    this.origin = 0;
    this.fft = createFFT(FFT_SIZE);
    this.re = new Float64Array(FFT_SIZE);
    this.im = new Float64Array(FFT_SIZE);
    this.mag = new Float64Array(FFT_SIZE / 2);
    this.prev = new Float64Array(FFT_SIZE / 2);
    this.win = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    this.ampScale = 2 / this.win.reduce((s, w) => s + w, 0);
    const ring = () => new Float32Array(HISTORY);
    this.raw = Object.fromEntries([...bandNames, 'level'].map((k) => [k, ring()]));
    this.peak = Object.fromEntries([...bandNames, 'level'].map((k) => [k, 1]));
    this.slow = ring();
    this.energy = ring();
    this.loudest = ring();      // the top of each frame's spectrum
    this.top = 0;
    this.flux = Object.fromEntries(LISTEN.map(({ name }) => [name, ring()]));
    this.fluxPeak = { kick: 1, snare: 1, hat: 1 };
    this.heardAt = { kick: -1, snare: -1, hat: -1 };
    this.band = null;
    this.analysis = {
      live: true, bpm: 120, downbeat: 0, duration: 0, beats: [], frames: HISTORY, frameRate: FRAME_RATE, specBins: SPEC_BINS,
      // twice over: wherever the ring wraps, the spectrogram can read straight back through history
      spectrum: new Uint8Array(2 * HISTORY * SPEC_BINS),
      sections: [],
    };
    this.setArc(null, 0);
    this.reader = this.makeReader();
  }

  get time() {
    return this.since === null ? this.frozen : this.frozen + this.clock() - this.since;
  }

  get period() { return 60 / this.bpm; }

  beatAt(t) { return this.anchorBeat + ((t - this.anchorT) * this.bpm) / 60; }

  setSampleRate(sr) {
    this.sampleRate = sr;
    const binHz = sr / FFT_SIZE, half = FFT_SIZE / 2;
    const bins = ([lo, hi]) => [Math.max(1, Math.round(lo / binHz)), Math.min(half - 1, Math.round(hi / binHz))];
    this.band = bandNames.map((k) => bins(BANDS[k]));
    this.listenBins = LISTEN.map((l) => bins(l.band));
    this.edges = Float64Array.from({ length: SPEC_BINS + 1 }, (_, b) => (SPEC_MIN_HZ * (SPEC_MAX_HZ / SPEC_MIN_HZ) ** (b / SPEC_BINS)) / binHz);
  }

  // One frame from the source. Returns true when something the page shows has changed.
  push(frame) {
    const [sampleRate, position, bpm, running, kicks, snares, hats, kinds] = frame;
    if (sampleRate !== this.sampleRate) this.setSampleRate(sampleRate);
    const changed = !!running !== this.running || bpm !== this.bpm;
    if (!!running !== this.running) {
      if (running) this.since = this.clock();
      else { this.frozen = this.time; this.since = null; }
      this.running = !!running;
    }
    this.bpm = this.analysis.bpm = bpm;
    this.follow(position / 4);
    this.count([kicks, snares, hats], kinds);
    this.samples.set(frame.subarray(HEAD, HEAD + FFT_SIZE));
    this.measure();
    this.frames++;
    return changed;
  }

  // Frames come in bursts; the picture needs a beat that moves every frame, so it follows the Clock
  // softly and only jumps when the Clock really did.
  follow(beat) {
    const t = this.time, off = beat - this.beatAt(t);
    if (!this.frames || !this.running || Math.abs(off) > JUMP) { this.anchorT = t; this.anchorBeat = beat; return; }
    this.anchorBeat = this.beatAt(t) + off * FOLLOW;
    this.anchorT = t;
  }

  count(counts, kinds) {
    this.kinds = kinds;
    if (this.counts) {
      ['kick', 'snare', 'hat'].forEach((name, k) => {
        if (counts[k] > this.counts[k]) this.hits[name] = { t: this.time, strength: 1 };
      });
    }
    this.counts = counts;
  }

  measure() {
    const { samples, re, im, win, fft, ampScale, band, raw, edges } = this;
    const half = FFT_SIZE / 2, hop = 256;
    let [mag, prev] = [this.mag, this.prev];
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[i];
      if (i >= half - hop && i < half + hop) sumSq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]) * ampScale;

    const at = (this.index = (this.index + 1) % HISTORY);
    bandNames.forEach((name, b) => {
      const [lo, hi] = band[b];
      let p = 0;
      for (let k = lo; k <= hi; k++) p += mag[k] * mag[k];
      raw[name][at] = Math.sqrt(p / (hi - lo + 1));
    });
    raw.level[at] = Math.sqrt(sumSq / (2 * hop));

    const out = at * SPEC_BINS, spectrum = this.analysis.spectrum, db = new Float32Array(SPEC_BINS);
    let most = -180;
    for (let b = 0; b < SPEC_BINS; b++) {
      const lo = edges[b], hi = edges[b + 1];
      let m;
      if (hi - lo < 1) {
        const c = (lo + hi) / 2, i0 = Math.floor(c), f = c - i0;
        m = (mag[i0] ?? 0) * (1 - f) + (mag[i0 + 1] ?? 0) * f;
      } else {
        m = 0;
        for (let k = Math.floor(lo); k < Math.ceil(hi) && k < half; k++) m = Math.max(m, mag[k]);
      }
      db[b] = 20 * Math.log10(m + 1e-9);
      if (db[b] > most) most = db[b];
    }
    this.loudest[at] = most;

    this.listen(at);
    if (this.frames % RENORM === 0) this.renormalise();

    for (let b = 0; b < SPEC_BINS; b++) spectrum[out + b] = Math.round(255 * clamp01((db[b] - (this.top - 60)) / 60));
    spectrum.copyWithin((HISTORY + at) * SPEC_BINS, out, out + SPEC_BINS);

    const now = this.now;
    now.level = clamp01(raw.level[at] / this.peak.level);
    for (const name of bandNames) now[name] = clamp01(raw[name][at] / this.peak[name]);
    this.slowEnergy(at);
    this.mag = prev;
    this.prev = mag;
  }

  // The kinds of drum this patch has no module for, heard the way the offline analysis hears them
  listen(at) {
    const { mag, prev, listenBins, flux } = this;
    LISTEN.forEach(({ name, gap, energy }, o) => {
      const [lo, hi] = listenBins[o];
      let x = 0;
      if (energy) {
        let e = 0, ep = 0;
        for (let k = lo; k <= hi; k++) { e += mag[k] * mag[k]; ep += prev[k] * prev[k]; }
        x = Math.max(0, Math.sqrt(e) - Math.sqrt(ep));
      } else {
        for (let k = lo; k <= hi; k++) x += Math.max(0, mag[k] - prev[k]);
        x /= hi - lo + 1;
      }
      flux[name][at] = x;
      if (this.kinds & (1 << o)) return;
      const t = this.time, strength = x / (this.fluxPeak[name] || 1);
      if (strength > ONSET && t - this.heardAt[name] >= gap) {
        this.heardAt[name] = t;
        this.hits[name] = { t, strength: Math.min(1, strength) };
      }
    });
  }

  renormalise() {
    const filled = this.frames < HISTORY ? this.index + 1 : HISTORY;
    const seen = (ring) => (filled < HISTORY ? ring.subarray(0, filled) : ring);
    for (const name of [...bandNames, 'level']) this.peak[name] = percentile(seen(this.raw[name]), 0.97) || 1;
    for (const { name } of LISTEN) this.fluxPeak[name] = percentile(seen(this.flux[name]), 0.98) || 1;
    this.top = percentile(seen(this.loudest), 0.9);
  }

  // ~2 s moving average of loudness, spread over its 5th–95th percentile, like the offline energy
  slowEnergy(at) {
    const { raw, slow } = this;
    let s = 0, n = 0;
    for (let k = 0; k < SLOW && k <= this.frames; k++) { s += raw.level[mod(at - k, HISTORY)]; n++; }
    slow[at] = s / n;
    if (this.frames % RENORM === 0) {
      const filled = this.frames < HISTORY ? slow.subarray(0, at + 1) : slow;
      this.lo = percentile(filled, 0.05);
      this.hi = percentile(filled, 0.95);
    }
    const spread = (this.hi ?? 0) - (this.lo ?? 0);
    this.now.energy = spread > 0.02 * (this.hi ?? 0) ? clamp01((slow[at] - this.lo) / spread) : 0.5;
    this.energy[at] = this.now.energy;
  }

  setArc(arc, origin) {
    this.arc = arc?.length ? arc : null;
    this.origin = origin ?? 0;
    const list = this.arc ?? [{ name: 'live', bars: 16 }];
    let bar = this.origin;
    this.analysis.sections = list.map((s) => {
      const out = { label: s.name, bar, bars: s.bars, start: bar * 4 * this.period, energy: 0.5 };
      bar += s.bars;
      return out;
    });
  }

  makeReader() {
    const live = this;
    const env = (hit, t, decay) => (hit ? hit.strength * Math.exp(-Math.max(0, t - hit.t) / decay) : 0);

    function features(t, decay = 0.2) {
      const pos = live.beatAt(t), index = Math.floor(pos), phase = pos - index, barPos = mod(index, 4);
      return {
        ...live.now,
        kick: env(live.hits.kick, t, decay),
        snare: env(live.hits.snare, t, decay),
        hat: env(live.hits.hat, t, decay * 0.6),
        beat: Math.exp(-(phase * live.period) / decay),
        downbeat: Math.exp(-((barPos + phase) * live.period) / decay),
        phase,
        bar: (barPos + phase) / 4,
        beatPos: pos,
        barIndex: Math.floor(index / 4),
      };
    }

    // the section a bar falls in. Without a DJ set the phrases are 16 bars, counted from the Clock.
    function sectionAtBar(bar) {
      const list = live.arc ?? [{ name: 'live', bars: 16 }];
      const total = list.reduce((s, x) => s + x.bars, 0);
      let into = mod(bar - live.origin, total);
      for (const [i, s] of list.entries()) {
        if (into < s.bars) {
          const next = list[(i + 1) % list.length];
          return { label: s.name, bar: bar - into, bars: s.bars, index: i, into, left: s.bars - into, energy: live.now.energy, next: { label: next.name, bars: next.bars } };
        }
        into -= s.bars;
      }
      return null;
    }

    return {
      features,
      sectionAtBar,
      analysis: live.analysis,
      frameAt: () => HISTORY + live.index,
      beatPosition: (t) => live.beatAt(t),
      barTime: (bar) => live.anchorT + ((bar * 4 - live.anchorBeat) * 60) / live.bpm,
      // what was, and for lack of a crystal ball what is
      energyAt: (t) => live.energy[mod(live.index - Math.max(0, Math.round((live.time - t) * FRAME_RATE)), HISTORY)],
      sampleEnd: () => FFT_SIZE,
      get period() { return live.period; },
    };
  }
}

// The page's end of /api/live: says when a source comes and goes and feeds the analysis.
export class LiveInput extends EventTarget {
  constructor() {
    super();
    this.analysis = new LiveAnalysis();
    this.available = false;
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        if (this.analysis.push(new Float32Array(e.data))) this.dispatchEvent(new Event('change'));
        return;
      }
      const m = JSON.parse(e.data);
      if ('source' in m) this.setAvailable(m.source);
      if ('arc' in m) { this.analysis.setArc(m.arc, m.origin); this.dispatchEvent(new Event('change')); }
    };
    ws.onclose = () => {
      this.setAvailable(false);
      setTimeout(() => this.connect(), 2000);
    };
  }

  setAvailable(on) {
    if (on === this.available) return;
    this.available = on;
    this.dispatchEvent(new Event('source'));
  }
}
