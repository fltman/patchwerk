// Prints a track's bars (start time, energy, kick count) so video cuts can land on the one.
//   node tools/bars.mjs video/born.mp3
import { spawnSync } from 'node:child_process';
import { analyze } from '../src/audio/analysis.js';
import { createReader } from '../src/audio/features.js';

const file = process.argv[2];
const pcm = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '44100', '-'], { maxBuffer: 1 << 30 }).stdout;
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
const a = analyze(samples, 44100);
const r = createReader(a);
console.log(`${a.bpm.toFixed(2)} BPM · bar = ${(240 / a.bpm).toFixed(4)} s · ${a.duration.toFixed(1)} s · downbeat index ${a.downbeat}`);
console.log('bar  start    energy  kicks  ' + '(energy bar)');
const beats = Array.from(a.beats);
for (let i = a.downbeat, bar = 1; i < beats.length; i += 4, bar++) {
  const t = beats[i], end = beats[i + 4] ?? a.duration;
  let e = 0, n = 0;
  for (let x = t; x < end; x += 0.05) { e += r.features(x).energy; n++; }
  e /= n;
  const kicks = a.onsets.kick.times.filter((k) => k >= t && k < end).length;
  console.log(`${String(bar).padStart(3)}  ${t.toFixed(2).padStart(6)}   ${e.toFixed(2)}    ${String(kicks).padStart(2)}   ${'█'.repeat(Math.round(e * 30))}`);
}
