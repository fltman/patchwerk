// Mix nodes: combine two or more images. See CONTRACT.md.
// Like `blend`, the upper layer's alpha is its coverage.

export default [
  {
    type: 'blend',
    title: 'Blend',
    category: 'mix',
    description: 'Layer one image over another with a blend mode',
    tags: ['layer', 'composite', 'add', 'screen', 'multiply', 'overlay'],
    inputs: [
      { name: 'base', label: 'Base' },
      { name: 'top', label: 'Top' },
    ],
    params: [
      { name: 'opacity', label: 'Opacity', min: 0, max: 1, default: 1 },
      {
        name: 'mode', label: 'Mode', type: 'select', default: 1,
        options: ['Normal', 'Add', 'Screen', 'Multiply', 'Overlay', 'Difference', 'Lighten', 'Darken'],
      },
    ],
    glsl: `
vec3 blendMode(vec3 a, vec3 b, int m) {
  if (m == 1) return a + b;
  if (m == 2) return 1.0 - (1.0 - a) * (1.0 - b);
  if (m == 3) return a * b;
  if (m == 4) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
  if (m == 5) return abs(a - b);
  if (m == 6) return max(a, b);
  if (m == 7) return min(a, b);
  return b;
}
vec4 render(vec2 uv) {
  vec4 a = texture(t_base, uv);
  vec4 b = texture(t_top, uv);
  // colours are premultiplied: un-premultiply the top so soft edges don't darken
  vec3 top = b.a > 1e-4 ? b.rgb / b.a : vec3(0.0);
  vec3 col = mix(a.rgb, blendMode(a.rgb, top, p_mode), b.a * p_opacity);
  return vec4(max(col, vec3(0.0)), max(a.a, b.a * p_opacity));
}`,
  },
  {
    type: 'crossfade',
    title: 'Crossfade',
    category: 'mix',
    description: 'Fade or wipe from A to B',
    tags: ['transition', 'fade', 'wipe', 'dissolve', 'cut', 'a/b'],
    inputs: [
      { name: 'a', label: 'A' },
      { name: 'b', label: 'B' },
    ],
    params: [
      { name: 'fade', label: 'Fade', min: 0, max: 1, default: 0.5 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Fade', 'Dip black', 'Wipe', 'Circle', 'Diamond', 'Blinds', 'Dissolve'], default: 0 },
      { name: 'softness', label: 'Softness', min: 0, max: 1, default: 0.1 },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0 },
      { name: 'bars', label: 'Bars', min: 2, max: 32, default: 8, step: 1 },
    ],
    glsl: `
// 0..1 per pixel: the fade value at which this pixel switches to B
float field(vec2 uv) {
  vec2 d = vec2(cos(p_angle), sin(p_angle));
  if (p_mode == 2) return dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
  if (p_mode == 3) return length(centered(uv)) / (0.5 * length(vec2(u_aspect, 1.0)));
  if (p_mode == 4) { vec2 p = abs(uv - 0.5) * 2.0; return (p.x + p.y) * 0.5; }
  if (p_mode == 5) return fract(dot(uv - 0.5, d) * floor(p_bars + 0.5));
  float n = 0.5 + 0.6 * snoise(vec3(centered(uv) * 4.0, 0.0)) + 0.25 * (hash12(floor(uv * u_res / 2.0)) - 0.5);
  return clamp(n, 0.0, 1.0);
}
vec4 render(vec2 uv) {
  vec4 a = texture(t_a, uv), b = texture(t_b, uv);
  if (p_mode == 1) {
    vec4 c = p_fade < 0.5 ? a : b;
    return vec4(max(c.rgb, 0.0) * abs(p_fade * 2.0 - 1.0), c.a);
  }
  float w = p_fade;
  if (p_mode > 1) {
    float s = max(p_softness, 1e-3);
    w = clamp((p_fade * (1.0 + s) - field(uv)) / s, 0.0, 1.0);
  }
  return max(mix(a, b, w), 0.0);
}`,
  },
  {
    type: 'mask',
    title: 'Mask',
    category: 'mix',
    description: 'Show B over A where a third image is bright',
    tags: ['matte', 'stencil', 'cutout', 'luma', 'alpha', 'track matte'],
    inputs: [
      { name: 'a', label: 'A' },
      { name: 'b', label: 'B' },
      { name: 'mask', label: 'Mask' },
    ],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 1 },
      { name: 'threshold', label: 'Threshold', min: 0, max: 1, default: 0.5 },
      { name: 'softness', label: 'Softness', min: 0, max: 1, default: 1 },
      { name: 'source', label: 'Mask from', type: 'select', options: ['Luma', 'Alpha'], default: 0 },
      { name: 'invert', label: 'Invert', type: 'select', options: ['Off', 'On'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 a = texture(t_a, uv), b = texture(t_b, uv), m = texture(t_mask, uv);
  float v = p_source == 1 ? m.a : luma(m.rgb);
  if (p_invert == 1) v = 1.0 - v;
  float h = max(p_softness, 1e-3) * 0.5;
  float k = smoothstep(p_threshold - h, p_threshold + h, v) * b.a * p_amount;
  return vec4(max(mix(a.rgb, b.rgb, k), 0.0), max(a.a, k));
}`,
  },
  {
    type: 'key',
    title: 'Key',
    category: 'mix',
    description: 'Put the bright (or dark, or non-green) parts of top over base',
    tags: ['luma key', 'chroma key', 'green screen', 'keying', 'layer', 'transparent'],
    inputs: [
      { name: 'base', label: 'Base' },
      { name: 'top', label: 'Top' },
    ],
    params: [
      { name: 'threshold', label: 'Threshold', min: 0, max: 1, default: 0.15 },
      { name: 'softness', label: 'Softness', min: 0, max: 0.5, default: 0.1 },
      { name: 'opacity', label: 'Opacity', min: 0, max: 1, default: 1 },
      { name: 'mode', label: 'Keep', type: 'select', options: ['Bright', 'Dark', 'Not color'], default: 0 },
      { name: 'color', label: 'Key color', type: 'color', default: '#00ff00' },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 base = texture(t_base, uv), top = texture(t_top, uv);
  float v;
  if (p_mode == 2) {
    // distance from the key colour, mostly in hue/saturation so shading keys out too
    vec3 c = top.rgb - luma(top.rgb), k = p_color - luma(p_color);
    v = length(c - k) * 1.2 + abs(luma(top.rgb) - luma(p_color)) * 0.3;
  } else {
    v = luma(top.rgb);
    if (p_mode == 1) v = 1.0 - v;
  }
  float k = smoothstep(p_threshold, p_threshold + p_softness + 1e-3, v) * top.a * p_opacity;
  return vec4(max(mix(base.rgb, top.rgb, k), 0.0), max(base.a, k));
}`,
  },
  {
    type: 'switch',
    title: 'Switch',
    category: 'mix',
    description: 'Pick one of four inputs by number',
    tags: ['select', 'sequencer', 'router', 'cut', 'channel', 'vj'],
    inputs: [
      { name: 'a', label: 'A' },
      { name: 'b', label: 'B' },
      { name: 'c', label: 'C' },
      { name: 'd', label: 'D' },
    ],
    params: [
      { name: 'index', label: 'Index', min: 0, max: 3, default: 0 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Cut', 'Fade', 'Slide'], default: 0 },
      { name: 'count', label: 'Inputs', type: 'select', options: ['2', '3', '4'], default: 2 },
    ],
    glsl: `
// sample every input (keeps texture derivatives well-defined), return input i
vec4 pick(float i, vec2 uv) {
  vec4 a = texture(t_a, uv), b = texture(t_b, uv), c = texture(t_c, uv), d = texture(t_d, uv);
  return i < 0.5 ? a : i < 1.5 ? b : i < 2.5 ? c : d;
}
vec4 render(vec2 uv) {
  float n = float(p_count + 2);
  float idx = clamp(p_index, 0.0, 3.0);
  if (p_mode == 0) return max(pick(mod(floor(idx + 0.5), n), uv), 0.0);
  float i0 = floor(idx), f = idx - i0;
  float ia = mod(i0, n), ib = mod(i0 + 1.0, n);
  if (p_mode == 1) return max(mix(pick(ia, uv), pick(ib, uv), f), 0.0);
  // slide: the next input pushes the current one out to the left
  vec4 cur = pick(ia, vec2(uv.x + f, uv.y));
  vec4 nxt = pick(ib, vec2(uv.x + f - 1.0, uv.y));
  return max(uv.x + f < 1.0 ? cur : nxt, 0.0);
}`,
  },
  {
    type: 'merge',
    title: 'Merge',
    category: 'mix',
    description: 'Add up to four images with their own gains',
    tags: ['add', 'sum', 'mixer', 'combine', 'screen', 'lighten'],
    inputs: [
      { name: 'a', label: 'A' },
      { name: 'b', label: 'B' },
      { name: 'c', label: 'C' },
      { name: 'd', label: 'D' },
    ],
    params: [
      { name: 'gainA', label: 'Gain A', min: 0, max: 2, default: 1 },
      { name: 'gainB', label: 'Gain B', min: 0, max: 2, default: 1 },
      { name: 'gainC', label: 'Gain C', min: 0, max: 2, default: 1 },
      { name: 'gainD', label: 'Gain D', min: 0, max: 2, default: 1 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Add', 'Screen', 'Lighten'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 a = max(texture(t_a, uv), 0.0) * p_gainA, b = max(texture(t_b, uv), 0.0) * p_gainB;
  vec4 c = max(texture(t_c, uv), 0.0) * p_gainC, d = max(texture(t_d, uv), 0.0) * p_gainD;
  vec3 col;
  if (p_mode == 1) {
    vec3 ia = 1.0 - min(a.rgb, 1.0), ib = 1.0 - min(b.rgb, 1.0), ic = 1.0 - min(c.rgb, 1.0), id = 1.0 - min(d.rgb, 1.0);
    col = 1.0 - ia * ib * ic * id;
  } else if (p_mode == 2) {
    col = max(max(a.rgb, b.rgb), max(c.rgb, d.rgb));
  } else {
    col = a.rgb + b.rgb + c.rgb + d.rgb;
  }
  return vec4(col, min(1.0, max(max(a.a, b.a), max(c.a, d.a))));
}`,
  },
  {
    type: 'video-wall',
    title: 'Video Wall',
    category: 'mix',
    description: 'A grid of screens, each showing one of the inputs',
    tags: ['grid', 'mosaic', 'split screen', 'multi', 'shuffle', 'tiles', 'vj'],
    inputs: [
      { name: 'a', label: 'A' },
      { name: 'b', label: 'B' },
      { name: 'c', label: 'C' },
      { name: 'd', label: 'D' },
    ],
    lod: true,
    params: [
      { name: 'cols', label: 'Columns', min: 1, max: 8, default: 3, step: 1 },
      { name: 'rows', label: 'Rows', min: 1, max: 8, default: 3, step: 1 },
      { name: 'shuffle', label: 'Shuffle', min: 0, max: 16, default: 0 },
      { name: 'rate', label: 'Rate', min: 0, max: 8, default: 0.5, integrate: true },
      { name: 'gap', label: 'Gap', min: 0, max: 0.2, default: 0.03 },
      { name: 'order', label: 'Order', type: 'select', options: ['Random', 'Ordered'], default: 0 },
      { name: 'view', label: 'View', type: 'select', options: ['Fit', 'Window'], default: 0 },
      { name: 'count', label: 'Inputs', type: 'select', options: ['2', '3', '4'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  float n = float(p_count + 2);
  vec2 grid = max(floor(vec2(p_cols, p_rows) + 0.5), 1.0);
  vec2 q = uv * grid;
  vec2 cell = floor(q);
  vec2 f = q - cell;
  float seed = floor(p_shuffle) + floor(p_rate_t);         // pattern changes on shuffle steps and at 'rate'
  float i = p_order == 1 ? mod(cell.x + (grid.y - 1.0 - cell.y) * grid.x + seed, n)
                         : floor(hash12(cell * 1.37 + seed * 7.31 + 0.5) * n);
  float inside = 1.0;
  if (p_gap > 0.0) {
    vec2 g = p_gap * 0.5 * vec2(1.0 / u_aspect, 1.0) * grid, w = grid / u_res;
    vec2 m = smoothstep(g - w, g + w, f) * (1.0 - smoothstep(1.0 - g - w, 1.0 - g + w, f));
    inside = m.x * m.y;
    f = clamp((f - g) / (1.0 - 2.0 * g), 0.0, 1.0);
  }
  vec2 s = p_view == 0 ? f : uv;
  float lod = p_view == 0 ? log2(max(grid.x, grid.y)) : 0.0;
  vec4 a = textureLod(t_a, s, lod), b = textureLod(t_b, s, lod), c = textureLod(t_c, s, lod), d = textureLod(t_d, s, lod);
  vec4 col = i < 0.5 ? a : i < 1.5 ? b : i < 2.5 ? c : d;
  return max(col, 0.0) * inside;
}`,
  },
];
