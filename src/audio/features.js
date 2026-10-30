// Reads the offline analysis at any time t — the same answer whether you are
// playing, paused or scrubbing. Envelopes are rebuilt from onset lists.

export const FEATURE_NAMES = [
  'level', 'bass', 'lowmid', 'mid', 'high', 'treble',
  'kick', 'snare', 'hat', 'beat', 'downbeat', 'phase', 'bar', 'energy',
];

export function createReader(a) {
  const n = a.frames;
  const fr = a.frameRate;
  const beats = a.beats;
  const period = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 60 / (a.bpm || 120);

  const sample = (arr, t) => {
    const x = t * fr;
    const i = Math.floor(x);
    if (i <= 0) return arr[0];
    if (i >= n - 1) return arr[n - 1];
    const f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };

  // largest i with times[i] <= t, or -1
  const lastIndex = (times, t) => {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

  const onsetEnv = ({ times, strengths }, t, decay) => {
    const i = lastIndex(times, t);
    return i < 0 ? 0 : strengths[i] * Math.exp(-(t - times[i]) / decay);
  };

  // continuous beat position (beat index + phase), extrapolated past the ends
  const beatPosition = (t) => {
    if (!beats.length) return t / period;
    if (t < beats[0]) return (t - beats[0]) / period;
    const i = lastIndex(beats, t);
    if (i >= beats.length - 1) return i + (t - beats[i]) / period;
    return i + (t - beats[i]) / (beats[i + 1] - beats[i]);
  };
  const beatTime = (pos) => {
    if (!beats.length) return pos * period;
    if (pos < 0) return beats[0] + pos * period;
    if (pos >= beats.length - 1) return beats[beats.length - 1] + (pos - (beats.length - 1)) * period;
    const i = Math.floor(pos);
    return beats[i] + (pos - i) * (beats[i + 1] - beats[i]);
  };

  function features(t, decay = 0.2) {
    const pos = beatPosition(t);
    const index = Math.floor(pos);
    const phase = pos - index;
    const sinceBeat = t - beatTime(index);
    const barPos = (((index - a.downbeat) % 4) + 4) % 4;
    const sinceDown = t - beatTime(index - barPos);
    return {
      level: sample(a.level, t),
      bass: sample(a.bands.bass, t),
      lowmid: sample(a.bands.lowmid, t),
      mid: sample(a.bands.mid, t),
      high: sample(a.bands.high, t),
      treble: sample(a.bands.treble, t),
      kick: onsetEnv(a.onsets.kick, t, decay),
      snare: onsetEnv(a.onsets.snare, t, decay),
      hat: onsetEnv(a.onsets.hat, t, decay * 0.6),
      beat: Math.exp(-sinceBeat / decay),
      downbeat: Math.exp(-sinceDown / decay),
      phase,
      bar: (barPos + phase) / 4,
      energy: sample(a.energy, t),
      beatPos: pos,
      barIndex: Math.floor((index - a.downbeat) / 4),
    };
  }

  const frameAt = (t) => Math.max(0, Math.min(n - 1, Math.round(t * fr)));

  return { features, frameAt, beatPosition, period, analysis: a };
}
