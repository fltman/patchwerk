// What the output looks like, in three numbers, a few times a second: a tiny copy
// of the frame is read back without ever stalling the GPU (see engine/tap.js).
import { FrameTap, HEADER } from '../engine/tap.js';

export const METER_W = 64;
export const METER_H = 36;
const EVERY_MS = 250;

export class PictureMeter {
  constructor(gl, onStats) {
    this.last = 0;
    this.prev = new Float32Array(METER_W * METER_H);
    this.tap = new FrameTap(gl, {
      wants: () => {
        const now = performance.now();
        if (now - this.last < EVERY_MS) return false;
        this.last = now;
        return true;
      },
      onFrame: (buf) => onStats(this.read(buf)),
    });
  }

  frame(tex) { this.tap.frame(tex, METER_W, METER_H); }

  // BGRA, 0..255. brightness and saturation are means; motion is how much the
  // brightness of each spot changed since the last look, scaled so 1 is a hard cut.
  read(buf) {
    const n = METER_W * METER_H;
    let bright = 0, sat = 0, moved = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[HEADER + i * 4] / 255, g = buf[HEADER + i * 4 + 1] / 255, r = buf[HEADER + i * 4 + 2] / 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const top = Math.max(r, g, b);
      bright += luma;
      if (top > 0.02) sat += (top - Math.min(r, g, b)) / top;
      moved += Math.abs(luma - this.prev[i]);
      this.prev[i] = luma;
    }
    const round = (x) => +x.toFixed(3);
    return { brightness: round(bright / n), saturation: round(sat / n), motion: round(Math.min(1, (moved / n) * 3)) };
  }
}
