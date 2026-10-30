// Generator nodes: images from nothing (plus the global audio textures).
// See CONTRACT.md. Each entry is one fullscreen fragment pass.

// ── shared GLSL snippets (prepended to the bodies that use them) ──────────

// Colour ramps for "field" generators. All but Rainbow run black → brightest,
// so low values stay deep black.
const PALETTES = ['Neon', 'Acid', 'Fire', 'Ice', 'Sunset', 'Rainbow', 'Mono'];
const PALETTE_GLSL = `
vec3 ramp5(float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  vec3 c = mix(c0, c1, clamp(t, 0.0, 1.0));
  c = mix(c, c2, clamp(t - 1.0, 0.0, 1.0));
  c = mix(c, c3, clamp(t - 2.0, 0.0, 1.0));
  return mix(c, c4, clamp(t - 3.0, 0.0, 1.0));
}
// 0 Neon, 1 Acid, 2 Fire, 3 Ice, 4 Sunset, 5 Rainbow (hue wheel), 6 Mono
vec3 palette(float t, int k) {
  if (k == 0) return ramp5(t, vec3(0.0), vec3(0.18, 0.04, 0.42), vec3(0.97, 0.15, 0.52), vec3(0.30, 0.79, 0.94), vec3(1.0));
  if (k == 1) return ramp5(t, vec3(0.0), vec3(0.03, 0.18, 0.0), vec3(0.22, 1.0, 0.08), vec3(0.92, 1.0, 0.0), vec3(1.0));
  if (k == 2) return ramp5(t, vec3(0.0), vec3(0.38, 0.0, 0.0), vec3(1.0, 0.19, 0.0), vec3(1.0, 0.69, 0.0), vec3(1.0, 0.96, 0.82));
  if (k == 3) return ramp5(t, vec3(0.0), vec3(0.0, 0.08, 0.36), vec3(0.0, 0.38, 1.0), vec3(0.0, 0.9, 1.0), vec3(1.0));
  if (k == 4) return ramp5(t, vec3(0.0), vec3(0.24, 0.04, 0.42), vec3(1.0, 0.17, 0.43), vec3(1.0, 0.62, 0.0), vec3(1.0, 0.93, 0.53));
  if (k == 5) return hsv2rgb(vec3(fract(t), 0.9, 1.0));
  return vec3(clamp(t, 0.0, 1.0));
}
// triangle wave 0 → 1 → 0 (period 2): cycles a ramp without seams
float tri(float x) { return 1.0 - abs(1.0 - 2.0 * fract(x * 0.5)); }
`;

// Shape layers: colour over black, alpha = coverage (brightest channel).
const LAYER_GLSL = `
vec4 layer(vec3 c) { c = clamp(c, 0.0, 1.0); return vec4(c, max(c.r, max(c.g, c.b))); }
`;

// A "radius" whose iso-lines are circles or regular polygons.
const SHAPES = ['Circle', 'Square', 'Hexagon', 'Triangle'];
const POLY_GLSL = `
float polyRadius(vec2 p, int shape) {
  if (shape == 0) return length(p);
  float n = shape == 1 ? 4.0 : (shape == 2 ? 6.0 : 3.0);
  float a = atan(p.y, p.x + 1e-20) + (shape == 3 ? PI * 0.5 : 0.0);
  float seg = TAU / n;
  float phi = mod(a + seg * 0.5, seg) - seg * 0.5;
  return length(p) * cos(phi);
}
`;

