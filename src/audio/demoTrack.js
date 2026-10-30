// A one-minute acid techno loop synthesised offline with Web Audio, so the app
// has something to play before you drop in a track. 130 BPM, 32 bars:
// intro (kick + acid) → drums in → open hats → breakdown + riser → full.

export const DEMO_BPM = 130;

const PATTERNS = [
  // [semitone | null, accent, slide] × 16 — root A1 (55 Hz)
  [[0, 1], [0], [12, 0, 1], [0], [null], [0, 1], [3], [0], [15, 1, 1], [12], [0], [null], [7, 1], [0], [10, 0, 1], [12]],
  [[0], [0, 1], [null], [12], [0], [5, 1, 1], [0], [17, 1], [null], [0], [12, 0, 1], [15], [0, 1], [null], [3], [7, 0, 1]],
];

export async function renderDemoTrack(sampleRate = 44100) {
  const beat = 60 / DEMO_BPM;
  const step = beat / 4;
  const bar = beat * 4;
  const BARS = 32;
  const duration = BARS * bar + 1.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.12;
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(comp).connect(ctx.destination);

  // seeded noise so every render is identical
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const noise = ctx.createBuffer(1, sampleRate * 2, sampleRate);
  noise.getChannelData(0).forEach((_, i, d) => { d[i] = rnd(); });

  const section = (b) => ({
    kick: b < 16 || b >= 20,
    hats: b >= 4 && b < 16 ? 1 : b >= 20 ? 2 : 0,
    clap: (b >= 4 && b < 16) || b >= 20,
    open: (b >= 12 && b < 16) || b >= 24,
    cutoff: b < 4 ? 260 + b * 60 : b < 12 ? 420 : b < 16 ? 420 + (b - 12) * 260 : b < 20 ? 900 + (b - 16) * 500 : 700 + ((b - 20) % 4) * 300,
    resonance: b >= 16 && b < 20 ? 22 : 16,
    transpose: b >= 24 && b < 28 ? 3 : 0,
  });

  const noiseHit = (t, len, gain, decay, filterType, freq, q = 0.7) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.002, decay);
    src.connect(f).connect(g).connect(master);
    src.start(t, (Math.abs(rnd()) * 1.5));
    src.stop(t + len);
  };

  // ── acid voice: one saw, a resonant lowpass, VCA, sidechain duck, drive, delay ──
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  const vca = ctx.createGain();
  vca.gain.value = 0;
  const duck = ctx.createGain();
  const drive = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 2.2);
  drive.curve = curve;
  const acidOut = ctx.createGain();
  acidOut.gain.value = 0.32;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = step * 3;
  const fb = ctx.createGain();
  fb.gain.value = 0.38;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 2500;
  const send = ctx.createGain();
  send.gain.value = 0.3;
  osc.connect(filter).connect(vca).connect(duck).connect(drive).connect(acidOut).connect(master);
  acidOut.connect(send).connect(delay).connect(delayTone).connect(fb).connect(delay);
  delayTone.connect(master);
  osc.start(0);
  osc.stop(duration);

  for (let b = 0; b < BARS; b++) {
    const s = section(b);
    const pattern = PATTERNS[Math.floor(b / 4) % 2];
    filter.Q.setValueAtTime(s.resonance, b * bar);
    for (let i = 0; i < 16; i++) {
      const t = b * bar + i * step;
      const [note, accent, slide] = pattern[i];
      const prevSlide = (pattern[(i + 15) % 16] || [])[2];
      if (note === null) {
        vca.gain.setTargetAtTime(0, t, 0.008);
        continue;
      }
      const freq = 55 * Math.pow(2, (note + s.transpose) / 12);
      if (prevSlide) osc.frequency.setTargetAtTime(freq, t, 0.025);
      else osc.frequency.setValueAtTime(freq, t);
      if (!prevSlide) {
        vca.gain.setValueAtTime(accent ? 1 : 0.7, t);
        const peak = s.cutoff * (accent ? 5 : 3);
        filter.frequency.setValueAtTime(peak, t);
        filter.frequency.setTargetAtTime(s.cutoff, t + 0.003, accent ? 0.09 : 0.14);
      }
      if (!slide) vca.gain.setTargetAtTime(0, t + step * 0.72, 0.01);
    }
  }

  for (let b = 0; b < BARS; b++) {
    const s = section(b);
    for (let k = 0; k < 4; k++) {
      const t = b * bar + k * beat;
      if (s.kick) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(160, t);
        o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
        g.gain.setValueAtTime(1.1, t);
        g.gain.setTargetAtTime(0, t + 0.06, 0.09);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + 0.6);
        // sidechain pump on the acid
        duck.gain.setValueAtTime(0.35, t);
        duck.gain.setTargetAtTime(1, t + 0.02, 0.07);
      }
      if (s.clap && (k === 1 || k === 3)) {
        for (const d of [0, 0.011, 0.023]) noiseHit(t + d, 0.05, 0.5, 0.006, 'bandpass', 1400, 0.9);
        noiseHit(t + 0.03, 0.3, 0.4, 0.06, 'bandpass', 1300, 0.8);
      }
      if (s.hats) {
        noiseHit(t + beat / 2, 0.08, 0.32, 0.014, 'highpass', 8000);
        if (s.hats > 1) {
          noiseHit(t + beat / 4, 0.05, 0.12, 0.008, 'highpass', 9000);
          noiseHit(t + (3 * beat) / 4, 0.05, 0.12, 0.008, 'highpass', 9000);
        }
      }
      if (s.open && k % 2 === 1) noiseHit(t + beat / 2, 0.4, 0.2, 0.09, 'highpass', 7000);
    }
    if (b === 4 || b === 20 || b === 28) noiseHit(b * bar, 2.5, 0.35, 0.7, 'highpass', 4500);
  }

  // riser into the drop (bar 19)
  const riser = ctx.createBufferSource();
  riser.buffer = noise;
  riser.loop = true;
  const rf = ctx.createBiquadFilter();
  rf.type = 'bandpass';
  rf.Q.value = 2;
  rf.frequency.setValueAtTime(300, 18 * bar);
  rf.frequency.exponentialRampToValueAtTime(9000, 20 * bar);
  const rg = ctx.createGain();
  rg.gain.setValueAtTime(0, 18 * bar);
  rg.gain.linearRampToValueAtTime(0.5, 20 * bar - 0.01);
  rg.gain.linearRampToValueAtTime(0, 20 * bar);
  riser.connect(rf).connect(rg).connect(master);
  riser.start(18 * bar);
  riser.stop(20 * bar);

  return ctx.startRendering();
}
