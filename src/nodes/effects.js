// Effect nodes: one image in (sometimes two), one image out. See CONTRACT.md.
//
// Conventions used throughout this file:
// * rgb is treated as the visible colour (shape layers are black where alpha
//   is 0), so multi-tap filters average rgb and alpha independently, and
//   glows add light to rgb and raise alpha to the glow's brightness.
// * Every effect has an intensity param (amount / strength / radius …) whose
//   minimum is a clean pass-through, so a kick or hat can be patched into it.
// * Sizes in pixels are "pixels at 1080p" and scale with the output height.

export default [
  {
    type: 'transform',
    title: 'Transform',
    category: 'effect',
    description: 'Zoom, rotate and move an image',
    tags: ['zoom', 'rotate', 'scale', 'offset', 'pan'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'zoom', label: 'Zoom', min: 0.1, max: 8, default: 1 },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0 },
      { name: 'spin', label: 'Spin', min: -2, max: 2, default: 0, integrate: true },
      { name: 'x', label: 'X', min: -1, max: 1, default: 0 },
      { name: 'y', label: 'Y', min: -1, max: 1, default: 0 },
      { name: 'edge', label: 'Edge', type: 'select', options: ['Clamp', 'Mirror', 'Repeat', 'Black'], default: 1 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  p = rot2(-(p_angle + p_spin_t)) * p / p_zoom - vec2(p_x, p_y);
  vec2 s = uncenter(p);
  if (p_edge == 1) return texMirror(t_src, s);
  if (p_edge == 2) return texRepeat(t_src, s);
  if (p_edge == 3) return texBorder(t_src, s);
  return texture(t_src, s);
}`,
  },
  {
    type: 'feedback',
    title: 'Feedback',
    category: 'effect',
    description: 'Video feedback: trails that zoom, spin and fade',
    tags: ['trails', 'echo', 'tunnel', 'smear'],
    inputs: [{ name: 'src', label: 'Image' }],
    feedback: true,
    params: [
      { name: 'decay', label: 'Decay', min: 0, max: 0.99, default: 0.9 },
      { name: 'zoom', label: 'Zoom', min: 0.9, max: 1.1, default: 1.02 },
      { name: 'rotate', label: 'Rotate', min: -0.1, max: 0.1, default: 0.01 },
      { name: 'hue', label: 'Hue drift', min: -0.1, max: 0.1, default: 0 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Max', 'Add', 'Over'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = rot2(p_rotate) * centered(uv) / p_zoom;
  // decay is per 1/60 s, so trails last as long at any frame rate
  vec3 prev = texBorder(t_prev, uncenter(p)).rgb * pow(p_decay, u_dt * 60.0);
  if (p_hue != 0.0) {
    vec3 hsv = rgb2hsv(prev);
    prev = hsv2rgb(vec3(hsv.x + p_hue, hsv.yz));
  }
  vec4 cur = texture(t_src, uv);
  vec3 col;
  if (p_mode == 1) col = prev + cur.rgb;
  else if (p_mode == 2) col = prev * (1.0 - cur.a) + cur.rgb;
  else col = max(prev, cur.rgb);
  return vec4(min(col, vec3(4.0)), 1.0);
}`,
  },

  // ── trails ──────────────────────────────────────────────────
  {
    type: 'flow',
    title: 'Flow Trails',
    category: 'effect',
    description: 'Trails that drift and curl like smoke',
    tags: ['feedback', 'smoke', 'fluid', 'trails', 'advect', 'curl'],
    inputs: [{ name: 'src', label: 'Image' }],
    feedback: true,
    params: [
      { name: 'decay', label: 'Decay', min: 0, max: 0.99, default: 0.94 },
      { name: 'flow', label: 'Flow', min: 0, max: 1, default: 0.4 },
      { name: 'scale', label: 'Scale', min: 0.5, max: 10, default: 2.5 },
      { name: 'speed', label: 'Speed', min: 0, max: 2, default: 0.2, integrate: true },
      { name: 'lift', label: 'Lift', min: -1, max: 1, default: 0.2 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Max', 'Add', 'Over'], default: 0 },
    ],
    glsl: `
// divergence-free flow field from simplex noise
vec2 curl(vec3 q) {
  const float e = 0.08;
  float a = snoise(q + vec3(0.0, e, 0.0)), b = snoise(q - vec3(0.0, e, 0.0));
  float c = snoise(q + vec3(e, 0.0, 0.0)), d = snoise(q - vec3(e, 0.0, 0.0));
  return vec2(a - b, d - c) / (2.0 * e);
}
vec4 render(vec2 uv) {
  float k = clamp(u_dt * 60.0, 0.0, 4.0);   // per-frame amounts are tuned for 60 fps
  vec2 p = centered(uv);
  vec2 v = curl(vec3(p * p_scale, p_speed_t * 0.3)) * 0.0025 * p_flow + vec2(0.0, 0.003 * p_lift);
  vec3 trail = texBorder(t_prev, uncenter(p - v * k)).rgb * pow(max(p_decay, 1e-6), k);   // pow(0, 0) is undefined
  vec4 cur = texture(t_src, uv);
  vec3 col;
  if (p_mode == 1) col = trail + cur.rgb * cur.a;
  else if (p_mode == 2) col = mix(trail, cur.rgb, cur.a);
  else col = max(trail, cur.rgb * cur.a);
  col = clamp(col, 0.0, 4.0);
  return vec4(col, max(cur.a, min(1.0, max(col.r, max(col.g, col.b)))));
}`,
  },
  {
    type: 'datamosh',
    title: 'Datamosh',
    category: 'effect',
    description: 'Blocks freeze and smear like a broken video stream',
    tags: ['glitch', 'feedback', 'compression', 'smear', 'melt', 'mosh'],
    inputs: [{ name: 'src', label: 'Image' }],
    feedback: true,
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 0.4 },
      { name: 'blocks', label: 'Block size', min: 4, max: 96, default: 32 },
      { name: 'motion', label: 'Motion', min: 0, max: 1, default: 0.3 },
      { name: 'rate', label: 'Rate', min: 0, max: 20, default: 3, integrate: true },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 cur = texture(t_src, uv);
  if (p_amount <= 0.0) return cur;
  float step_ = floor(p_rate_t);                   // pattern changes 'rate' times a second
  float cell = p_blocks / 1080.0;
  vec2 id = floor(centered(uv) / cell);
  float hold = step(hash12(id + step_ * 17.17), p_amount * 0.92);
  // held blocks keep the old frame and drag it along a per-block motion vector
  vec2 mv = (hash22(id * 1.31 + step_ * 3.1) - 0.5) * p_motion * 0.012 * clamp(u_dt * 60.0, 0.0, 4.0);
  vec4 prev = texture(t_prev, uv - mv * vec2(1.0 / u_aspect, 1.0));
  return mix(cur, max(prev, 0.0), hold);
}`,
  },

  // ── symmetry & space ────────────────────────────────────────
  {
    type: 'kaleidoscope',
    title: 'Kaleidoscope',
    category: 'effect',
    description: 'Mirrored slices around the centre',
    tags: ['mirror', 'symmetry', 'mandala', 'fold'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'segments', label: 'Segments', min: 1, max: 16, default: 6, step: 1 },
      { name: 'spin', label: 'Spin', min: -2, max: 2, default: 0.15, integrate: true },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0 },
      { name: 'zoom', label: 'Zoom', min: 0.25, max: 4, default: 1 },
      { name: 'offset', label: 'Offset', min: 0, max: 0.5, default: 0.12 },
      { name: 'amount', label: 'Mix', min: 0, max: 1, default: 1 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Fold', 'Wrap'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 src = texture(t_src, uv);
  if (p_amount <= 0.0) return src;
  float n = max(1.0, floor(p_segments + 0.5));
  float seg = TAU / n;
  vec2 p = rot2(-p_angle) * centered(uv);
  float a = mod(atan(p.y, p.x), seg);
  if (p_mode == 0) a = abs(a - 0.5 * seg);          // mirror every other slice: no seams
  vec2 q = vec2(cos(a), sin(a)) * length(p) / p_zoom;
  q = rot2(p_spin_t) * (q + vec2(p_offset, 0.0));    // turn the source under the mirrors
  return mix(src, texMirror(t_src, uncenter(q)), p_amount);
}`,
  },
  {
    type: 'mirror',
    title: 'Mirror',
    category: 'effect',
    description: 'Reflect one half (or quarter) onto the other',
    tags: ['symmetry', 'flip', 'reflect', 'quad'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'mode', label: 'Keep', type: 'select', options: ['Left', 'Right', 'Top', 'Bottom', 'Quad', 'Diagonal'], default: 0 },
      { name: 'axis', label: 'Axis', min: -0.5, max: 0.5, default: 0 },
      { name: 'amount', label: 'Mix', min: 0, max: 1, default: 1 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 src = texture(t_src, uv);
  if (p_amount <= 0.0) return src;
  float c = 0.5 + p_axis;
  vec2 s = uv;
  if (p_mode == 0) s.x = c - abs(uv.x - c);
  else if (p_mode == 1) s.x = c + abs(uv.x - c);
  else if (p_mode == 2) s.y = c + abs(uv.y - c);
  else if (p_mode == 3) s.y = c - abs(uv.y - c);
  else if (p_mode == 4) s = vec2(c - abs(uv.x - c), c + abs(uv.y - c));
  else {
    vec2 p = centered(uv) - vec2(p_axis, 0.0);
    if (p.y < p.x) p = p.yx;
    s = uncenter(p + vec2(p_axis, 0.0));
  }
  return mix(src, texMirror(t_src, s), p_amount);
}`,
  },
  {
    type: 'tile',
    title: 'Tile',
    category: 'effect',
    description: 'Repeat the image in a scrolling grid',
    tags: ['repeat', 'grid', 'wallpaper', 'mosaic', 'scroll'],
    inputs: [{ name: 'src', label: 'Image' }],
    lod: true,
    params: [
      { name: 'count', label: 'Count', min: 1, max: 16, default: 3 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Repeat', 'Mirror', 'Brick'], default: 1 },
      { name: 'gap', label: 'Gap', min: 0, max: 0.3, default: 0 },
      { name: 'scrollX', label: 'Scroll X', min: -2, max: 2, default: 0, integrate: true },
      { name: 'scrollY', label: 'Scroll Y', min: -2, max: 2, default: 0, integrate: true },
    ],
    glsl: `
vec4 render(vec2 uv) {
  float n = max(p_count, 1.0);
  vec2 q = (uv - 0.5) * n + 0.5 + vec2(p_scrollX_t, p_scrollY_t);
  if (p_mode == 2) q.x += 0.5 * mod(floor(q.y), 2.0);
  vec2 cell = floor(q);
  vec2 f = q - cell;
  if (p_mode == 1) f = mix(f, 1.0 - f, mod(cell, 2.0));
  float inside = 1.0;
  if (p_gap > 0.0) {
    float g = p_gap * 0.5, w = n / u_res.y;
    vec2 m = smoothstep(vec2(g - w), vec2(g + w), f) * (1.0 - smoothstep(vec2(1.0 - g - w), vec2(1.0 - g + w), f));
    inside = m.x * m.y;
    f = (f - g) / (1.0 - 2.0 * g);
  }
  // explicit lod: each tile is the whole image shrunk n times (and no seams at tile edges)
  return textureLod(t_src, clamp(f, 0.0, 1.0), log2(n)) * inside;
}`,
  },
  {
    type: 'polar',
    title: 'Polar',
    category: 'effect',
    description: 'Wrap an image around the centre, or unwrap it',
    tags: ['circle', 'tunnel', 'radial', 'coordinates', 'spiral'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'mode', label: 'Mode', type: 'select', options: ['Circle', 'Tunnel', 'Unwrap'], default: 0 },
      { name: 'repeat', label: 'Repeat', min: 1, max: 8, default: 1, step: 1 },
      { name: 'radius', label: 'Radius', min: 0.25, max: 4, default: 1 },
      { name: 'twist', label: 'Twist', min: -2, max: 2, default: 0 },
      { name: 'spin', label: 'Spin', min: -1, max: 1, default: 0.05, integrate: true },
      { name: 'amount', label: 'Mix', min: 0, max: 1, default: 1 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 src = texture(t_src, uv);
  if (p_amount <= 0.0) return src;
  float rep = max(1.0, floor(p_repeat + 0.5));
  vec2 s;
  if (p_mode < 2) {
    vec2 p = centered(uv);
    float r = length(p) * 2.0 / p_radius;                   // 0 centre, 1 at the top edge
    float a = atan(p.x, -p.y) / TAU + 0.5;                 // 0..1 round the circle
    float x = (a * rep + p_twist * r + p_spin_t) * 2.0;
    x = 1.0 - abs(1.0 - mod(x, 2.0));                      // ping-pong: no seam
    s = vec2(x, p_mode == 0 ? r : 1.0 - r);
  } else {
    float a = (uv.x / rep + p_spin_t) * TAU + p_twist * uv.y;
    s = uncenter(vec2(sin(a), -cos(a)) * uv.y * 0.5 * p_radius);
  }
  return mix(src, texMirror(t_src, s), p_amount);
}`,
  },

  // ── warps ───────────────────────────────────────────────────
  {
    type: 'wave-warp',
    title: 'Wave Warp',
    category: 'effect',
    description: 'Sine waves, ripples or liquid wobble',
    tags: ['ripple', 'wave', 'wobble', 'liquid', 'distort', 'water'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 0.2, default: 0.025 },
      { name: 'freq', label: 'Frequency', min: 0.5, max: 30, default: 5 },
      { name: 'speed', label: 'Speed', min: -4, max: 4, default: 1, integrate: true },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Sine', 'Ripple', 'Liquid'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  if (p_amount <= 0.0) return texture(t_src, uv);
  vec2 p = centered(uv);
  float ph = p_speed_t * TAU;
  vec2 off;
  if (p_mode == 1) {
    float r = length(p);
    off = p / max(r, 1e-4) * sin(r * p_freq * TAU - ph) * p_amount * smoothstep(0.0, 0.5 / p_freq, r);
  } else if (p_mode == 2) {
    vec3 q = vec3(p * p_freq * 0.35, p_speed_t * 0.25);
    off = vec2(snoise(q), snoise(q + vec3(31.7, 11.3, 0.0))) * p_amount;
  } else {
    vec2 q = rot2(-p_angle) * p;
    off = rot2(p_angle) * vec2(sin(q.y * p_freq * TAU + ph), 0.5 * sin(q.x * p_freq * 0.7 * TAU + ph * 0.8)) * p_amount;
  }
  return texMirror(t_src, uncenter(p + off));
}`,
  },
  {
    type: 'swirl',
    title: 'Swirl',
    category: 'effect',
    description: 'Twist the image around a point',
    tags: ['twirl', 'vortex', 'whirlpool', 'distort'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'twist', label: 'Twist', min: -10, max: 10, default: 3 },
      { name: 'radius', label: 'Radius', min: 0.05, max: 1.5, default: 0.5 },
      { name: 'x', label: 'X', min: -1, max: 1, default: 0 },
      { name: 'y', label: 'Y', min: -1, max: 1, default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 c = vec2(p_x * 0.5 * u_aspect, p_y * 0.5);
  vec2 p = centered(uv) - c;
  float f = 1.0 - smoothstep(0.0, p_radius, length(p));
  p = rot2(p_twist * f * f) * p;
  return texMirror(t_src, uncenter(p + c));
}`,
  },
  {
    type: 'lens',
    title: 'Lens',
    category: 'effect',
    description: 'Fisheye bulge or pinch',
    tags: ['fisheye', 'bulge', 'pinch', 'barrel', 'distort'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Bulge', min: -1, max: 1, default: 0.5 },
      { name: 'zoom', label: 'Zoom', min: 0.5, max: 2, default: 1 },
      { name: 'edge', label: 'Edge', type: 'select', options: ['Mirror', 'Black'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float rn = length(p) / (0.5 * length(vec2(u_aspect, 1.0)));   // 1 in the corners
  float k = p_amount * 0.85;
  vec2 s = uncenter(p * (1.0 - k * (1.0 - rn * rn)) / p_zoom);  // corners stay put
  return p_edge == 1 ? texBorder(t_src, s) : texMirror(t_src, s);
}`,
  },
  {
    type: 'displace',
    title: 'Displace',
    category: 'effect',
    description: 'Push pixels around using a second image',
    tags: ['warp', 'refract', 'distort', 'map', 'bump'],
    inputs: [
      { name: 'src', label: 'Image' },
      { name: 'map', label: 'Map' },
    ],
    lod: true,
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 0.3, default: 0.06 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Luma', 'Gradient', 'RG'], default: 1 },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0.785 },
      { name: 'soften', label: 'Soften', min: 0, max: 1, default: 0.35 },
    ],
    glsl: `
float mapL(vec2 uv, float lod) { return clamp(luma(textureLod(t_map, uv, lod).rgb), 0.0, 2.0); }
vec4 render(vec2 uv) {
  if (p_amount <= 0.0) return texture(t_src, uv);
  float lod = p_soften * 6.0 + log2(u_res.y / 1080.0);
  lod = max(lod, 0.0);
  vec2 off;
  if (p_mode == 1) {
    // slope of the map's brightness (per screen height): things bend around it like glass
    vec2 e = exp2(lod) * 1.5 / u_res;
    off = vec2(mapL(uv + vec2(e.x, 0.0), lod) - mapL(uv - vec2(e.x, 0.0), lod),
               mapL(uv + vec2(0.0, e.y), lod) - mapL(uv - vec2(0.0, e.y), lod)) / (2.0 * e.y) * 0.08;
    off *= min(1.0, 1.5 / max(length(off), 1e-4));      // hard edges: cap the push
  } else if (p_mode == 2) {
    off = (clamp(textureLod(t_map, uv, lod).rg, 0.0, 1.0) - 0.5) * 2.0;
  } else {
    off = vec2(cos(p_angle), sin(p_angle)) * (mapL(uv, lod) - 0.5) * 2.0;
  }
  vec2 s = uv + off * p_amount * vec2(1.0 / u_aspect, 1.0);
  return textureLod(t_src, mirrorUV(s), 0.0);
}`,
  },

  // ── blur & light ────────────────────────────────────────────
  {
    type: 'blur',
    title: 'Blur',
    category: 'effect',
    description: 'Soft round or motion blur',
    tags: ['soften', 'defocus', 'bokeh', 'motion', 'smooth'],
    inputs: [{ name: 'src', label: 'Image' }],
    lod: true,
    params: [
      { name: 'radius', label: 'Radius', min: 0, max: 0.15, default: 0.015 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Round', 'Motion'], default: 0 },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  float rpx = p_radius * u_res.y;
  if (rpx < 0.5) return texture(t_src, uv);
  // 24 taps on a golden-angle spiral (or a line); mip level matches the tap spacing
  float lod = max(0.0, log2(rpx * (p_mode == 0 ? 0.36 : 0.09)));
  vec2 dir = vec2(cos(p_angle), sin(p_angle));
  vec2 sc = p_radius * vec2(1.0 / u_aspect, 1.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float t = (float(i) + 0.5) / 24.0;
    float a = float(i) * 2.39996323;
    vec2 o = p_mode == 0 ? vec2(cos(a), sin(a)) * sqrt(t) : dir * (t * 2.0 - 1.0);
    acc += textureLod(t_src, uv + o * sc, lod);
  }
  return max(acc / 24.0, 0.0);
}`,
  },
  {
    type: 'bloom',
    title: 'Bloom',
    category: 'effect',
    description: 'Bright parts glow and bleed light',
    tags: ['glow', 'halo', 'light', 'neon', 'hdr'],
    inputs: [{ name: 'src', label: 'Image' }],
    lod: true,
    params: [
      { name: 'intensity', label: 'Intensity', min: 0, max: 3, default: 1 },
      { name: 'threshold', label: 'Threshold', min: 0, max: 1.5, default: 0.5 },
      { name: 'radius', label: 'Radius', min: 0, max: 1, default: 0.6 },
      { name: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
    ],
    glsl: `
// soft-knee threshold on the brightest channel, keeps the hue
vec3 bright(vec3 c) {
  c = max(c, 0.0);
  float m = max(c.r, max(c.g, c.b));
  const float knee = 0.25;
  float s = clamp(m - p_threshold + knee, 0.0, 2.0 * knee);
  s = s * s / (4.0 * knee);
  return c * max(s, m - p_threshold) / max(m, 1e-4);
}
vec4 render(vec2 uv) {
  vec4 src = texture(t_src, uv);
  if (p_intensity <= 0.0) return src;
  // six mip levels, four rotated taps each; radius shifts weight to the wide levels
  float base = log2(u_res.y / 1080.0) + 1.5;
  float fall = mix(0.6, 1.8, p_radius);
  vec3 acc = vec3(0.0);
  float w = 1.0, wsum = 0.0;
  for (int i = 0; i < 6; i++) {
    float lod = max(0.0, base + float(i));
    vec2 o = exp2(lod) * 0.8 / u_res;
    mat2 r = rot2(float(i) * 0.7);
    vec3 c = bright(textureLod(t_src, uv + r * vec2(o.x, o.y), lod).rgb)
           + bright(textureLod(t_src, uv + r * vec2(-o.x, o.y), lod).rgb)
           + bright(textureLod(t_src, uv + r * vec2(o.x, -o.y), lod).rgb)
           + bright(textureLod(t_src, uv + r * vec2(-o.x, -o.y), lod).rgb);
    acc += c * 0.25 * w;
    wsum += w;
    w *= fall;
  }
  vec3 glow = acc / wsum * p_intensity * 2.0 * p_tint;
  float a = max(src.a, min(1.0, max(glow.r, max(glow.g, glow.b))));
  return vec4(max(src.rgb, 0.0) + glow, a);
}`,
  },
  {
    type: 'zoom-blur',
    title: 'Zoom Blur',
    category: 'effect',
    description: 'Radial speed blur, spin blur or light rays',
    tags: ['radial', 'speed', 'rays', 'god rays', 'spin', 'motion'],
    inputs: [{ name: 'src', label: 'Image' }],
    lod: true,
    params: [
      { name: 'strength', label: 'Strength', min: 0, max: 1, default: 0.25 },
      { name: 'x', label: 'X', min: -1, max: 1, default: 0 },
      { name: 'y', label: 'Y', min: -1, max: 1, default: 0 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Zoom', 'Spin', 'Rays'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 src = texture(t_src, uv);
  if (p_strength <= 0.0) return src;
  vec2 c = 0.5 + vec2(p_x, p_y) * 0.5;
  vec2 d = uv - c;
  vec2 asp = vec2(u_aspect, 1.0);
  float len = length(d * asp) * u_res.y * p_strength;    // streak length in pixels
  float lod = max(0.0, log2(len / 24.0 + 1e-4) - 0.5);
  float jit = hash12(floor(uv * u_res));                 // hides banding between taps
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = (float(i) + jit) / 24.0;
    vec2 s = p_mode == 1 ? c + rot2((t - 0.5) * p_strength) * (d * asp) / asp
                         : c + d * (1.0 - p_strength * t);
    vec4 tap = textureLod(t_src, s, lod);
    float w = 1.0;
    if (p_mode == 2) {
      w = 1.0 - t;
      tap.rgb = max(tap.rgb, 0.0) * smoothstep(0.25, 1.0, max(tap.r, max(tap.g, tap.b)));
    }
    acc += tap * w;
    wsum += w;
  }
  acc /= wsum;
  if (p_mode == 2) {
    vec3 rays = acc.rgb * 1.6 * min(1.0, p_strength * 4.0);
    return vec4(max(src.rgb, 0.0) + rays, max(src.a, min(1.0, max(rays.r, max(rays.g, rays.b)))));
  }
  return max(acc, 0.0);
}`,
  },
  {
    type: 'rgb-split',
    title: 'RGB Split',
    category: 'effect',
    description: 'Chromatic aberration: colour channels drift apart',
    tags: ['chromatic', 'aberration', 'rgb', 'shift', 'fringe', 'prism'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 0.1, default: 0.012 },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Linear', 'Radial'], default: 0 },
      { name: 'style', label: 'Style', type: 'select', options: ['Hard', 'Spectral'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  if (p_amount <= 0.0) return texture(t_src, uv);
  vec2 d = p_mode == 1 ? rot2(p_angle) * (uv - 0.5) * p_amount * 4.0
                       : vec2(cos(p_angle), sin(p_angle)) * p_amount * vec2(1.0 / u_aspect, 1.0);
  if (p_style == 0) {
    vec4 r = texture(t_src, uv + d), g = texture(t_src, uv), b = texture(t_src, uv - d);
    return vec4(max(vec3(r.r, g.g, b.b), 0.0), max(g.a, max(r.a, b.a)));
  }
  // spectral: 12 taps along the offset, each tinted along a red→green→blue ramp
  vec3 acc = vec3(0.0), wsum = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < 12; i++) {
    float t = (float(i) + 0.5) / 12.0;
    vec3 w = max(1.0 - abs(vec3(t) - vec3(0.0, 0.5, 1.0)) * 2.0, 0.0);
    vec4 c = texture(t_src, uv + d * (1.0 - 2.0 * t));
    acc += c.rgb * w;
    wsum += w;
    a = max(a, c.a);
  }
  return vec4(max(acc / wsum, 0.0), a);
}`,
  },

  // ── colour ──────────────────────────────────────────────────
  {
    type: 'color-adjust',
    title: 'Color Adjust',
    category: 'effect',
    description: 'Brightness, contrast, saturation, hue and gamma',
    tags: ['colour', 'grade', 'hue', 'saturation', 'contrast', 'brightness', 'levels'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'brightness', label: 'Brightness', min: 0, max: 3, default: 1 },
      { name: 'contrast', label: 'Contrast', min: 0, max: 3, default: 1 },
      { name: 'saturation', label: 'Saturation', min: 0, max: 3, default: 1 },
      { name: 'hue', label: 'Hue', min: -0.5, max: 0.5, default: 0 },
      { name: 'spin', label: 'Hue spin', min: -1, max: 1, default: 0, integrate: true },
      { name: 'gamma', label: 'Gamma', min: 0.25, max: 4, default: 1 },
    ],
    glsl: `
// rotate around the grey axis: hue shift that also works above 1.0
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735027);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  vec3 c = pow(max(s.rgb, 0.0), vec3(1.0 / p_gamma));
  c *= p_brightness;
  c = (c - 0.5) * p_contrast + 0.5;
  c = mix(vec3(luma(c)), c, p_saturation);
  c = hueRotate(c, TAU * (p_hue + p_spin_t));
  return vec4(max(c, 0.0), s.a);
}`,
  },
  {
    type: 'gradient-map',
    title: 'Gradient Map',
    category: 'effect',
    description: 'Colour an image by its brightness',
    tags: ['colorize', 'palette', 'ramp', 'tint', 'duotone', 'lut', 'false colour'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'preset', label: 'Palette', type: 'select', options: ['Custom', 'Synthwave', 'Fire', 'Ice', 'Acid', 'Thermal', 'Rainbow'], default: 0 },
      { name: 'color1', label: 'Dark', type: 'color', default: '#0d0221' },
      { name: 'color2', label: 'Mid', type: 'color', default: '#ff2a6d' },
      { name: 'color3', label: 'Light', type: 'color', default: '#ffd319' },
      { name: 'offset', label: 'Offset', min: 0, max: 1, default: 0 },
      { name: 'repeat', label: 'Repeat', min: 1, max: 8, default: 1 },
      { name: 'cycle', label: 'Cycle', min: -1, max: 1, default: 0, integrate: true },
      { name: 'amount', label: 'Mix', min: 0, max: 1, default: 1 },
    ],
    glsl: `
vec3 ramp5(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  if (t < 1.0) return mix(a, b, t);
  if (t < 2.0) return mix(b, c, t - 1.0);
  if (t < 3.0) return mix(c, d, t - 2.0);
  return mix(d, e, t - 3.0);
}
vec3 palette(float t) {
  if (p_preset == 1) return ramp5(vec3(0.03, 0.0, 0.1), vec3(0.3, 0.05, 0.55), vec3(1.0, 0.16, 0.43), vec3(1.0, 0.55, 0.2), vec3(1.0, 0.95, 0.65), t);
  if (p_preset == 2) return ramp5(vec3(0.0), vec3(0.45, 0.02, 0.02), vec3(0.95, 0.25, 0.0), vec3(1.0, 0.75, 0.1), vec3(1.0, 1.0, 0.85), t);
  if (p_preset == 3) return ramp5(vec3(0.0, 0.0, 0.03), vec3(0.03, 0.1, 0.35), vec3(0.1, 0.45, 0.9), vec3(0.45, 0.9, 1.0), vec3(0.95, 1.0, 1.0), t);
  if (p_preset == 4) return ramp5(vec3(0.0), vec3(0.05, 0.2, 0.0), vec3(0.45, 0.85, 0.0), vec3(0.85, 1.0, 0.1), vec3(1.0, 1.0, 0.9), t);
  if (p_preset == 5) return ramp5(vec3(0.0), vec3(0.1, 0.0, 0.45), vec3(0.85, 0.0, 0.6), vec3(1.0, 0.55, 0.0), vec3(1.0, 1.0, 0.6), t);
  if (p_preset == 6) return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(p_color1, p_color2, t * 2.0) : mix(p_color2, p_color3, t * 2.0 - 1.0);
}
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  float t = clamp(luma(s.rgb), 0.0, 1.0) * p_repeat + p_offset + p_cycle_t;
  t = 1.0 - abs(1.0 - mod(t, 2.0));          // ping-pong so offset and cycling never jump
  return vec4(max(mix(s.rgb, palette(t), p_amount), 0.0), s.a);
}`,
  },
  {
    type: 'posterize',
    title: 'Posterize',
    category: 'effect',
    description: 'Reduce to a few flat colour bands',
    tags: ['quantize', 'bands', 'levels', 'cel', 'toon', 'pop art'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'levels', label: 'Levels', min: 2, max: 16, default: 4, step: 1 },
      { name: 'gamma', label: 'Gamma', min: 0.25, max: 4, default: 1 },
      { name: 'amount', label: 'Mix', min: 0, max: 1, default: 1 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['RGB', 'Luma', 'HSV'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  if (p_amount <= 0.0) return s;
  float n = max(2.0, floor(p_levels + 0.5)) - 1.0;
  vec3 c = pow(max(s.rgb, 0.0), vec3(p_gamma));
  vec3 q;
  if (p_mode == 1) {
    float l = luma(c);
    q = c * (floor(l * n + 0.5) / n) / max(l, 1e-4);
  } else if (p_mode == 2) {
    vec3 h = rgb2hsv(c);
    h = vec3(floor(h.x * n * 2.0 + 0.5) / (n * 2.0), floor(h.yz * n + 0.5) / n);
    q = hsv2rgb(h);
  } else {
    q = floor(c * n + 0.5) / n;
  }
  q = pow(max(q, 0.0), vec3(1.0 / p_gamma));
  return vec4(max(mix(s.rgb, q, p_amount), 0.0), s.a);
}`,
  },
  {
    type: 'invert',
    title: 'Invert',
    category: 'effect',
    description: 'Negative image, inverted brightness or opposite hues',
    tags: ['negative', 'complement', 'flip'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 1 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['RGB', 'Luma', 'Hue'], default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  vec3 c = max(s.rgb, 0.0);
  float l = luma(c);
  vec3 inv;
  if (p_mode == 1) inv = c + (1.0 - 2.0 * l);   // same hue, brightness flipped
  else if (p_mode == 2) inv = 2.0 * l - c;      // complementary hue, same brightness
  else inv = 1.0 - c;
  return vec4(max(mix(c, inv, p_amount), 0.0), s.a);
}`,
  },
  {
    type: 'threshold',
    title: 'Threshold',
    category: 'effect',
    description: 'Hard two-tone cut at a brightness level',
    tags: ['binary', 'two-tone', 'stencil', 'black and white', 'gate'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'level', label: 'Level', min: 0, max: 1, default: 0.4 },
      { name: 'softness', label: 'Softness', min: 0, max: 0.5, default: 0.02 },
      { name: 'amount', label: 'Mix', min: 0, max: 1, default: 1 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Two-tone', 'Gate'], default: 0 },
      { name: 'low', label: 'Low', type: 'color', default: '#000000' },
      { name: 'high', label: 'High', type: 'color', default: '#ffffff' },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  float h = p_softness + 1e-3;
  float w = smoothstep(p_level - h, p_level + h, luma(s.rgb));
  vec3 c = mix(p_low, p_mode == 1 ? s.rgb : p_high, w);
  return vec4(max(mix(s.rgb, c, p_amount), 0.0), s.a);
}`,
  },

  // ── texture & retro ─────────────────────────────────────────
  {
    type: 'pixelate',
    title: 'Pixelate',
    category: 'effect',
    description: 'Big square, hex or LED-wall pixels',
    tags: ['mosaic', 'blocks', 'pixel', 'led', 'hexagon', '8-bit', 'lo-fi'],
    inputs: [{ name: 'src', label: 'Image' }],
    lod: true,
    params: [
      { name: 'size', label: 'Size', min: 1, max: 96, default: 20 },
      { name: 'shape', label: 'Shape', type: 'select', options: ['Square', 'Hex', 'LED'], default: 0 },
    ],
    glsl: `
vec2 hexCenter(vec2 p) {
  const vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h;
  vec2 b = mod(p - h, r) - h;
  return dot(a, a) < dot(b, b) ? p - a : p - b;
}
vec4 render(vec2 uv) {
  float cpx = p_size * u_res.y / 1080.0;        // cell size in output pixels
  if (cpx <= 1.0) return texture(t_src, uv);
  float cell = p_size / 1080.0;
  vec2 p = centered(uv) / cell;
  vec2 c = p_shape == 1 ? hexCenter(p) : floor(p) + 0.5;
  vec4 col = textureLod(t_src, uncenter(c * cell), max(0.0, log2(cpx) - 1.0));   // cell average
  if (p_shape == 2) {
    float d = length(p - c);
    float px = 1.0 / cpx;
    float dotMask = 1.0 - smoothstep(0.4 - px, 0.4 + px, d);
    col.rgb *= dotMask * 1.4 + 0.12 * exp(-d * 5.0);
  }
  return max(col, 0.0);
}`,
  },
  {
    type: 'halftone',
    title: 'Halftone',
    category: 'effect',
    description: 'Print-style dot screens: mono, colour, CMYK or lines',
    tags: ['dots', 'print', 'comic', 'cmyk', 'screen', 'newspaper', 'pop art'],
    inputs: [{ name: 'src', label: 'Image' }],
    lod: true,
    params: [
      { name: 'size', label: 'Size', min: 2, max: 64, default: 14 },
      { name: 'angle', label: 'Angle', min: -3.1416, max: 3.1416, default: 0.785 },
      { name: 'amount', label: 'Mix', min: 0, max: 1, default: 1 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Dots', 'Color', 'CMYK', 'Lines'], default: 1 },
      { name: 'ink', label: 'Ink', type: 'color', default: '#ffffff' },
      { name: 'paper', label: 'Paper', type: 'color', default: '#000000' },
    ],
    glsl: `
// ink coverage wanted by one separation: 0 luma, 1 cyan, 2 magenta, 3 yellow, 4 black
float ink(vec3 c, int ch) {
  c = clamp(c, 0.0, 1.0);
  if (ch == 0) return max(luma(c) - 0.04, 0.0) / 0.96;   // small black point: no dots on near-black
  float k = 1.0 - max(c.r, max(c.g, c.b));
  if (ch == 4) return k;
  float d = max(1.0 - k, 1e-4);
  if (ch == 1) return (1.0 - c.r - k) / d;
  if (ch == 2) return (1.0 - c.g - k) / d;
  return (1.0 - c.b - k) / d;
}
// dot coverage at p on a screen rotated by ang; checks the 2x2 nearest cells so big dots merge
float dots(vec2 p, float ang, int ch, float cell, float lod, out vec3 dotCol) {
  vec2 q = rot2(ang) * p / cell;
  vec2 b = floor(q - 0.5);
  float aa = 1.0 / (cell * u_res.y);
  float cov = 0.0;
  dotCol = vec3(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 cc = b + vec2(float(i), float(j)) + 0.5;
    vec3 s = textureLod(t_src, uncenter(rot2(-ang) * cc * cell), lod).rgb;
    float r = sqrt(clamp(ink(s, ch), 0.0, 1.0)) * 0.75;
    float m = (1.0 - smoothstep(r - aa, r + aa, length(q - cc))) * clamp(r / aa, 0.0, 1.0);
    if (m > cov) { cov = m; dotCol = s; }
  }
  return cov;
}
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  if (p_amount <= 0.0) return s;
  float cell = p_size / 1080.0;
  float lod = max(0.0, log2(cell * u_res.y) - 0.5);
  vec2 p = centered(uv);
  vec3 dc, col;
  if (p_mode == 2) {
    float c = dots(p, p_angle + 0.262, 1, cell, lod, dc);
    float m = dots(p, p_angle + 1.309, 2, cell, lod, dc);
    float y = dots(p, p_angle, 3, cell, lod, dc);
    float k = dots(p, p_angle + 0.785, 4, cell, lod, dc);
    col = vec3(1.0 - c, 1.0 - m, 1.0 - y) * (1.0 - k);
  } else if (p_mode == 3) {
    vec2 q = rot2(p_angle) * p / cell;
    float cy = floor(q.y) + 0.5;
    float v = luma(clamp(textureLod(t_src, uncenter(rot2(-p_angle) * vec2(q.x, cy) * cell), lod).rgb, 0.0, 1.0));
    float aa = 1.0 / (cell * u_res.y);
    float hw = v * 0.5;
    float m = (1.0 - smoothstep(hw - aa, hw + aa, abs(q.y - cy))) * clamp(hw / aa, 0.0, 1.0);
    col = mix(p_paper, p_ink, m);
  } else {
    float m = dots(p, p_angle, 0, cell, lod, dc);
    vec3 dotC = p_mode == 1 ? dc / max(max(dc.r, max(dc.g, dc.b)), 0.05) : p_ink;
    col = mix(p_paper, dotC, m);
  }
  return vec4(max(mix(s.rgb, col, p_amount), 0.0), s.a);
}`,
  },
  {
    type: 'edges',
    title: 'Edges',
    category: 'effect',
    description: 'Glowing outlines from edge detection',
    tags: ['sobel', 'outline', 'contour', 'neon', 'line art', 'tron'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 1 },
      { name: 'strength', label: 'Strength', min: 0, max: 4, default: 1.5 },
      { name: 'width', label: 'Width', min: 0.5, max: 6, default: 1.5 },
      { name: 'keep', label: 'Keep source', min: 0, max: 1, default: 0.15 },
      { name: 'mode', label: 'Color', type: 'select', options: ['Tint', 'Source', 'Rainbow'], default: 1 },
      { name: 'tint', label: 'Tint', type: 'color', default: '#2affd5' },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  if (p_amount <= 0.0) return s;
  vec2 e = max(p_width * u_res.y / 1080.0, 1.0) / u_res;
  vec3 tl = texture(t_src, uv + e * vec2(-1.0, 1.0)).rgb, tc = texture(t_src, uv + e * vec2(0.0, 1.0)).rgb;
  vec3 tr = texture(t_src, uv + e * vec2(1.0, 1.0)).rgb, ml = texture(t_src, uv + e * vec2(-1.0, 0.0)).rgb;
  vec3 mr = texture(t_src, uv + e * vec2(1.0, 0.0)).rgb, bl = texture(t_src, uv + e * vec2(-1.0, -1.0)).rgb;
  vec3 bc = texture(t_src, uv + e * vec2(0.0, -1.0)).rgb, br = texture(t_src, uv + e * vec2(1.0, -1.0)).rgb;
  vec3 gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  vec3 gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  float edge = sqrt(dot(gx, gx) + dot(gy, gy)) * 0.2 * p_strength;
  vec3 ec;
  if (p_mode == 1) {
    // colour of the brighter side of the edge, at full brightness
    vec3 mx = max(max(max(tl, tc), max(tr, ml)), max(max(mr, bl), max(bc, br)));
    ec = max(mx, 0.0) / max(max(mx.r, max(mx.g, mx.b)), 0.05);
  } else if (p_mode == 2) {
    vec2 g = vec2(dot(gx, vec3(1.0)), dot(gy, vec3(1.0)));
    ec = hsv2rgb(vec3(atan(g.y, g.x) / TAU, 0.75, 1.0));
  } else ec = p_tint;
  vec3 col = max(s.rgb, 0.0) * p_keep + ec * min(edge, 3.0);
  // the result is line art: coverage is the outlines plus whatever of the source is kept
  float a = max(s.a * p_keep, min(edge, 1.0));
  return vec4(max(mix(s.rgb, col, p_amount), 0.0), mix(s.a, a, p_amount));
}`,
  },
  {
    type: 'glitch',
    title: 'Glitch',
    category: 'effect',
    description: 'Digital breakup: torn lines, jumping blocks, split channels',
    tags: ['digital', 'error', 'corrupt', 'tear', 'databend', 'broken'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 0.3 },
      { name: 'rate', label: 'Rate', min: 0, max: 30, default: 8, integrate: true },
      { name: 'blocks', label: 'Blocks', min: 0.25, max: 4, default: 1 },
      { name: 'rgb', label: 'RGB shift', min: 0, max: 1, default: 0.6 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  if (p_amount <= 0.0) return texture(t_src, uv);
  float t = floor(p_rate_t);                                   // a new pattern 'rate' times a second
  float g = p_amount * mix(0.35, 1.0, hash11(t * 1.618 + 0.5)); // glitches come in bursts
  vec2 p = uv;
  // torn horizontal bands slide sideways
  float bands = floor(mix(6.0, 32.0, hash11(t + 11.7)));
  float band = floor(uv.y * bands);
  float tear = (hash12(vec2(band, t + 3.3)) - 0.5) * step(1.0 - g * 0.7, hash12(vec2(band, t))) * g * 0.5;
  p.x += tear;
  // rectangular blocks jump to somewhere else
  vec2 bs = vec2(mix(3.0, 18.0, hash11(t + 4.1)), mix(2.0, 12.0, hash11(t + 9.2))) * p_blocks;
  vec2 cell = floor(uv * bs);
  float hit = step(hash12(cell + t * 7.13), g * g * 0.35);
  p += (hash22(cell + t * 3.7) - 0.5) * vec2(0.4, 0.15) * g * hit;
  // fine line jitter
  p.x += (hash12(vec2(floor(uv.y * u_res.y * 0.5), t)) - 0.5) * 0.006 * g * g;
  // channels drift apart, most on torn lines and moved blocks
  float off = p_rgb * g * (0.004 + abs(tear) * 0.3 + hit * 0.02) * (hash11(t + 2.2) < 0.5 ? -1.0 : 1.0);
  vec4 cr = texture(t_src, fract(p + vec2(off, 0.0)));
  vec4 cg = texture(t_src, fract(p));
  vec4 cb = texture(t_src, fract(p - vec2(off, 0.0)));
  vec3 col = vec3(cr.r, cg.g, cb.b);
  // corrupted blocks: swapped channels, inverted, or raw noise when it gets wild
  float ck = hash12(cell * 1.7 + t * 5.1 + 2.0);
  if (ck < g * g * 0.12) col = col.brg;
  else if (ck < g * g * 0.18) col = 1.0 - col;
  if (hash12(cell + t * 2.9 + 5.0) < max(0.0, g - 0.55) * 0.35)
    col = vec3(hash12(floor(uv * u_res / 3.0) + t)) * vec3(0.6, 1.0, 0.8);
  return vec4(max(col, 0.0), max(cg.a, max(cr.a, cb.a)));
}`,
  },
  {
    type: 'crt',
    title: 'CRT',
    category: 'effect',
    description: 'Old tube monitor: scanlines, curved glass, phosphor mask',
    tags: ['retro', 'scanlines', 'tv', 'monitor', 'arcade', 'vintage'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'scan', label: 'Scanlines', min: 0, max: 1, default: 0.5 },
      { name: 'lines', label: 'Lines', min: 60, max: 480, default: 200 },
      { name: 'curve', label: 'Curvature', min: 0, max: 1, default: 0.35 },
      { name: 'mask', label: 'Phosphor', min: 0, max: 1, default: 0.35 },
      { name: 'vignette', label: 'Vignette', min: 0, max: 1, default: 0.4 },
      { name: 'flicker', label: 'Flicker', min: 0, max: 1, default: 0.15 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec2 cc = uv * 2.0 - 1.0;
  cc *= 1.0 + p_curve * 0.3 * (cc.yx * cc.yx);              // barrel-bent glass
  vec2 s = cc * 0.5 + 0.5;
  vec2 edgePx = (1.0 - abs(cc)) * u_res * 0.5;
  float inside = clamp(min(edgePx.x, edgePx.y) + 0.5, 0.0, 1.0);
  // beam convergence: red and blue land a little off
  float conv = p_mask * 0.8 / u_res.x;
  vec4 c = texture(t_src, s);
  vec3 col = max(vec3(texture(t_src, s + vec2(conv, 0.0)).r, c.g, texture(t_src, s - vec2(conv, 0.0)).b), 0.0);
  // scanlines: bright lines get fatter; fade out when lines get too thin to draw
  float fade = smoothstep(1.5, 3.0, u_res.y / p_lines);
  float sl = 0.5 + 0.5 * cos(TAU * s.y * p_lines);
  float beam = pow(sl, mix(2.0, 0.5, clamp(luma(col), 0.0, 1.0)));
  col *= mix(1.0, beam * 1.5, p_scan * fade);
  // aperture-grille phosphor stripes, one colour per output pixel column
  float px = mod(floor(uv.x * u_res.x), 3.0);
  vec3 m = px < 1.0 ? vec3(1.0, 0.3, 0.3) : px < 2.0 ? vec3(0.3, 1.0, 0.3) : vec3(0.3, 0.3, 1.0);
  col *= mix(vec3(1.0), m * 1.8, p_mask);
  // vignette from the curved glass
  col *= mix(1.0, pow(clamp(16.0 * s.x * s.y * (1.0 - s.x) * (1.0 - s.y), 0.0, 1.0), 0.35), p_vignette);
  // mains flicker and a slow rolling bar
  float roll = fract(s.y + u_time * 0.23);
  col *= 1.0 + p_flicker * (0.15 * exp(-pow((roll - 0.5) * 7.0, 2.0)) - 0.12 * hash11(floor(u_time * 30.0)));
  return vec4(max(col, 0.0) * inside, mix(1.0, c.a, inside));
}`,
  },
  {
    type: 'vhs',
    title: 'VHS',
    category: 'effect',
    description: 'Worn videotape: wobble, colour bleed, tracking noise',
    tags: ['tape', 'retro', 'analog', 'vintage', 'tracking', '80s', 'lo-fi'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 0.6 },
      { name: 'tracking', label: 'Tracking', min: 0, max: 1, default: 0.3 },
      { name: 'bleed', label: 'Bleed', min: 0, max: 1, default: 0.5 },
      { name: 'noise', label: 'Noise', min: 0, max: 1, default: 0.3 },
    ],
    glsl: `
vec3 toYIQ(vec3 c) { return mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c; }
vec3 toRGB(vec3 c) { return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * c; }
vec4 render(vec2 uv) {
  vec4 s0 = texture(t_src, uv);
  float A = p_amount;
  if (A <= 0.0) return s0;
  float fr = floor(u_time * 30.0);
  float line = floor(uv.y * u_res.y * 0.5);
  // tape wobble: slow bend plus per-line jitter
  float wob = (snoise(vec2(uv.y * 3.0, u_time * 0.8)) * 0.003 + (hash12(vec2(line, fr)) - 0.5) * 0.0015) * A;
  // tracking band rolling up the picture, and the head-switch strip at the bottom
  float by = fract(uv.y + u_time * 0.09) - 0.5;
  float band = exp(-by * by * 120.0) * p_tracking;
  float head = (1.0 - smoothstep(0.0, 0.03, uv.y)) * A;
  wob += (band + head) * (hash12(vec2(line, fr + 7.0)) - 0.3) * 0.05;
  vec2 q = vec2(uv.x + wob, uv.y);
  // sharp brightness, chroma smeared to the right
  float y = toYIQ(texture(t_src, q).rgb).x;
  vec2 iq = vec2(0.0);
  float spread = (0.002 + 0.01 * p_bleed) * A;
  for (int i = 0; i < 6; i++) iq += toYIQ(texture(t_src, q - vec2(float(i) * spread, 0.0)).rgb).yz;
  vec3 col = toRGB(vec3(y, iq / 6.0 * (1.0 - 0.25 * A)));
  // snow, sparkle in the tracking band, lifted blacks and soft highlights
  float n = hash12(floor(uv * u_res * 0.5) + fr * 13.0);
  col += (n - 0.5) * 0.12 * p_noise * A;
  float drop = hash12(vec2(floor(uv.x * u_res.x / (8.0 + 24.0 * hash11(line + fr))), line) + fr);
  col += step(1.0 - band * 0.05 - p_noise * 0.0015 * A, drop) * 0.7;      // white dropout streaks
  col = mix(col, col * 0.88 + 0.05, A);
  return vec4(max(col, 0.0), s0.a);
}`,
  },
  {
    type: 'grain',
    title: 'Grain',
    category: 'effect',
    description: 'Film grain, colour noise or TV static',
    tags: ['noise', 'film', 'static', 'snow', 'texture', 'dither'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 0.25 },
      { name: 'size', label: 'Size', min: 1, max: 8, default: 1.5 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Film', 'Color', 'Static'], default: 0 },
    ],
    glsl: `
float vnoise(vec2 p, float seed) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i + seed), b = hash12(i + vec2(1.0, 0.0) + seed);
  float c = hash12(i + vec2(0.0, 1.0) + seed), d = hash12(i + vec2(1.0, 1.0) + seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  if (p_amount <= 0.0) return s;
  float seed = hash11(floor(u_time * 24.0)) * 517.0;     // a new grain pattern 24 times a second
  vec2 gp = uv * u_res / max(p_size * u_res.y / 1080.0, 0.75);
  vec3 c = max(s.rgb, 0.0);
  if (p_mode == 2) {
    float st = hash12(floor(gp) + seed);
    st *= 0.75 + 0.5 * hash11(floor(uv.y * u_res.y / 2.0) + seed);   // faint horizontal streaks
    return vec4(mix(c, vec3(st), p_amount), s.a);
  }
  vec3 n = p_mode == 1 ? vec3(vnoise(gp, seed), vnoise(gp, seed + 17.0), vnoise(gp, seed + 41.0))
                       : vec3(vnoise(gp, seed));
  float l = clamp(luma(c), 0.0, 1.0);
  float resp = 0.4 + 2.4 * l * (1.0 - l);               // grain shows most in the mid-tones
  return vec4(max(c + (n - 0.5) * 1.6 * p_amount * resp, 0.0), s.a);
}`,
  },
  {
    type: 'vignette',
    title: 'Vignette',
    category: 'effect',
    description: 'Darken (or tint) the edges of the frame',
    tags: ['edges', 'frame', 'darken', 'lens'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 0.6 },
      { name: 'radius', label: 'Radius', min: 0, max: 1.5, default: 0.75 },
      { name: 'softness', label: 'Softness', min: 0.01, max: 1, default: 0.45 },
      { name: 'mode', label: 'Shape', type: 'select', options: ['Oval', 'Round'], default: 0 },
      { name: 'color', label: 'Color', type: 'color', default: '#000000' },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  float d = p_mode == 1 ? length(centered(uv)) / (0.5 * length(vec2(u_aspect, 1.0)))
                        : length(uv - 0.5) * 1.41421356;          // both reach 1 in the corners
  float v = smoothstep(p_radius - p_softness, p_radius + p_softness, d);
  return vec4(max(mix(s.rgb, p_color, v * p_amount), 0.0), s.a);
}`,
  },
  {
    type: 'strobe',
    title: 'Strobe',
    category: 'effect',
    description: 'Flash, invert or black out on the beat',
    tags: ['flash', 'beat', 'kick', 'blackout', 'invert', 'blinder'],
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'amount', label: 'Amount', min: 0, max: 1, default: 0 },
      { name: 'mode', label: 'Mode', type: 'select', options: ['Flash', 'Invert', 'Blackout', 'Expose'], default: 0 },
      { name: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { name: 'rate', label: 'Chop', min: 0, max: 20, default: 0, integrate: true },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec4 s = texture(t_src, uv);
  float k = p_amount;
  if (p_rate > 0.0) k *= step(0.5, fract(p_rate_t));   // chop the flash into an on/off strobe
  if (k <= 0.0) return s;
  vec3 c = max(s.rgb, 0.0);
  if (p_mode == 1) return vec4(max(mix(c, 1.0 - c, k), 0.0), s.a);
  if (p_mode == 2) return vec4(c * (1.0 - k), s.a);
  if (p_mode == 3) return vec4(c * (1.0 + 5.0 * k) + 0.15 * k * k, s.a);
  return vec4(mix(c, p_color, k), mix(s.a, 1.0, k));
}`,
  },
];