export default [
  {
    type: 'solid',
    title: 'Solid',
    category: 'generator',
    description: 'A flat colour',
    tags: ['color', 'fill', 'background'],
    params: [
      { name: 'color', label: 'Color', type: 'color', default: '#ff2a6d' },
      { name: 'brightness', label: 'Brightness', min: 0, max: 2, default: 1 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  return vec4(p_color * p_brightness, 1.0);
}`,
  },
  {
    type: 'noise',
    title: 'Noise',
    category: 'generator',
    description: 'Animated fractal noise with domain warp',
    tags: ['fbm', 'clouds', 'smoke', 'simplex'],
    params: [
      { name: 'scale', label: 'Scale', min: 0.5, max: 20, default: 3 },
      { name: 'octaves', label: 'Octaves', min: 1, max: 8, default: 5, step: 1 },
      { name: 'warp', label: 'Warp', min: 0, max: 3, default: 0.8 },
      { name: 'speed', label: 'Speed', min: -2, max: 2, default: 0.2, integrate: true },
      { name: 'contrast', label: 'Contrast', min: 0.2, max: 4, default: 1.2 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = centered(uv) * p_scale;
  float t = p_speed_t;
  int oct = int(p_octaves);
  vec2 q = vec2(fbm(vec3(p, t), oct), fbm(vec3(p + 5.2, t), oct));
  float n = fbm(vec3(p + p_warp * q, t * 0.7), oct);
  float v = clamp(0.5 + 0.5 * n * p_contrast, 0.0, 1.0);
  return vec4(vec3(v), 1.0);
}`,
  },

  // ── fields & fills ──────────────────────────────────────────────────────
  {
    type: 'gradient',
    title: 'Gradient',
    category: 'generator',
    description: 'Two-colour linear, radial, angular or diamond ramp',
    tags: ['ramp', 'fade', 'radial', 'conic', 'background', 'sky'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Linear', 'Radial', 'Angular', 'Diamond'], default: 0 },
      { name: 'colorA', label: 'Color A', type: 'color', default: '#ff2a6d' },
      { name: 'colorB', label: 'Color B', type: 'color', default: '#120458' },
      { name: 'angle', label: 'Angle', min: -180, max: 180, default: 90 },
      { name: 'repeat', label: 'Repeat', min: 0.25, max: 16, default: 1 },
      { name: 'offset', label: 'Offset', min: -1, max: 1, default: 0 },
      { name: 'speed', label: 'Scroll', min: -2, max: 2, default: 0, integrate: true },
      { name: 'hardness', label: 'Hardness', min: 0, max: 1, default: 0 },
      { name: 'wave', label: 'Wave', type: 'select', options: ['Mirror', 'Saw'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float t;
  if (p_mode == 0) {
    float ext = 0.5 * (abs(dir.x) * u_aspect + abs(dir.y));
    t = 0.5 + 0.5 * dot(p, dir) / ext;
  } else if (p_mode == 1) {
    t = length(p) / (0.5 * length(vec2(u_aspect, 1.0)));
  } else if (p_mode == 2) {
    t = abs(fract((atan(p.y, p.x + 1e-20) - a) / TAU + 0.5) * 2.0 - 1.0);
  } else {
    vec2 q = rot2(a) * p;
    t = (abs(q.x) + abs(q.y)) / (0.5 * (u_aspect + 1.0));
  }
  float s = t * p_repeat + p_offset + p_speed_t;
  float f = p_wave == 0 ? 1.0 - abs(1.0 - 2.0 * fract(s * 0.5)) : fract(s);
  float w = max(0.5 * (1.0 - p_hardness), fwidth(s)) + 1e-4;
  f = smoothstep(0.5 - w, 0.5 + w, f);
  return vec4(clamp(mix(p_colorA, p_colorB, f), 0.0, 1.0), 1.0);
}`,
  },
  {
    type: 'plasma',
    title: 'Plasma',
    category: 'generator',
    description: 'Classic demoscene sine plasma through a colour palette',
    tags: ['demoscene', 'psychedelic', 'sine', 'retro', 'palette'],
    params: [
      { name: 'scale', label: 'Scale', min: 0.5, max: 12, default: 3 },
      { name: 'speed', label: 'Speed', min: -2, max: 2, default: 0.4, integrate: true },
      { name: 'warp', label: 'Warp', min: 0, max: 2, default: 0.6 },
      { name: 'bands', label: 'Bands', min: 0.5, max: 8, default: 2 },
      { name: 'shift', label: 'Shift', min: 0, max: 2, default: 0 },
      { name: 'contrast', label: 'Contrast', min: 0.3, max: 4, default: 1.3 },
      { name: 'palette', label: 'Palette', type: 'select', options: PALETTES, default: 0 },
    ],
    glsl: PALETTE_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = centered(uv) * p_scale;
  float t = p_speed_t;
  p += p_warp * vec2(sin(p.y * 1.7 + t * 0.9), cos(p.x * 1.3 - t * 0.7));
  float v = sin(p.x + t);
  v += sin(0.6 * (p.y - t * 0.8));
  v += sin(0.5 * (p.x + p.y) + t * 1.3);
  vec2 c = p + 2.0 * vec2(sin(t * 0.33), cos(t * 0.5));
  v += sin(sqrt(dot(c, c) + 1.0) * 1.5 - t);
  float f = (v * 0.125 + 0.5) * p_bands + p_shift;
  float k = pow(tri(f), p_contrast);
  return vec4(clamp(palette(k, p_palette), 0.0, 1.0), 1.0);
}`,
  },
  {
    type: 'voronoi',
    title: 'Voronoi',
    category: 'generator',
    description: 'Moving cell field: distance, edges, cells or crackle (greyscale)',
    tags: ['cells', 'worley', 'cellular', 'crackle', 'organic', 'field'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Distance', 'Edges', 'Cells', 'Crackle'], default: 1 },
      { name: 'scale', label: 'Scale', min: 1, max: 30, default: 6 },
      { name: 'speed', label: 'Speed', min: -2, max: 2, default: 0.4, integrate: true },
      { name: 'jitter', label: 'Jitter', min: 0, max: 1, default: 0.9 },
      { name: 'width', label: 'Edge Width', min: 0.005, max: 0.4, default: 0.04 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.35 },
    ],
    glsl: `
vec2 cellPoint(vec2 id, float t) {
  vec2 h = hash22(id);
  return 0.5 + 0.5 * p_jitter * sin(t * (0.5 + h.yx) + TAU * h);
}
vec4 render(vec2 uv) {
  vec2 x = centered(uv) * p_scale + 31.7;
  float t = p_speed_t;
  vec2 n = floor(x), f = fract(x);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + cellPoint(n + g, t) - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  // exact distance to the cell border (5x5 around the nearest cell, so full jitter has no breaks)
  float be = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 r = g + cellPoint(n + g, t) - f;
      vec2 dr = r - mr;
      if (dot(dr, dr) > 1e-5) be = min(be, dot(0.5 * (mr + r), normalize(dr)));
    }
  }
  float pxs = p_scale / u_res.y;
  float w = p_width * 0.5;
  float v;
  if (p_mode == 0) {
    v = sqrt(md) * 1.3;
  } else if (p_mode == 1) {
    float line = 1.0 - smoothstep(w - pxs, w + pxs, be);
    v = max(line, p_glow * exp(-max(be - w, 0.0) * 14.0));
  } else if (p_mode == 2) {
    v = (0.12 + 0.88 * hash12(n + mg + 71.3)) * smoothstep(w - pxs, w + pxs, be);
  } else {
    v = be * 5.0;   // crackle: plateaus with dark seams (exact border distance, F2 is unreliable in 3x3)
  }
  return vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,
  },
  {
    type: 'stripes',
    title: 'Stripes',
    category: 'generator',
    description: 'Scrolling bars in two alternating colours at any angle',
    tags: ['lines', 'bars', 'zebra', 'pattern', 'scroll'],
    params: [
      { name: 'angle', label: 'Angle', min: -180, max: 180, default: 45 },
      { name: 'count', label: 'Count', min: 1, max: 64, default: 10 },
      { name: 'width', label: 'Width', min: 0, max: 1, default: 0.5 },
      { name: 'soft', label: 'Softness', min: 0, max: 1, default: 0 },
      { name: 'speed', label: 'Scroll', min: -4, max: 4, default: 0.4, integrate: true },
      { name: 'bend', label: 'Bend', min: 0, max: 1, default: 0 },
      { name: 'colorA', label: 'Color A', type: 'color', default: '#ff2a6d' },
      { name: 'colorB', label: 'Color B', type: 'color', default: '#05d9e8' },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = rot2(radians(p_angle)) * centered(uv);
  float s = p.y * p_count + p_speed_t + p_bend * 1.5 * sin(p.x * 5.0 + p_speed_t * 0.5);
  float fw = fwidth(s) * 2.0 + 1e-4;
  float idx = floor(s);
  float d = abs(fract(s) - 0.5) * 2.0;  // 0 at stripe centre, 1 at the gap centre
  float m = 1.0 - smoothstep(p_width - p_soft - fw, p_width + fw, d);
  m *= smoothstep(0.0, 0.02, p_width);
  vec3 c = mod(idx, 2.0) < 0.5 ? p_colorA : p_colorB;
  return vec4(clamp(c * m, 0.0, 1.0), clamp(m, 0.0, 1.0));
}`,
  },
  {
    type: 'checker',
    title: 'Checker',
    category: 'generator',
    description: 'Checkerboard, grid lines or dot matrix; spin, scroll, bulge',
    tags: ['grid', 'dots', 'chess', 'pattern', 'tiles', 'halftone'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Checker', 'Grid', 'Dots'], default: 0 },
      { name: 'scale', label: 'Scale', min: 1, max: 48, default: 8 },
      { name: 'width', label: 'Width', min: 0, max: 1, default: 0.15 },
      { name: 'angle', label: 'Angle', min: -180, max: 180, default: 0 },
      { name: 'spin', label: 'Spin', min: -1, max: 1, default: 0, integrate: true },
      { name: 'scroll', label: 'Scroll', min: -4, max: 4, default: 0, integrate: true },
      { name: 'bulge', label: 'Bulge', min: -0.8, max: 2, default: 0 },
      { name: 'colorA', label: 'Color A', type: 'color', default: '#ffffff' },
      { name: 'colorB', label: 'Color B', type: 'color', default: '#000000' },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  p *= max(1.0 + p_bulge * dot(p, p), 0.05);
  p = rot2(radians(p_angle) + p_spin_t) * p;
  vec2 q = p * p_scale + vec2(0.0, p_scroll_t);
  vec2 fw = fwidth(q) + 1e-4;
  vec2 f = fract(q) - 0.5;
  if (p_mode == 0) {
    vec2 s = clamp((abs(f) - 0.25) / fw, -1.0, 1.0);
    float chk = 0.5 + 0.5 * s.x * s.y;
    return vec4(clamp(mix(p_colorA, p_colorB, chk), 0.0, 1.0), 1.0);
  }
  float m;
  if (p_mode == 1) {
    vec2 e = 0.5 - abs(f);
    float w = p_width * 0.25;
    vec2 l = 1.0 - smoothstep(w - fw, w + fw, e);
    m = max(l.x, l.y) * smoothstep(0.0, 0.02, p_width);
  } else {
    float fr = 0.5 * (fw.x + fw.y);
    m = 1.0 - smoothstep(-fr, fr, length(f) - p_width * 0.5);
  }
  return vec4(clamp(p_colorA * m, 0.0, 1.0), clamp(m, 0.0, 1.0));
}`,
  },
  {
    type: 'truchet',
    title: 'Truchet',
    category: 'generator',
    description: 'Flipping arc, maze or hex tiles with flowing dashes',
    tags: ['tiles', 'maze', 'hex', 'pattern', '10print', 'pipes'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Arcs', 'Maze', 'Hex'], default: 0 },
      { name: 'scale', label: 'Scale', min: 2, max: 40, default: 8 },
      { name: 'width', label: 'Width', min: 0.01, max: 0.6, default: 0.12 },
      { name: 'speed', label: 'Scroll', min: -2, max: 2, default: 0.2, integrate: true },
      { name: 'flip', label: 'Flip Rate', min: 0, max: 4, default: 0.3, integrate: true },
      { name: 'dash', label: 'Dash', min: 0, max: 1, default: 0 },
      { name: 'flow', label: 'Flow', min: -4, max: 4, default: 1, integrate: true },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.4 },
      { name: 'colorA', label: 'Color A', type: 'color', default: '#05d9e8' },
      { name: 'colorB', label: 'Color B', type: 'color', default: '#ff2a6d' },
    ],
    glsl: LAYER_GLSL + `
vec4 render(vec2 uv) {
  vec2 q = centered(uv) * p_scale + vec2(0.3, 1.0) * p_speed_t + 17.0;
  float d, s;  // distance to the line, position along it
  if (p_mode == 2) {
    vec2 r = vec2(1.0, 1.7320508), h = 0.5 * r;
    vec2 a = mod(q, r) - h, b = mod(q - h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    vec2 id = q - gv;
    float epoch = floor(p_flip_t + hash12(id) * 7.0);
    if (hash12(id + epoch * 13.37) > 0.5) gv = rot2(PI / 3.0) * gv;
    d = 1e3; s = 0.0;
    for (int k = 0; k < 3; k++) {
      float va = PI / 6.0 + float(k) * TAU / 3.0;
      vec2 c = gv - 0.57735 * vec2(cos(va), sin(va));
      float dk = abs(length(c) - 0.288675);
      if (dk < d) { d = dk; s = atan(c.y, c.x + 1e-20) / (TAU / 3.0) * 2.0; }
    }
  } else {
    vec2 g = floor(q);
    vec2 f = fract(q) - 0.5;
    float epoch = floor(p_flip_t + hash12(g) * 7.0);
    float fl = hash12(g + epoch * 13.37) > 0.5 ? -1.0 : 1.0;
    f.x *= fl;
    float par = mod(g.x + g.y, 2.0) * 2.0 - 1.0;
    if (p_mode == 0) {
      vec2 c1 = f - 0.5, c2 = f + 0.5;
      float l1 = length(c1), l2 = length(c2);
      vec2 c = l1 < l2 ? c1 : c2;
      d = abs(min(l1, l2) - 0.5);
      s = atan(c.y, c.x + 1e-20) / (PI * 0.5) * 2.0 * par * fl * (l1 < l2 ? 1.0 : -1.0);
    } else {
      d = abs(f.x + f.y) * 0.70711;
      s = (f.x - f.y) * 1.41421 * par * fl;
    }
  }
  float pxs = p_scale / u_res.y;
  float w = p_width * 0.5;
  float m = 1.0 - smoothstep(w - pxs, w + pxs, d);
  if (p_dash > 0.0) {
    float ds = fract(s + p_flow_t);
    m *= smoothstep(p_dash - 0.04, p_dash + 0.04, ds) * (1.0 - smoothstep(0.96, 1.0, ds));
  }
  float g = p_glow * exp(-max(d - w, 0.0) * 10.0) * 0.6;
  vec3 c = mix(p_colorA, p_colorB, smoothstep(0.1, 0.9, uv.x * 0.7 + uv.y * 0.3));
  return layer(c * (m + g * (1.0 - m)) + vec3(0.25 * m));
}`,
  },

  // ── shapes & geometry (alpha = coverage) ────────────────────────────────
  {
    type: 'polygon',
    title: 'Polygon',
    category: 'generator',
    description: 'Glowing n-sided shape, stroke or fill, with nested echoes',
    tags: ['triangle', 'hexagon', 'shape', 'sdf', 'outline', 'neon'],
    params: [
      { name: 'sides', label: 'Sides', min: 3, max: 12, default: 3, step: 1 },
      { name: 'size', label: 'Size', min: 0.02, max: 0.6, default: 0.28 },
      { name: 'angle', label: 'Angle', min: -180, max: 180, default: 0 },
      { name: 'spin', label: 'Spin', min: -2, max: 2, default: 0.1, integrate: true },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Stroke', 'Fill', 'Both'], default: 0 },
      { name: 'width', label: 'Width', min: 0.002, max: 0.1, default: 0.012 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
      { name: 'echoes', label: 'Echoes', min: 1, max: 8, default: 1, step: 1 },
      { name: 'twist', label: 'Echo Twist', min: -180, max: 180, default: 0 },
      { name: 'color', label: 'Color', type: 'color', default: '#00f0ff' },
      { name: 'color2', label: 'Echo Color', type: 'color', default: '#ff2a6d' },
    ],
    glsl: LAYER_GLSL + `
float sdPoly(vec2 p, float r, float n) {
  float an = PI / n;
  vec2 acs = vec2(cos(an), sin(an));
  float bn = mod(atan(p.x, p.y + 1e-20), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p.y += clamp(-p.y, 0.0, r * acs.y);
  return length(p) * sign(p.x);
}
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float n = floor(p_sides + 0.5);
  int echoes = int(p_echoes + 0.5);
  float hw = p_width * 0.5;
  float gw = 0.006 + 0.05 * p_glow;
  vec3 col = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    if (k >= echoes) break;
    float fk = float(k);
    float sz = p_size * pow(0.72, fk);
    vec2 q = rot2(radians(p_angle + fk * p_twist) + p_spin_t) * p;
    float d = sdPoly(q, sz, n);
    float stroke = fillSd(abs(d) - hw);
    float m, e;
    if (p_mode == 0) { m = stroke; e = max(abs(d) - hw, 0.0); }
    else if (p_mode == 1) { m = fillSd(d); e = max(d, 0.0); }
    else { m = max(stroke, 0.35 / float(echoes) * fillSd(d)); e = max(abs(d) - hw, 0.0); }
    float g = p_glow * exp(-e / gw) * 0.9;
    vec3 c = mix(p_color, p_color2, echoes > 1 ? fk / float(echoes - 1) : 0.0);
    col += (c * (m + g) + vec3(0.3 * stroke * step(0.5, float(p_mode != 1)))) * (1.0 - 0.5 * fk / float(echoes));
  }
  return layer(col);
}`,
  },
  {
    type: 'rings',
    title: 'Rings',
    category: 'generator',
    description: 'Concentric rings rippling outward; patch a kick into Pulse',
    tags: ['circles', 'ripple', 'concentric', 'pulse', 'kick', 'shockwave'],
    params: [
      { name: 'count', label: 'Count', min: 1, max: 32, default: 10 },
      { name: 'radius', label: 'Radius', min: 0, max: 0.5, default: 0.05 },
      { name: 'spacing', label: 'Spacing', min: 0.01, max: 0.25, default: 0.05 },
      { name: 'pulse', label: 'Pulse', min: 0, max: 1, default: 0 },
      { name: 'speed', label: 'Speed', min: -2, max: 2, default: 0.5, integrate: true },
      { name: 'width', label: 'Width', min: 0.002, max: 0.08, default: 0.008 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.45 },
      { name: 'shape', label: 'Shape', type: 'select', options: SHAPES, default: 0 },
      { name: 'colorA', label: 'Inner', type: 'color', default: '#ff2a6d' },
      { name: 'colorB', label: 'Outer', type: 'color', default: '#05d9e8' },
    ],
    glsl: LAYER_GLSL + POLY_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float px = 1.0 / u_res.y;
  float r = polyRadius(p, p_shape);
  float spacing = p_spacing * (1.0 + 0.5 * p_pulse);
  float r0 = p_radius * (1.0 + p_pulse) + 0.08 * p_pulse;
  float pos = (r - r0) / spacing;               // ring slot, 0 = inner radius
  float s = pos - p_speed_t;
  float d = abs(fract(s + 0.5) - 0.5) * spacing; // radial distance to the nearest ring
  float w = p_width * (1.0 + 1.5 * p_pulse) * 0.5;
  float core = 1.0 - smoothstep(w - px, w + px, d);
  float glow = p_glow * exp(-max(d - w, 0.0) / (0.004 + 0.03 * p_glow)) * 0.6;
  float fade = smoothstep(-0.5, 0.6, pos) * (1.0 - smoothstep(p_count - 1.5, p_count, pos));
  vec3 c = mix(p_colorA, p_colorB, clamp(pos / max(p_count, 1.0), 0.0, 1.0));
  vec3 col = (c * (core + glow) + vec3(0.25 * core)) * fade * (0.75 + 0.5 * p_pulse);
  col += p_colorA * p_pulse * 0.5 * (1.0 - smoothstep(0.0, r0 + 0.02, r));
  return layer(col);
}`,
  },
  {
    type: 'tunnel',
    title: 'Tunnel',
    category: 'generator',
    description: 'Neon tunnel fly-through: rings, grid or checker walls',
    tags: ['wormhole', 'flythrough', 'polar', 'warp', '3d', 'rave'],
    params: [
      { name: 'texture', label: 'Walls', type: 'select', options: ['Rings', 'Grid', 'Checker'], default: 1 },
      { name: 'shape', label: 'Shape', type: 'select', options: SHAPES, default: 0 },
      { name: 'speed', label: 'Speed', min: -4, max: 4, default: 0.6, integrate: true },
      { name: 'spin', label: 'Spin', min: -2, max: 2, default: 0, integrate: true },
      { name: 'twist', label: 'Twist', min: -4, max: 4, default: 0 },
      { name: 'density', label: 'Density', min: 0.5, max: 8, default: 2 },
      { name: 'segments', label: 'Segments', min: 2, max: 32, default: 12, step: 1 },
      { name: 'width', label: 'Width', min: 0.01, max: 0.5, default: 0.08 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
      { name: 'fog', label: 'Fog', min: 0, max: 3, default: 1 },
      { name: 'colorA', label: 'Color A', type: 'color', default: '#ff2a6d' },
      { name: 'colorB', label: 'Color B', type: 'color', default: '#05d9e8' },
    ],
    glsl: LAYER_GLSL + POLY_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = rot2(p_spin_t) * centered(uv);
  float len = max(length(p), 1e-3);
  float r = max(polyRadius(p, p_shape), 1e-3);
  float segs = floor(p_segments + 0.5);
  float z = 0.3 / r;                                    // depth along the tunnel
  float zv = z * p_density + p_speed_t;                 // rings
  float av = (atan(p.y, p.x + 1e-20) / TAU + z * p_twist * 0.1) * segs;  // around
  // analytic pixel footprints (no seam at the atan wrap)
  float pxl = 1.0 / u_res.y;
  float fwZ = 0.3 * p_density / (r * r) * pxl + 1e-4;
  float fwA = (segs / (TAU * len) + abs(p_twist) * 0.03 * segs / (r * r)) * pxl + 1e-4;
  float w = p_width * 0.5;
  float dR = abs(fract(zv + 0.5) - 0.5);
  float dA = abs(fract(av + 0.5) - 0.5);
  float lR = mix(1.0 - smoothstep(w - fwZ, w + fwZ, dR), 2.0 * w, smoothstep(0.2, 0.8, fwZ));
  float lA = mix(1.0 - smoothstep(w - fwA, w + fwA, dA), 2.0 * w, smoothstep(0.2, 0.8, fwA));
  float gR = p_glow * exp(-max(dR - w, 0.0) / 0.07) * 0.5;
  float gA = p_glow * exp(-max(dA - w, 0.0) / 0.07) * 0.5;
  vec3 col;
  if (p_texture == 0) {
    float ring = floor(zv + 0.5);
    col = mix(p_colorA, p_colorB, mod(ring, 2.0)) * (lR + gR) + vec3(0.3 * lR);
  } else if (p_texture == 1) {
    col = p_colorA * (lR + gR) + p_colorB * (lA + gA) + vec3(0.3 * max(lR, lA));
  } else {
    float cz = clamp((abs(fract(zv) - 0.5) - 0.25) / fwZ, -1.0, 1.0);
    float ca = clamp((abs(fract(av) - 0.5) - 0.25) / fwA, -1.0, 1.0);
    col = mix(p_colorA, p_colorB, 0.5 + 0.5 * cz * ca);
  }
  float fade = exp(-z * p_fog * 0.4) * smoothstep(0.0, 0.03, len);
  return layer(col * fade);
}`,
  },
  {
    type: 'metaballs',
    title: 'Metaballs',
    category: 'generator',
    description: 'Gooey blobs that drift, merge and split',
    tags: ['blobs', 'lava', 'goo', 'liquid', 'organic'],
    params: [
      { name: 'count', label: 'Count', min: 2, max: 12, default: 6, step: 1 },
      { name: 'size', label: 'Size', min: 0.02, max: 0.3, default: 0.09 },
      { name: 'goo', label: 'Goo', min: 0, max: 1, default: 0.6 },
      { name: 'speed', label: 'Speed', min: -2, max: 2, default: 0.4, integrate: true },
      { name: 'spread', label: 'Spread', min: 0, max: 1.5, default: 1 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Fill', 'Outline'], default: 0 },
      { name: 'width', label: 'Width', min: 0.002, max: 0.04, default: 0.008 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
      { name: 'colorA', label: 'Core', type: 'color', default: '#ff2a6d' },
      { name: 'colorB', label: 'Edge', type: 'color', default: '#7b2cff' },
    ],
    glsl: LAYER_GLSL + `
vec2 ballPos(float i, float t) {
  vec4 h = vec4(hash12(vec2(i, 1.3)), hash12(vec2(i, 7.1)), hash12(vec2(i, 3.7)), hash12(vec2(i, 9.2)));
  return vec2(u_aspect * 0.36 * sin(t * (0.4 + 0.6 * h.x) + TAU * h.y), 0.34 * sin(t * (0.3 + 0.6 * h.z) + TAU * h.w));
}
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  int n = int(p_count + 0.5);
  float k = p_goo * 0.15 + 1e-3;
  float d = 1e3;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    float fi = float(i);
    float rad = p_size * (0.6 + 0.8 * hash11(fi * 3.17 + 0.5));
    d = smin(d, length(p - ballPos(fi, p_speed_t) * p_spread) - rad, k);
  }
  float gw = 0.01 + 0.06 * p_glow;
  vec3 col;
  if (p_mode == 0) {
    float m = fillSd(d);
    float depth = clamp(-d / (p_size + 1e-3), 0.0, 1.0);
    vec3 fillc = mix(p_colorB, p_colorA, sqrt(depth));
    float rim = fillSd(abs(d) - 0.003) * 0.5;
    col = fillc * m + vec3(rim) + p_colorB * p_glow * exp(-max(d, 0.0) / gw) * (1.0 - m);
  } else {
    float m = fillSd(abs(d) - p_width * 0.5);
    col = p_colorA * m + vec3(0.3 * m) + p_colorB * p_glow * exp(-abs(d) / gw) * (1.0 - m);
  }
  return layer(col);
}`,
  },
  {
    type: 'shape-3d',
    title: '3D Shape',
    category: 'generator',
    description: 'Raymarched spinning solid with iridescent fresnel shading',
    tags: ['raymarch', 'sdf', '3d', 'sphere', 'cube', 'torus', 'octahedron', 'chrome'],
    params: [
      { name: 'shape', label: 'Shape', type: 'select', options: ['Sphere', 'Box', 'Torus', 'Octahedron', 'Cross'], default: 2 },
      { name: 'size', label: 'Size', min: 0.2, max: 1.2, default: 0.75 },
      { name: 'spinX', label: 'Spin X', min: -2, max: 2, default: 0.3, integrate: true },
      { name: 'spinY', label: 'Spin Y', min: -2, max: 2, default: 0.5, integrate: true },
      { name: 'twist', label: 'Twist', min: -3, max: 3, default: 0 },
      { name: 'displace', label: 'Displace', min: 0, max: 1, default: 0 },
      { name: 'irid', label: 'Iridescence', min: 0, max: 1, default: 0.7 },
      { name: 'rim', label: 'Rim Glow', min: 0, max: 1, default: 0.6 },
      { name: 'color', label: 'Color', type: 'color', default: '#7b2cff' },
      { name: 'rimColor', label: 'Rim Color', type: 'color', default: '#05d9e8' },
    ],
    glsl: LAYER_GLSL + `
float sdShape(vec3 p) {
  float s = p_size;
  if (p_shape == 0) return length(p) - s;
  if (p_shape == 1) {
    vec3 q = abs(p) - vec3(s * 0.66);
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - s * 0.05;
  }
  if (p_shape == 2) return length(vec2(length(p.xz) - s * 0.75, p.y)) - s * 0.28;
  if (p_shape == 3) { vec3 q = abs(p); return (q.x + q.y + q.z - s * 1.25) * 0.57735; }
  vec3 q = abs(p);
  float t = s * 0.24;
  float bx = max(q.x - s, max(q.y, q.z) - t);
  float by = max(q.y - s, max(q.x, q.z) - t);
  float bz = max(q.z - s, max(q.x, q.y) - t);
  return min(bx, min(by, bz));
}
float map(vec3 p) {
  p.yz = rot2(p_spinX_t) * p.yz;
  p.xz = rot2(p_spinY_t) * p.xz;
  p.xz = rot2(p.y * p_twist) * p.xz;
  float d = sdShape(p);
  float tt = u_time * 1.3;
  d += p_displace * 0.1 * sin(6.0 * p.x + tt) * sin(6.0 * p.y + tt * 0.8) * sin(6.0 * p.z + tt * 0.6);
  return d;
}
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  vec3 ro = vec3(0.0, 0.0, 3.2);
  vec3 rd = normalize(vec3(p, -1.6));
  float R = p_size * 1.4 + p_displace * 0.12 + 0.05;
  float b = dot(ro, rd);
  float h = b * b - (dot(ro, ro) - R * R);
  if (h < 0.0) return vec4(0.0);
  float sh = sqrt(h);
  float t = max(-b - sh, 0.0), tmax = -b + sh;
  float stepk = 0.8 / (1.0 + 0.35 * abs(p_twist) + 0.6 * p_displace);
  float minD = 1e3;
  bool hit = false;
  for (int i = 0; i < 64; i++) {
    float d = map(ro + rd * t);
    minD = min(minD, d);
    if (d < 0.0015 * t) { hit = true; break; }
    t += d * stepk;
    if (t > tmax) break;
  }
  if (!hit) return layer(p_rimColor * p_rim * 0.6 * exp(-max(minD, 0.0) * 30.0));
  vec3 pos = ro + rd * t;
  const vec2 e = vec2(1.0, -1.0) * 0.0015;
  vec3 n = normalize(e.xyy * map(pos + e.xyy) + e.yyx * map(pos + e.yyx) + e.yxy * map(pos + e.yxy) + e.xxx * map(pos + e.xxx));
  float ndv = clamp(dot(n, -rd), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.0);
  vec3 l = normalize(vec3(0.6, 0.8, 0.5));
  float dif = clamp(dot(n, l), 0.0, 1.0) + 0.35 * clamp(dot(n, normalize(vec3(-0.7, -0.3, 0.6))), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(rd, n), l), 0.0, 1.0), 32.0);
  // thin-film-ish hue: view angle + normal + a world-space sheen so flat faces still shimmer
  vec3 irid = 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.67) + 1.4 * (1.0 - ndv) + dot(n, vec3(0.3, 0.5, 0.2)) + 0.9 * dot(pos, vec3(0.4, 0.7, -0.3))));
  vec3 base = p_color * (0.12 + 0.88 * dif);
  vec3 col = mix(base, irid * (0.25 + 0.75 * dif + 0.4 * fres), p_irid);
  col += p_rimColor * fres * p_rim * 1.5 + vec3(spec * 0.7);
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
  },

  // ── light & motion (alpha = coverage) ───────────────────────────────────
  {
    type: 'lasers',
    title: 'Lasers',
    category: 'generator',
    description: 'A fan of thin glowing beams that sweep, scissor or spin',
    tags: ['beams', 'laser show', 'light', 'rave', 'club', 'fan'],
    params: [
      { name: 'mode', label: 'Motion', type: 'select', options: ['Fan', 'Scissor', 'Spin'], default: 0 },
      { name: 'count', label: 'Count', min: 1, max: 32, default: 12, step: 1 },
      { name: 'spread', label: 'Spread', min: 0, max: 360, default: 80 },
      { name: 'aim', label: 'Aim', min: -180, max: 180, default: 90 },
      { name: 'swing', label: 'Swing', min: 0, max: 90, default: 25 },
      { name: 'sweep', label: 'Sweep Rate', min: -4, max: 4, default: 1, integrate: true },
      { name: 'x', label: 'Origin X', min: 0, max: 1, default: 0.5 },
      { name: 'y', label: 'Origin Y', min: 0, max: 1, default: 0 },
      { name: 'width', label: 'Width', min: 0.0005, max: 0.02, default: 0.003 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
      { name: 'fade', label: 'Fade', min: 0, max: 1, default: 0.3 },
      { name: 'flicker', label: 'Flicker', min: 0, max: 1, default: 0 },
      { name: 'colorA', label: 'Color A', type: 'color', default: '#00ff6a' },
      { name: 'colorB', label: 'Color B', type: 'color', default: '#ff2a6d' },
    ],
    glsl: LAYER_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  vec2 v = p - vec2((p_x - 0.5) * u_aspect, p_y - 0.5);
  float px = 1.0 / u_res.y;
  int n = int(p_count + 0.5);
  float sw = sin(p_sweep_t);
  float tick = floor(u_time * 12.0);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= n) break;
    float fi = float(i);
    if (hash12(vec2(fi, tick)) < p_flicker) continue;
    float k = n > 1 ? fi / float(n - 1) - 0.5 : 0.0;
    float alt = mod(fi, 2.0) * 2.0 - 1.0;
    float a = p_aim + k * p_spread;
    if (p_mode == 0) a += p_swing * sw;
    else if (p_mode == 1) a += p_swing * sw * alt;
    else a += degrees(p_sweep_t) * 0.5;
    a = radians(a);
    vec2 dir = vec2(cos(a), sin(a));
    float along = dot(v, dir);
    float d = along > 0.0 ? abs(dir.x * v.y - dir.y * v.x) : length(v);
    float w = p_width * (1.0 + max(along, 0.0) * 1.5) * 0.5 + 0.35 * px;
    float core = 1.0 - smoothstep(w, w + 1.5 * px, d);
    float glow = p_glow * exp(-d / (w * 6.0 + 0.012 * p_glow + 1e-4)) * 0.5;
    float fade = exp(-max(along, 0.0) * p_fade * 3.0);
    vec3 c = alt < 0.0 ? p_colorA : p_colorB;
    col += (c * (core + glow) + vec3(0.35 * core)) * fade;
  }
  col += mix(p_colorA, p_colorB, 0.5) * p_glow * exp(-length(v) / 0.025) * 0.8;
  return layer(col);
}`,
  },
  {
    type: 'starfield',
    title: 'Starfield',
    category: 'generator',
    description: 'Warp-speed stars streaking out of the centre',
    tags: ['stars', 'space', 'warp', 'hyperspace', 'particles'],
    params: [
      { name: 'speed', label: 'Speed', min: -4, max: 4, default: 1, integrate: true },
      { name: 'density', label: 'Density', min: 0, max: 1, default: 0.6 },
      { name: 'streak', label: 'Streak', min: 0, max: 1, default: 0.5 },
      { name: 'size', label: 'Size', min: 0.3, max: 4, default: 1.2 },
      { name: 'hue', label: 'Colorize', min: 0, max: 1, default: 0.25 },
      { name: 'color', label: 'Tint', type: 'color', default: '#ffffff' },
    ],
    glsl: LAYER_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float ang = atan(p.y, p.x + 1e-20);
  float px = 1.0 / u_res.y;
  vec3 col = vec3(0.0);
  for (int l = 0; l < 5; l++) {
    float fl = float(l);
    float S = floor(mix(30.0, 160.0, p_density) * (1.0 + 0.31 * fl));
    float rot = fl * 1.37;
    float id0 = floor(mod(ang + rot, TAU) / TAU * S);
    for (int k = -1; k <= 1; k++) {
      float id = id0 + float(k);
      vec3 h = hash32(vec2(mod(id, S), fl * 17.0 + 3.0));
      float as = (id + 0.2 + 0.6 * h.x) / S * TAU - rot;
      vec2 dir = vec2(cos(as), sin(as));
      float rate = 0.15 + 0.1 * h.z;
      float zz = mix(1.0, 0.03, fract(h.y + p_speed_t * rate));   // depth, 1 far → 0.03 near
      float zt = clamp(zz + 0.97 * rate * p_speed * p_streak * 0.6, 0.02, 1.2);
      float R = 0.03 + 0.05 * h.z;
      float rs = R / zz, rt = R / zt;
      float along = dot(p, dir);
      float perp = abs(dir.x * p.y - dir.y * p.x);
      float dl = max(max(min(rs, rt) - along, along - max(rs, rt)), 0.0);
      float d = length(vec2(perp, dl));
      float w = p_size * px * (0.5 + 1.6 * (1.0 - zz));
      float core = 1.0 - smoothstep(w * 0.5, w * 0.5 + px, d);
      float glow = exp(-d / (w * 2.0 + 1e-4)) * 0.4;
      float b = smoothstep(0.0, 0.25, 1.0 - zz) * (0.35 + 0.65 * (1.0 - zz));
      vec3 sc = mix(vec3(1.0), hsv2rgb(vec3(h.z * 0.7 + 0.5, 0.75, 1.0)), p_hue);
      col += sc * (core + glow) * b;
    }
  }
  return layer(col * p_color);
}`,
  },
  {
    type: 'sparks',
    title: 'Sparks',
    category: 'generator',
    description: 'Radial spark bursts or rising embers; patch a kick into Amount',
    tags: ['particles', 'embers', 'fireworks', 'burst', 'fire', 'kick'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Burst', 'Rise'], default: 0 },
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 0.6 },
      { name: 'speed', label: 'Speed', min: -2, max: 2, default: 0.5, integrate: true },
      { name: 'size', label: 'Size', min: 0.3, max: 4, default: 1.2 },
      { name: 'reach', label: 'Reach', min: 0.1, max: 1.5, default: 0.7 },
      { name: 'trail', label: 'Trail', min: 0, max: 1, default: 0.5 },
      { name: 'colorA', label: 'Hot', type: 'color', default: '#ffd23f' },
      { name: 'colorB', label: 'Cool', type: 'color', default: '#ff2a6d' },
    ],
    glsl: LAYER_GLSL + `
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float px = 1.0 / u_res.y;
  float amt = p_amount;
  vec3 col = vec3(0.0);
  if (p_mode == 0) {
    float ang = atan(p.y, p.x + 1e-20);
    for (int l = 0; l < 4; l++) {
      float fl = float(l);
      float S = 40.0 + 23.0 * fl;
      float rot = fl * 2.11;
      float id0 = floor(mod(ang + rot, TAU) / TAU * S);
      for (int k = -1; k <= 1; k++) {
        float id = id0 + float(k);
        float idw = mod(id, S);
        vec3 h = hash32(vec2(idw, fl * 13.0 + 5.0));
        float as = (id + 0.15 + 0.7 * h.x) / S * TAU - rot;
        vec2 dir = vec2(cos(as), sin(as));
        float ph = h.y + p_speed_t * (0.3 + 0.4 * h.z);
        float life = fract(ph);
        float alive = step(hash12(vec2(idw + floor(ph) * 7.13, fl)), amt);
        float dist = p_reach * (0.4 + 0.6 * h.z);
        float rs = life * dist;
        float rt = max(rs - p_trail * 0.2 * dist * (0.3 + 0.7 * life), 0.0);
        float d = sdSeg(p, dir * rt, dir * rs);
        float w = p_size * px * (2.2 - 1.5 * life);
        float core = 1.0 - smoothstep(w * 0.5, w * 0.5 + px, d);
        float glow = exp(-d / (w * 2.5 + 1e-4)) * 0.45;
        float b = pow(1.0 - life, 1.2) * smoothstep(0.0, 0.04, life) * alive * (0.9 + 0.9 * amt);
        col += mix(p_colorA, p_colorB, life) * (core + glow) * b + vec3(0.4 * core * b * (1.0 - life));
      }
    }
  } else {
    for (int l = 0; l < 2; l++) {
      float fl = float(l);
      float sc = 7.0 + 6.0 * fl;
      vec2 q = p * sc - vec2(0.0, p_speed_t * (2.0 + fl)) + fl * 41.3;
      vec2 g0 = floor(q);
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 g = g0 + vec2(float(i), float(j));
          vec3 h = hash32(g + fl * 31.0);
          float alive = step(h.z, amt * 0.8);
          float wob = p_speed_t * 1.7 + h.x * TAU;
          vec2 c = g + 0.5 + 0.3 * vec2(sin(wob), sin(p_speed_t * 1.3 + h.y * TAU));
          vec2 tail = c - vec2(0.25 * cos(wob), 1.0) * (p_trail * 0.5 + 0.001);
          float d = sdSeg(q, c, tail) / sc;
          float w = p_size * px * (1.0 + h.y);
          float core = 1.0 - smoothstep(w * 0.5, w * 0.5 + px, d);
          float glow = exp(-d / (w * 2.5 + 1e-4)) * 0.45;
          float flick = 0.55 + 0.45 * sin(p_speed_t * 9.0 + h.x * 40.0);
          float hgt = 1.0 - smoothstep(-0.5, 0.55, p.y);
          float b = alive * flick * (0.4 + 0.6 * hgt) * (0.6 + 0.6 * amt);
          col += mix(p_colorB, p_colorA, h.y * hgt) * (core + glow) * b + vec3(0.3 * core * b);
        }
      }
    }
  }
  return layer(col);
}`,
  },
  {
    type: 'sun',
    title: 'Sun',
    category: 'generator',
    description: 'Synthwave sun with scrolling slits and a halo',
    tags: ['outrun', 'synthwave', 'retro', 'sunset', 'vaporwave', 'disc'],
    params: [
      { name: 'size', label: 'Size', min: 0.05, max: 0.5, default: 0.3 },
      { name: 'y', label: 'Height', min: 0, max: 1, default: 0.55 },
      { name: 'slits', label: 'Slits', min: 0, max: 24, default: 10 },
      { name: 'cut', label: 'Cut', min: 0, max: 1, default: 0.6 },
      { name: 'speed', label: 'Speed', min: -2, max: 2, default: 0.3, integrate: true },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.6 },
      { name: 'colorA', label: 'Top', type: 'color', default: '#ffe66d' },
      { name: 'colorB', label: 'Bottom', type: 'color', default: '#ff2a6d' },
    ],
    glsl: LAYER_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  vec2 q = (p - vec2(0.0, p_y - 0.5)) / p_size;   // unit disc
  float r = length(q);
  float pxq = 1.0 / (u_res.y * p_size);
  float disc = 1.0 - smoothstep(1.0 - pxq, 1.0 + pxq, r);
  float s = q.y * p_slits * 0.5 + p_speed_t;
  float fw = fwidth(s) + 1e-4;
  float fs = fract(s);
  float th = p_cut * 0.7 * clamp((0.25 - q.y) / 1.25, 0.0, 1.0);
  float slit = clamp((min(fs + 0.5 * fw, th) - max(fs - 0.5 * fw, 0.0)) / fw, 0.0, 1.0);
  disc *= 1.0 - slit * step(0.5, p_slits);
  vec3 c = mix(p_colorB, p_colorA, smoothstep(-0.9, 0.9, q.y));
  float e = max(r - 1.0, 0.0);
  float halo = p_glow * (0.7 * exp(-e / (0.06 + 0.2 * p_glow)) + 0.3 * exp(-e / (0.3 + 0.9 * p_glow))) * (1.0 - disc);
  vec3 col = c * disc + mix(p_colorB, p_colorA, 0.2) * halo;
  return layer(col);
}`,
  },
  {
    type: 'grid-floor',
    title: 'Grid Floor',
    category: 'generator',
    description: 'Perspective neon grid racing toward a glowing horizon',
    tags: ['outrun', 'synthwave', 'retro', 'perspective', 'floor', 'tron', 'road'],
    params: [
      { name: 'horizon', label: 'Horizon', min: 0, max: 1, default: 0.5 },
      { name: 'speed', label: 'Speed', min: -4, max: 4, default: 0.8, integrate: true },
      { name: 'density', label: 'Density', min: 1, max: 24, default: 8 },
      { name: 'width', label: 'Width', min: 0.01, max: 0.4, default: 0.06 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
      { name: 'fade', label: 'Fade', min: 0, max: 1, default: 0.4 },
      { name: 'height', label: 'Camera', min: 0.2, max: 3, default: 1 },
      { name: 'bend', label: 'Bend', min: -1, max: 1, default: 0 },
      { name: 'ceiling', label: 'Ceiling', type: 'select', options: ['Off', 'On'], default: 0 },
      { name: 'color', label: 'Grid', type: 'color', default: '#ff00c8' },
      { name: 'color2', label: 'Horizon', type: 'color', default: '#00e5ff' },
    ],
    glsl: LAYER_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float hy = p_horizon - 0.5;
  float dy = hy - p.y;                      // > 0 below the horizon
  float ady = max(abs(dy), 1e-3);
  float z = p_height / ady;                 // distance along the floor
  vec2 w = vec2(p.x * z + p_bend * z * z * 0.08, z + p_speed_t * 2.0) * p_density * 0.25;
  vec2 fw = fwidth(w) + 1e-4;
  vec2 g = abs(fract(w + 0.5) - 0.5);
  float lw = p_width * 0.5;
  vec2 lv = 1.0 - smoothstep(lw - fw, lw + fw, g);
  lv = mix(lv, vec2(2.0 * lw), smoothstep(0.3, 1.0, fw));
  float m = max(lv.x, lv.y);
  float dpx = min(g.x / fw.x, g.y / fw.y);
  float gl = p_glow * exp(-dpx / 5.0) * 0.5;
  float fog = exp(-max(z - p_height, 0.0) * p_fade * 0.35) * smoothstep(0.0, 0.03, ady);
  float on = dy > 0.0 || p_ceiling == 1 ? 1.0 : 0.0;
  vec3 col = p_color * (m + gl) * fog * on + vec3(0.25 * m * fog * on);
  col += p_color2 * p_glow * exp(-abs(p.y - hy) / (0.004 + 0.03 * p_glow));
  col += p_color2 * 0.35 * exp(-abs(p.y - hy) / 0.0025);
  return layer(col);
}`,
  },
  {
    type: 'scanner',
    title: 'Scanner',
    category: 'generator',
    description: 'Sweeping scan bars with trails, or a rotating radar arm',
    tags: ['scan', 'sweep', 'radar', 'larsen', 'kitt', 'bar'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Horizontal', 'Vertical', 'Bounce H', 'Bounce V', 'Radar'], default: 2 },
      { name: 'count', label: 'Count', min: 1, max: 8, default: 1, step: 1 },
      { name: 'speed', label: 'Speed', min: -4, max: 4, default: 0.6, integrate: true },
      { name: 'width', label: 'Width', min: 0.002, max: 0.2, default: 0.012 },
      { name: 'trail', label: 'Trail', min: 0, max: 1, default: 0.5 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
      { name: 'color', label: 'Color', type: 'color', default: '#ff2040' },
    ],
    glsl: LAYER_GLSL + `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float px = 1.0 / u_res.y;
  int n = int(p_count + 0.5);
  float fn = float(n);
  float sgn = p_speed < 0.0 ? -1.0 : 1.0;
  float hw = p_width * 0.5;
  float gw = 0.006 + 0.04 * p_glow;
  float tl = p_trail * 0.2 + 1e-3;
  vec3 col = vec3(0.0);
  if (p_mode == 4) {
    float a = atan(p.y, p.x + 1e-20);
    for (int k = 0; k < 8; k++) {
      if (k >= n) break;
      float sa = p_speed_t + float(k) * TAU / fn;
      vec2 dir = vec2(cos(sa), sin(sa));
      float along = dot(p, dir);
      float d = along > 0.0 ? abs(dir.x * p.y - dir.y * p.x) : length(p);
      float behind = mod((sa - a) * sgn, TAU);
      float trail = exp(-behind / (tl * 4.0)) * 0.6 * step(0.0, p_trail - 1e-3);
      float core = 1.0 - smoothstep(hw, hw + px, d);
      col += p_color * (core + p_glow * exp(-d / gw) * 0.6 + trail) + vec3(0.3 * core);
    }
  } else {
    bool vert = p_mode == 1 || p_mode == 3;
    bool bounce = p_mode >= 2;
    float coord = vert ? uv.y : uv.x;
    float span = vert ? 1.0 : u_aspect;
    for (int k = 0; k < 8; k++) {
      if (k >= n) break;
      float ph = p_speed_t * 0.5 + float(k) / fn;
      float pos, behind, vel = sgn;
      if (bounce) {
        float x = fract(ph * 0.5);
        pos = 1.0 - abs(2.0 * x - 1.0);
        vel *= x < 0.5 ? 1.0 : -1.0;
        behind = (pos - coord) * vel * span;
        behind = behind < 0.0 ? 1e3 : behind;
      } else {
        pos = fract(ph);
        behind = fract((pos - coord) * vel) * span;
      }
      float d = bounce ? abs(coord - pos) * span : abs(fract(coord - pos + 0.5) - 0.5) * span;
      float core = 1.0 - smoothstep(hw, hw + px, d);
      float trail = exp(-behind / tl) * 0.6 * step(0.0, p_trail - 1e-3);
      col += p_color * (core + p_glow * exp(-d / gw) * 0.6 + trail) + vec3(0.3 * core);
    }
  }
  return layer(col);
}`,
  },

  // ── audio-driven ────────────────────────────────────────────────────────
  {
    type: 'spectrum-bars',
    title: 'Spectrum',
    category: 'generator',
    description: 'Spectrum analyser bars: bottom, centre or circle',
    tags: ['eq', 'analyzer', 'bars', 'audio', 'fft', 'frequency', 'visualizer'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Bottom', 'Center', 'Circle'], default: 0 },
      { name: 'bars', label: 'Bars', min: 4, max: 128, default: 48, step: 1 },
      { name: 'gain', label: 'Gain', min: 0, max: 4, default: 1.2 },
      { name: 'height', label: 'Height', min: 0.05, max: 1, default: 0.6 },
      { name: 'gap', label: 'Gap', min: 0, max: 0.9, default: 0.3 },
      { name: 'mirror', label: 'Mirror', type: 'select', options: ['Off', 'On'], default: 0 },
      { name: 'radius', label: 'Radius', min: 0, max: 0.45, default: 0.18 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.3 },
      { name: 'colorA', label: 'Low', type: 'color', default: '#ff2a6d' },
      { name: 'colorB', label: 'High', type: 'color', default: '#05d9e8' },
    ],
    glsl: LAYER_GLSL + `
float barValue(float i, float bars) {
  float s = 0.0;
  for (int k = 0; k < 4; k++) s += spectrum((i + (float(k) + 0.5) * 0.25) / bars);
  return s * 0.25;
}
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float bars = floor(p_bars + 0.5);
  bool mir = p_mirror == 1;
  // fx: frequency coordinate 0..1, fy: distance along the bar (screen units)
  // sx: screen units per unit of fx, hmax: tallest bar
  float fx, fy, sx, hmax;
  if (p_mode == 2) {
    float a = atan(p.x, p.y + 1e-20);
    float r = length(p);
    fx = mir ? abs(a) / PI : a / TAU + 0.5;
    sx = r * (mir ? PI : TAU);
    fy = r - p_radius;
    hmax = p_height * 0.35;
  } else {
    fx = mir ? abs(uv.x - 0.5) * 2.0 : uv.x;
    sx = u_aspect * (mir ? 0.5 : 1.0);
    fy = p_mode == 0 ? uv.y : abs(uv.y - 0.5);
    hmax = p_height * (p_mode == 0 ? 1.0 : 0.5);
  }
  float local = fx * bars;
  float i0 = floor(local);
  float half_ = 0.5 * (1.0 - p_gap);
  float gw = 0.004 + 0.03 * p_glow;
  float fill = 0.0, glow = 0.0;
  for (int k = -1; k <= 1; k++) {
    float bi = i0 + float(k);
    if (p_mode == 2 && !mir) bi = mod(bi, bars);
    else if (bi < 0.0 || bi >= bars) continue;
    float h = max(clamp(p_gain * barValue(bi, bars), 0.0, 1.0) * hmax, 0.004);
    float cx = (p_mode == 2 && !mir) ? i0 + float(k) + 0.5 : bi + 0.5;
    float dx = (abs(local - cx) - half_) * sx / bars;
    float ey = abs(fy - h * 0.5) - h * 0.5;
    float d = length(max(vec2(dx, ey), 0.0)) + min(max(dx, ey), 0.0);
    fill = max(fill, fillSd(d));
    glow += exp(-max(d, 0.0) / gw);
  }
  vec3 c = mix(p_colorA, p_colorB, clamp(fy / max(hmax, 1e-3), 0.0, 1.0));
  vec3 col = c * (fill + p_glow * 0.5 * glow * (1.0 - fill)) + vec3(0.15 * fill);
  return layer(col);
}`,
  },
  {
    type: 'scope',
    title: 'Scope',
    category: 'generator',
    description: 'Oscilloscope trace of the waveform: line, mirror or circle',
    tags: ['oscilloscope', 'waveform', 'audio', 'line', 'wave', 'trace'],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Line', 'Mirror', 'Circle'], default: 0 },
      { name: 'gain', label: 'Gain', min: 0, max: 3, default: 1 },
      { name: 'width', label: 'Thickness', min: 0.001, max: 0.03, default: 0.004 },
      { name: 'glow', label: 'Glow', min: 0, max: 1, default: 0.5 },
      { name: 'window', label: 'Window', min: 0.05, max: 1, default: 1 },
      { name: 'radius', label: 'Radius', min: 0.05, max: 0.45, default: 0.22 },
      { name: 'color', label: 'Color', type: 'color', default: '#00ffa3' },
    ],
    glsl: LAYER_GLSL + `
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}
float waveAt(float s) { return wave(0.5 + (s - 0.5) * p_window); }
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float px = 1.0 / u_res.y;
  float gw = 0.003 + 0.03 * p_glow;
  float reach = p_width + 3.0 * gw * step(0.001, p_glow) + 3.0 * px;
  float d = 1e3;
  // Polyline vertices sit on a grid shared by all pixels (no per-pixel wobble).
  const int N = 32;
  if (p_mode == 2) {
    float a0 = atan(p.x, p.y + 1e-20);                                // 0 at the top
    float range = min(reach / max(p_radius, 0.05), PI);       // same step for every pixel
    float da = PI / ceil(PI * float(N - 2) / (2.0 * range));  // pi is a whole number of steps
    float j0 = floor((a0 - range) / da);
    vec2 prev = vec2(0.0);
    for (int j = 0; j < N; j++) {
      float a = (j0 + float(j)) * da;
      float s = abs(mod(a + PI, TAU) - PI) / PI;              // 0 at top, 1 at bottom, mirrored
      vec2 cur = (p_radius + p_gain * 0.12 * waveAt(s)) * vec2(sin(a), cos(a));
      if (j > 0) d = min(d, sdSeg(p, prev, cur));
      prev = cur;
    }
  } else {
    float dx = reach * 2.0 / float(N - 2);
    float x0 = floor((p.x - reach) / dx) * dx;
    vec2 prev = vec2(0.0);
    for (int j = 0; j < N; j++) {
      float x = x0 + float(j) * dx;
      vec2 cur = vec2(x, p_gain * 0.35 * waveAt(x / u_aspect + 0.5));
      if (j > 0) {
        d = min(d, sdSeg(p, prev, cur));
        if (p_mode == 1) d = min(d, sdSeg(vec2(p.x, -p.y), prev, cur));
      }
      prev = cur;
    }
  }
  float core = fillSd(d - p_width * 0.5);
  float g = p_glow * exp(-max(d - p_width * 0.5, 0.0) / gw) * 0.7;
  return layer(p_color * (core + g) + vec3(0.35 * core));
}`,
  },
  {
    type: 'spectrogram',
    title: 'Spectrogram',
    category: 'generator',
    description: 'Scrolling waterfall of the spectrum history',
    tags: ['waterfall', 'sonogram', 'audio', 'fft', 'history', 'frequency'],
    params: [
      { name: 'direction', label: 'Direction', type: 'select', options: ['Up', 'Down', 'Left', 'Right'], default: 0 },
      { name: 'palette', label: 'Palette', type: 'select', options: PALETTES, default: 2 },
      { name: 'gain', label: 'Gain', min: 0, max: 4, default: 1.2 },
      { name: 'contrast', label: 'Contrast', min: 0.3, max: 4, default: 1.5 },
      { name: 'history', label: 'History', min: 0.05, max: 1, default: 1 },
      { name: 'fade', label: 'Fade', min: 0, max: 1, default: 0.3 },
      { name: 'mirror', label: 'Mirror', type: 'select', options: ['Off', 'On'], default: 0 },
    ],
    glsl: PALETTE_GLSL + `
vec4 render(vec2 uv) {
  vec2 q = uv;                                   // q.x = frequency, q.y = age
  if (p_direction == 1) q.y = 1.0 - q.y;
  else if (p_direction == 2) q = vec2(q.y, 1.0 - q.x);
  else if (p_direction == 3) q = vec2(q.y, q.x);
  float fx = p_mirror == 1 ? abs(q.x - 0.5) * 2.0 : q.x;
  float v = clamp(spectrogram(fx, q.y * p_history) * p_gain, 0.0, 1.0);
  v = pow(v, p_contrast) * (1.0 - p_fade * q.y);
  return vec4(clamp(palette(v, p_palette) * smoothstep(0.0, 0.12, v), 0.0, 1.0), 1.0);
}`,
  },
  {
    type: 'ridges',
    title: 'Ridges',
    category: 'generator',
    description: 'Stacked spectrum-history lines, Unknown Pleasures style',
    tags: ['joy division', 'unknown pleasures', 'waves', 'terrain', 'lines', 'audio', 'history'],
    params: [
      { name: 'lines', label: 'Lines', min: 8, max: 40, default: 26, step: 1 },
      { name: 'height', label: 'Height', min: 0, max: 0.6, default: 0.22 },
      { name: 'detail', label: 'Detail', min: 4, max: 64, default: 20 },
      { name: 'rough', label: 'Rough', min: 0, max: 1, default: 0.2 },
      { name: 'width', label: 'Width', min: 0.2, max: 1, default: 0.55 },
      { name: 'thickness', label: 'Thickness', min: 0.001, max: 0.012, default: 0.003 },
      { name: 'history', label: 'History', min: 0.05, max: 1, default: 0.6 },
      { name: 'mirror', label: 'Layout', type: 'select', options: ['Mirror', 'Linear'], default: 0 },
      { name: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    ],
    glsl: `
float vnoise(float x) { float i = floor(x), f = fract(x); return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f)); }
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float px = 1.0 / u_res.y;
  int n = int(p_lines + 0.5);
  float fn = float(n);
  float xn = p.x / (p_width * 0.5 * u_aspect);          // -1..1 across the band
  float inside = 1.0 - step(1.0, abs(xn));
  float fx = clamp(p_mirror == 0 ? abs(xn) : xn * 0.5 + 0.5, 0.0, 1.0);
  float env = 1.0 - smoothstep(0.25, 1.0, abs(xn));
  float bottom = -0.42, spacing = 0.8 / max(fn - 1.0, 1.0);
  float hw = p_thickness * 0.5;
  // smooth curve through Detail control points across the band (2 taps per line)
  float kd = floor(p_detail + 0.5);
  float c0 = floor(fx * kd), ct = smoothstep(0.0, 1.0, fract(fx * kd));
  vec3 col = vec3(0.0);
  float cov = 0.0, vis = inside;
  // front (bottom) to back. No per-pixel early exit: dFdx needs uniform control flow.
  for (int i = 0; i < 40; i++) {
    if (i >= n) break;
    float fi = float(i);
    float age = fi / fn * p_history;
    float s = mix(spectrogram(c0 / kd, age), spectrogram((c0 + 1.0) / kd, age), ct);
    float nz = vnoise(fx * 9.0 + fi * 13.1) * 0.7 + vnoise(fx * 21.0 - fi * 3.3 + u_time * 1.5) * 0.3;
    float y = bottom + fi * spacing + (s + p_rough * nz) * env * p_height;
    float run = 0.5 * abs(dFdx(y));                     // the curve's vertical run across this pixel
    float d = max(abs(p.y - y) - run, 0.0);
    float m = (1.0 - smoothstep(hw, hw + 1.5 * px, d)) * vis;
    col += (1.0 - cov) * m * p_color;
    cov += (1.0 - cov) * m;
    vis *= step(y - run - hw, p.y);                     // below this curve: hidden from here on
  }
  return vec4(clamp(col, 0.0, 1.0), clamp(cov, 0.0, 1.0));
}`,
  },

  // ── fractal ─────────────────────────────────────────────────────────────
  {
    type: 'julia',
    title: 'Julia',
    category: 'generator',
    description: 'Morphing Julia-set fractal with colour cycling',
    tags: ['fractal', 'mandelbrot', 'complex', 'psychedelic', 'palette'],
    params: [
      { name: 'zoom', label: 'Zoom', min: 0.5, max: 6, default: 1.2 },
      { name: 'morph', label: 'Morph', min: 0, max: 1, default: 0.36 },
      { name: 'speed', label: 'Drift', min: -0.5, max: 0.5, default: 0.05, integrate: true },
      { name: 'spin', label: 'Spin', min: -1, max: 1, default: 0, integrate: true },
      { name: 'detail', label: 'Detail', min: 8, max: 40, default: 28, step: 1 },
      { name: 'bands', label: 'Bands', min: 0.5, max: 8, default: 2 },
      { name: 'cycle', label: 'Cycle', min: -2, max: 2, default: 0.2, integrate: true },
      { name: 'palette', label: 'Palette', type: 'select', options: PALETTES, default: 0 },
    ],
    glsl: PALETTE_GLSL + `
vec4 render(vec2 uv) {
  vec2 z = rot2(p_spin_t) * centered(uv) * (2.6 / p_zoom);
  float a = TAU * p_morph + p_speed_t;
  vec2 c = 0.7885 * vec2(cos(a), sin(a));
  int maxIt = int(p_detail + 0.5);
  float it = 0.0, m2 = 0.0;
  bool esc = false;
  for (int i = 0; i < 40; i++) {
    if (i >= maxIt) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    m2 = dot(z, z);
    if (m2 > 256.0) { esc = true; break; }
    it += 1.0;
  }
  if (!esc) return vec4(0.0, 0.0, 0.0, 1.0);
  float sn = max(it - log2(log2(m2)) + 4.0, 0.0);
  float v = clamp(sn / float(maxIt), 0.0, 1.0);
  float k = tri(v * p_bands * 2.0 + p_cycle_t);
  vec3 col = palette(0.15 + 0.85 * k, p_palette) * smoothstep(0.18, 0.6, v);
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
  },
];
