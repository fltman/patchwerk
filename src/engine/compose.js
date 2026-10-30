// Turns an image-node definition into a complete fragment shader.
import { PRELUDE } from './prelude.js';

export function glslType(param) {
  if (param.type === 'color') return 'vec3';
  if (param.type === 'select') return 'int';
  return 'float';
}

// Lines in the node body are numbered from 1 (via #line) so compiler
// errors point straight into the code shown in the GLSL tab.
// Custom GLSL nodes declare their own uniforms in the body; only the
// accumulated `p_<name>_t` phases are added for them.
export function composeFragment(def, body = def.glsl) {
  const decl = [];
  const declared = (name) => new RegExp(`uniform\\s+float\\s+${name}\\s*;`).test(body);
  if (!def.custom) {
    for (const input of def.inputs ?? []) decl.push(`uniform sampler2D t_${input.name};`);
    for (const s of def.samplers ?? []) decl.push(`uniform sampler2D t_${s};`);
    if (def.feedback) decl.push('uniform sampler2D t_prev;');
  }
  for (const p of def.params ?? []) {
    if (p.type === 'text') continue;
    if (!def.custom) decl.push(`uniform ${glslType(p)} p_${p.name};`);
    if (p.integrate && !(def.custom && declared(`p_${p.name}_t`))) decl.push(`uniform float p_${p.name}_t;`);
  }
  return [
    PRELUDE,
    `// ── node: ${def.title} ──`,
    ...decl,
    '#line 1',
    body.replace(/\s+$/, ''), // keep leading lines so error line numbers match the editor
    '',
    'void main() { fragColor = render(v_uv); }',
    '',
  ].join('\n');
}

// Parses "ERROR: 0:12: 'foo' : undeclared identifier" into {line, message}.
export function parseShaderLog(log) {
  return String(log || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/);
      return m ? { line: Number(m[1]), message: m[2] } : { line: 0, message: l };
    });
}
