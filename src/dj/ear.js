// The DJ's ears on a live input, where nobody knows what comes next. It hears the music a beat at a
// time and compares each beat with the same beat in the bars before, so a groove's own pattern isn't
// news, and speaks up as soon as the two stop matching. Only what has already been played goes in.
// It also watches the low end, unscaled: a muted kick still sends its hits, and bands scaled to the
// kick's own peaks hardly show it leaving. The numbers come from audio with a known answer: see
// test/ear.test.mjs.
const BANDS = ['level', 'bass', 'lowmid', 'mid', 'high', 'treble'];
const DRUMS = ['kick', 'snare', 'hat'];
const NAMES = [...BANDS, ...DRUMS];
const KICK = NAMES.indexOf('kick');
const LEVEL = NAMES.indexOf('level');

const NOW = 2;          // beats that have to sound different
const BARS_BACK = 4;    // bars they are compared with
const MIN_BACK = 2;     // bars needed before it can tell
const TOP = 3;          // features that count: a kick leaving moves two or three, the rest would hide it
const THRESHOLD = 5.5;  // times the usual bar-to-bar variation
const USUAL = 0.1;      // the usual variation until it has heard some
const FLOOR = 0.05;     // never steadier than this: even a tight loop breathes
const SETTLE = 0.02;    // how fast it learns the usual variation, per beat
const OUTLIER = 2;      // the most one beat can teach it, squared: learned in full, a near miss hides the next change
const MEMORY = 256;     // beats of loudness and low end it remembers: a couple of minutes
const HIT = 0.5;        // a drum envelope above this means it played on that beat
const DYNAMICS = 0.3;   // the gap between loud and quiet, as a share of loud, that means anything
const LOW_GONE = 0.6;   // share of its usual level below which the low end has left
const SAME_EVENT = 12;  // beats after a change in which the low end following it is no news
const LIFT = 0.1;       // energy rise that makes a change a drop
const TREND = 0.12;
const mean = (list) => list.reduce((s, x) => s + x, 0) / Math.max(1, list.length);

export class Ear {
  constructor() {
    this.spread = NAMES.map(() => USUAL * USUAL);
    this.loud = [];
    this.low = [];
    this.forget();
  }

  // the Clock jumped: what came before says nothing about the next beat
  forget() {
    this.prints = [];
    this.sum = new Array(NAMES.length).fill(0);
    this.frames = 0;
    this.beat = null;
    this.beats = 0;       // since the last change
    this.gone = false;    // the low end has left
    this.lifted = false;
    this.change = null;
    this.changedBar = null;
  }

  // One frame: the features, and unscaled(band). Returns the change when it has just heard one.
  hear(f, unscaled) {
    const beat = Math.floor(f.beatPos);
    let heard = null;
    if (beat !== this.beat) {
      if (this.frames && beat === this.beat + 1) heard = this.closeBeat();
      else if (this.beat !== null) this.forget();
      this.beat = beat;
      this.changedBar ??= Math.floor(beat / 4);
      this.sum.fill(0);
      this.loudSum = this.lowSum = 0;
      this.frames = 0;
    }
    NAMES.forEach((name, k) => { this.sum[k] = k < BANDS.length ? this.sum[k] + f[name] : Math.max(this.sum[k], f[name]); });
    this.loudSum += unscaled('level');
    this.lowSum += unscaled('bass');
    this.frames++;
    return heard;
  }

  closeBeat() {
    this.prints.push(this.sum.map((v, k) => (k < BANDS.length ? v / this.frames : v)));
    if (this.prints.length > (BARS_BACK + 1) * 4) this.prints.shift();
    this.loud.push(this.loudSum / this.frames);
    this.low.push(this.lowSum / this.frames);
    if (this.loud.length > MEMORY) { this.loud.shift(); this.low.shift(); }
    this.beats++;
    return this.compare();
  }

  // how far the last beats are from the same beats in earlier bars, feature by feature
  difference() {
    const { prints } = this, n = prints.length;
    const back = Math.min(BARS_BACK, Math.floor((n - NOW) / 4));
    if (back < MIN_BACK) return null;
    return NAMES.map((_, k) => {
      let d = 0;
      for (let i = 0; i < NOW; i++) {
        let before = 0;
        for (let j = 1; j <= back; j++) before += prints[n - 1 - i - 4 * j][k];
        d += prints[n - 1 - i][k] - before / back;
      }
      return d / NOW;
    });
  }

  compare() {
    const d = this.difference();
    if (!d) return null;
    const moved = d.map((x, k) => (x * x) / Math.max(FLOOR * FLOOR, this.spread[k])).sort((x, y) => y - x);
    d.forEach((x, k) => { this.spread[k] += (Math.min(x * x, OUTLIER * this.spread[k]) - this.spread[k]) * SETTLE; });
    const wasGone = this.gone;
    this.gone = this.lowGone();
    const flipped = this.gone !== wasGone && this.beats >= SAME_EVENT;
    if (!flipped && Math.sqrt(mean(moved.slice(0, TOP))) < THRESHOLD) return null;
    const was = this.energy(4, NOW);
    this.prints = this.prints.slice(-NOW); // what came before is another piece of music now
    this.beats = NOW;
    this.changedBar = Math.floor(this.beat / 4);
    this.gone = this.lowGone(); // now over the beats since the change
    this.change = this.name(d, this.gone !== wasGone);
    this.lifted = this.playing('kick') && (this.change.endsWith('came in') || this.energy() > was + LIFT);
    return this.change;
  }

  name(d, flipped) {
    if (d[KICK] < -0.4) return 'kick dropped out';
    if (d[KICK] > 0.4) return 'kick came in';
    if (flipped) return this.gone ? 'low end dropped out' : 'low end came in';
    return d[LEVEL] > 0 ? 'got bigger' : 'got smaller';
  }

  // 0..1 between the quietest and loudest of what it has heard lately; 0.5 until those really differ
  energy(beats = this.window(), skip = 0) {
    const sorted = [...this.loud].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0, hi = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    if (hi - lo < DYNAMICS * hi) return 0.5;
    const end = this.loud.length - skip;
    return Math.max(0, Math.min(1, (mean(this.loud.slice(Math.max(0, end - beats), end)) - lo) / (hi - lo)));
  }

  // a bar, or what there is of it since the music changed
  window() { return Math.max(NOW, Math.min(4, this.beats)); }

  playing(drum) {
    const k = NAMES.indexOf(drum);
    return this.prints.slice(-this.window()).some((p) => p[k] >= HIT) && !(k === KICK && this.lowGone());
  }

  // a muted channel still sends its hits; what's missing is the thump
  lowGone() {
    const usual = [...this.low].sort((a, b) => a - b)[Math.floor(this.low.length * 0.9)] ?? 0;
    return mean(this.low.slice(-this.window())) < LOW_GONE * usual;
  }

  // What the music is doing now, in the words a rig uses. Nothing here looks ahead.
  now(bar) {
    const is = this.energy(), was = this.energy(8, this.window());
    const trend = is - was > TREND ? 'rising' : was - is > TREND ? 'falling' : 'steady';
    const into = Math.max(0, bar - (this.changedBar ?? bar));
    return {
      section: this.playing('kick') ? (this.lifted ? 'drop' : 'groove') : trend === 'rising' ? 'build' : 'breakdown',
      bars_into_section: into,
      energy: +is.toFixed(2),
      energy_trend: trend,
      drums: DRUMS.filter((d) => this.playing(d)),
      ...(this.change && into <= 1 ? { just_changed: this.change } : {}),
    };
  }
}
