// The GLSL node: you write the shader, and its uniform declarations become the
// node's inputs and sliders.
//   uniform sampler2D t_<name>;                 → image input
//   uniform sampler2D t_prev;                   → its own previous frame (feedback)
//   uniform float p_<name>; // min max default  → patchable slider (add "integrate" for p_<name>_t)
//   uniform vec3 p_<name>;  // #rrggbb          → colour
//   uniform int p_<name>;   // One|Two|Three    → dropdown

export const DEFAULT_CODE = `// Your own shader. Declare inputs and sliders right here:
uniform sampler2D t_src;
uniform float p_amount; // 0 1 0.5
uniform float p_speed;  // -2 2 0.5 integrate
uniform vec3 p_tint;    // #33ffcc

vec4 render(vec2 uv) {
  vec2 p = centered(uv);
  float r = length(p);
  float rings = 0.5 + 0.5 * sin(r * 40.0 - p_speed_t * 6.0);
  vec4 src = texture(t_src, uv);
  vec3 col = mix(src.rgb, p_tint * rings, p_amount * (1.0 - src.a * 0.5));
  return vec4(col, 1.0);
}
`;

const DECL = /^\s*uniform\s+(sampler2D|float|vec3|int)\s+([pt])_([A-Za-z][A-Za-z0-9]*)\s*;\s*(?:\/\/\s*(.*))?$/;

const cache = new Map();

export function customDef(code) {
  if (cache.has(code)) return cache.get(code);
  const inputs = [], params = [];
  let feedback = false;
  for (const line of code.split('\n')) {
    const m = line.match(DECL);
    if (!m) continue;
    const [, type, prefix, name, comment = ''] = m;
    if (prefix === 't') {
      if (type !== 'sampler2D') continue;
      if (name === 'prev') feedback = true;
      else inputs.push({ name, label: name });
      continue;
    }
    if (type === 'float') {
      const nums = (comment.match(/-?\d*\.?\d+(?:e-?\d+)?/g) || []).map(Number);
      let [min = 0, max = 1, def] = nums;
      if (!(max > min)) max = min + 1;
      if (def === undefined) def = (min + max) / 2;
      params.push({ name, label: name, min, max, default: Math.min(max, Math.max(min, def)), integrate: /\bintegrate\b/.test(comment) });
    } else if (type === 'vec3') {
      params.push({ name, label: name, type: 'color', default: (comment.match(/#[0-9a-fA-F]{6}/) || ['#ffffff'])[0] });
    } else if (type === 'int') {
      const options = comment.split('|').map((s) => s.trim()).filter(Boolean);
      params.push({ name, label: name, type: 'select', options: options.length ? options : ['0', '1'], default: 0 });
    }
  }
  const def = {
    type: 'glsl',
    title: 'GLSL',
    category: 'custom',
    description: 'Write your own shader — its uniforms become inputs and sliders',
    custom: true,
    inputs,
    params,
    feedback,
    lod: /textureLod/.test(code),
    glsl: code,
  };
  cache.set(code, def);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return def;
}

// Turn any built-in image node into editable GLSL with the same interface.
export function forkToCustom(def) {
  const lines = [`// Forked from ${def.title}`];
  for (const i of def.inputs ?? []) lines.push(`uniform sampler2D t_${i.name};`);
  if (def.feedback) lines.push('uniform sampler2D t_prev;');
  for (const p of def.params ?? []) {
    if (p.type === 'color') lines.push(`uniform vec3 p_${p.name}; // ${p.default}`);
    else if (p.type === 'select') lines.push(`uniform int p_${p.name}; // ${p.options.join(' | ')}`);
    else if (p.type === 'text') continue;
    else lines.push(`uniform float p_${p.name}; // ${p.min} ${p.max} ${p.default}${p.integrate ? ' integrate' : ''}`);
  }
  return `${lines.join('\n')}\n${def.glsl.trim()}\n`;
}
