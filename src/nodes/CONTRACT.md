# Node contract

Patchwerk is a modular visual synth. Every box in the graph is a **node
definition**: a plain object in one of the files in `src/nodes/`. This file is
the contract between the node library and the engine. Change it before
you change the code.

## Two kinds of signal

| Signal | Cable colour | Carried by | Typical range |
|---|---|---|---|
| **control** (float) | orange | CPU, once per frame | 0..1 (audio features, LFOs) |
| **image** | green | GPU texture (RGBA16F, output resolution) | colour 0..1 |

Image nodes (`generator`, `effect`, `mix`) are one fullscreen fragment pass
each, rendering to their own framebuffer. Control nodes (`audio`, `control`)
are JavaScript. Image nodes have exactly one image output; their float
**params** are the control inputs.

## Image node definition

```js
{
  type: 'kaleidoscope',            // unique id, lowercase-kebab
  title: 'Kaleidoscope',           // shown in the node header
  category: 'effect',              // 'generator' | 'effect' | 'mix'
  description: 'Mirrored slices around the centre',   // one line, shown in the add menu
  tags: ['mirror', 'symmetry'],    // optional extra search words
  inputs: [{ name: 'src', label: 'Image' }],          // image inputs → uniform sampler2D t_<name>
  params: [
    { name: 'segments', label: 'Segments', min: 1, max: 16, default: 6, step: 1 },
    { name: 'speed', label: 'Spin', min: -2, max: 2, default: 0.1, integrate: true },
    { name: 'mode', label: 'Mode', type: 'select', options: ['Fold', 'Wrap'], default: 0 },
    { name: 'tint', label: 'Tint', type: 'color', default: '#ff2a6d' },
  ],
  feedback: false,                 // true → uniform sampler2D t_prev = this node's own output, previous frame
  lod: false,                      // true → inputs get mipmaps, so textureLod(t_src, uv, lod) is valid (cheap big blurs)
  glsl: `
vec4 render(vec2 uv) {
  ...
}`,
}
```

### Params → uniforms

| Param | GLSL | Patchable by a cable? |
|---|---|---|
| float (default, has `min`/`max`/`default`, optional `step`) | `uniform float p_<name>` | yes |
| float with `integrate: true` | also `uniform float p_<name>_t` = ∫ value dt over track time | yes |
| `type: 'select'` with `options` | `uniform int p_<name>` (option index) | yes — the cable (0..1) picks the option |
| `type: 'color'` with hex default | `uniform vec3 p_<name>` (0..1 sRGB) | no |

When a cable is plugged into a float param, the engine computes
`base + cable × depth × (max − min)` clamped to `[min, max]`, where *base* is the
slider and *depth* a second slider that appears when patched. So params are
always within their declared range. Choose ranges where the whole range looks good.
Params with a `step` are rounded to it by the engine after modulation. A cable
into a select picks option `floor(cable × count)`, so a Sequencer can switch modes.

**Animation speed:** never write `u_time * p_speed`. When the speed is
modulated by the music that expression jumps back and forth. Mark rate params
`integrate: true` and use `p_speed_t` — it is the accumulated phase and
always moves smoothly forward (faster when the cable pushes the speed up).
`u_time` (track time) is fine for things that should not be speed-controlled.

### The body

* Define `vec4 render(vec2 uv)`. `uv` is 0..1 with (0,0) bottom-left.
* Colour is **premultiplied**: rgb is the visible colour, alpha is coverage. Full
  images have alpha 1. Shape layers (bars, scope lines, polygons) are black with
  alpha 0 outside the shape; a soft edge or glow fades rgb and alpha together.
  Mix nodes un-premultiply the top layer before blending. The output ignores
  alpha (black underneath). Blurs average rgb and alpha alike.
* Per-frame amounts (decay in a feedback loop) must be frame-rate independent:
  `pow(decay, u_dt * 60.0)` = decay per 1/60 s. `u_dt` is wall-clock frame time,
  so feedback keeps evolving while the track is paused; `u_time` and the
  integrated `p_<name>_t` phases stop.
* `smoothstep(e0, e1, x)` with e0 ≥ e1 and `pow(0.0, 0.0)` are undefined — in a
  feedback loop one NaN pixel stays forever. Guard them.
* Unconnected image inputs read as transparent black.
* Everything is deterministic: no state except through `feedback`.
* Prelude helpers (see `src/engine/prelude.js`): `centered(uv)` (aspect-correct,
  origin centre, y −0.5..0.5), `uncenter(p)`, `rot2(a)`, `mirrorUV`,
  `texBorder / texMirror / texRepeat`, `spectrum(x)`, `spectrogram(x, age)`,
  `wave(x)`, `luma`, `hsv2rgb`, `rgb2hsv`, `cosPalette`, `hash11/12/22/32`,
  `snoise(vec3)`, `snoise(vec2)`, `fbm(vec3, octaves)`, `sdCircle`, `sdBox`,
  `smin`, `fillSd(d)` (anti-aliased fill), `PI`, `TAU`.
* Globals: `u_time`, `u_dt` (wall-clock seconds this frame), `u_frame`, `u_res`, `u_aspect`, `u_spectrum`
  (128×1 log spectrum), `u_spectrogram` (128×128, y = age), `u_wave` (512×1, −1..1).
* GLSL ES 3.00 (`texture()`, not `texture2D()`). Loops need constant bounds —
  use `for (int i = 0; i < 64; i++) { if (i >= n) break; ... }`.
* Keep it fast: it runs every frame at up to 1920×1080 next to 20 other nodes.
  ~64 raymarch steps or ~32 texture taps per pixel is the ceiling.

## Lights (`src/nodes/dmx.js`)

A node with a `process` may write to `ctx.dmx`, the frame's 512-byte universe, which the engine
clears before the control nodes run. Where two nodes claim a channel the higher value wins. An image node
with `cells: (p) => [columns, rows]` is always rendered, cable or no cable, and gets
that grid of its own picture in `state.picture` (a `tap.js` frame, a frame or two late), each pixel
the mean of the part of the picture under it. Its `process` runs as well.

## Control node definition (JavaScript, `src/nodes/control.js`)

```js
{
  type: 'lfo', title: 'LFO', category: 'control',
  description: 'Low-frequency oscillator',
  params: [...],                  // same param shapes; float params are patchable inputs
  outputs: [{ name: 'out', label: 'Out' }],
  process(ctx, p, state) {        // once per frame, in topological order
    return { out: ... };          // ctx: { time, dt, playing, audio, spectrum }
  },
}
```

A float param marked `raw: true` takes the cable value as-is (math nodes),
instead of base + cable × depth × range.

## Checking your work

`npm run check:shaders` compiles every image node in headless Chromium and
renders one frame of each; it prints compiler errors with line numbers
relative to the node body.
