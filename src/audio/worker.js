// Runs the offline analysis off the main thread.
import { analyze } from './analysis.js';

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  const result = analyze(samples, sampleRate, (progress) => self.postMessage({ progress }));
  const transfer = [result.level, result.energy, result.spectrum, result.beats, ...Object.values(result.bands),
    ...Object.values(result.onsets).flatMap((o) => [o.times, o.strengths])].map((a) => a.buffer);
  self.postMessage({ result }, transfer);
};
