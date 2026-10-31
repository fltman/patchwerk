// Lights. Two modules that write into the frame's DMX universe (ctx.dmx, 512 bytes, cleared every
// frame): channels from cables, and a picture turned into a grid of fixtures. Where two modules
// claim a channel the higher value wins, as on a lighting desk. See src/dmx/serial.js for the USB side.
import { HEADER } from '../engine/tap.js';

const CHANNELS = 8;
const light = (dmx, channel, value) => { if (channel < 512) dmx[channel] = Math.max(dmx[channel], Math.round(value * 255)); };

// from a colour to what a fixture of each kind wants on its channels
const LAYOUTS = [
  (r, g, b) => [r, g, b],
  (r, g, b) => { const w = Math.min(r, g, b); return [r - w, g - w, b - w, w]; },
  (r, g, b) => [1, r, g, b],
];

export default [
  {
    type: 'dmx-out',
    title: 'DMX Out',
    category: 'dmx',
    description: 'Eight DMX channels from an address on: plug any control signal in to drive dimmers, strobes, moving heads',
    tags: ['dmx', 'dmx512', 'light', 'lights', 'fixture', 'dimmer', 'usb', 'lamp'],
    params: [
      { name: 'address', label: 'Address', min: 1, max: 512, default: 1, step: 1 },
      ...Array.from({ length: CHANNELS }, (_, i) => ({ name: `ch${i + 1}`, label: `Ch ${i + 1}`, min: 0, max: 1, default: 0 })),
    ],
    process(ctx, p) {
      for (let i = 0; i < CHANNELS; i++) light(ctx.dmx, p.address - 1 + i, p[`ch${i + 1}`]);
    },
  },
  {
    type: 'dmx-pixels',
    title: 'DMX Pixels',
    category: 'dmx',
    description: 'Turns the picture into lights: a grid of DMX fixtures, each lit by the colours under it. The picture passes through unchanged',
    tags: ['dmx', 'dmx512', 'light', 'lights', 'pixel', 'mapping', 'led', 'par', 'fixture', 'usb'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'address', label: 'Address', min: 1, max: 512, default: 1, step: 1 },
      { name: 'columns', label: 'Columns', min: 1, max: 32, default: 4, step: 1 },
      { name: 'rows', label: 'Rows', min: 1, max: 16, default: 1, step: 1 },
      { name: 'layout', label: 'Fixture', type: 'select', options: ['RGB', 'RGBW', 'Dimmer + RGB'], default: 0 },
      { name: 'level', label: 'Level', min: 0, max: 1, default: 1 },
    ],
    cells: (p) => [p.columns, p.rows], // the engine reads back this grid of the node's picture into st.picture
    glsl: `
vec4 render(vec2 uv) {
  return texture(t_src, uv);
}`,
    // left to right, top row first; a change of grid shows on the next read
    process(ctx, p, st) {
      const pic = st.picture;
      if (!pic) return;
      const head = new DataView(pic.buffer), w = head.getUint32(0, true), h = head.getUint32(4, true);
      const lamps = [];
      let channel = p.address - 1;
      for (let i = 0; i < w * h; i++) {
        const at = HEADER + i * 4;
        const r = (pic[at + 2] / 255) * p.level, g = (pic[at + 1] / 255) * p.level, b = (pic[at] / 255) * p.level;
        lamps.push([r, g, b]);
        for (const v of LAYOUTS[p.layout](r, g, b)) light(ctx.dmx, channel++, v);
      }
      st.lamps = { w, h, lamps };
    },
  },
];
