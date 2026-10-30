// Shared GLSL that every image node gets for free. Node bodies define
// `vec4 render(vec2 uv)`; compose.js wraps it with this prelude, the node's
// uniforms and a main() that calls render(v_uv).

export const PRELUDE = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;            // track time, seconds
uniform float u_dt;              // seconds since last frame
uniform int   u_frame;           // frame counter
uniform vec2  u_res;             // output resolution, pixels
uniform float u_aspect;          // u_res.x / u_res.y
uniform sampler2D u_spectrum;    // 128x1, log-frequency spectrum 30 Hz–16 kHz, .r in 0..1
uniform sampler2D u_spectrogram; // 128x128, x = frequency, y = age (y=0 newest row), .r in 0..1
uniform sampler2D u_wave;        // 512x1, waveform around "now", .r in -1..1

#define PI  3.14159265359
#define TAU 6.28318530718

// ── coordinates ──────────────────────────────────────────────
// centered(): aspect-correct coords, origin in the middle, y in -0.5..0.5
vec2 centered(vec2 uv) { return (uv - 0.5) * vec2(u_aspect, 1.0); }
vec2 uncenter(vec2 p)  { return p / vec2(u_aspect, 1.0) + 0.5; }
mat2 rot2(float a)     { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec2 mirrorUV(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }

// ── sampling (textures are CLAMP_TO_EDGE) ────────────────────
vec4 texBorder(sampler2D s, vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(s, uv) * inside.x * inside.y;
}
vec4 texMirror(sampler2D s, vec2 uv) { return texture(s, mirrorUV(uv)); }
vec4 texRepeat(sampler2D s, vec2 uv) { return texture(s, fract(uv)); }

// ── audio textures ───────────────────────────────────────────
float spectrum(float x) { return texture(u_spectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
float spectrogram(float x, float age) { return texture(u_spectrogram, vec2(x, age)).r; }
float wave(float x)     { return texture(u_wave, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

// ── color ────────────────────────────────────────────────────
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
// Inigo Quilez cosine palette
vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }

// ── hashes & noise ───────────────────────────────────────────
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p)  { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2  hash22(vec2 p)  { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3  hash32(vec2 p)  { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }

// Simplex noise 3D (Ashima Arts, MIT) → roughly -1..1
vec4 _perm(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = _perm(_perm(_perm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = vec3(0.285714285714, -0.928571428571, 0.142857142857);
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = inversesqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float snoise(vec2 p) { return snoise(vec3(p, 0.0)); }

// fractal brownian motion over snoise, roughly -1..1
float fbm(vec3 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * snoise(p);
    norm += amp;
    p = p * 2.03 + vec3(17.1, 31.7, 7.3);
    amp *= 0.5;
  }
  return sum / norm;
}

// ── shapes ───────────────────────────────────────────────────
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
// anti-aliased fill of a signed distance (pixel-width edge)
float fillSd(float d) { float w = 1.5 / u_res.y; return 1.0 - smoothstep(-w, w, d); }
`;

export const VERTEX = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
