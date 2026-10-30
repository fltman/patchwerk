// Node registry: every node type, keyed by `type`.
import generators from './generators.js';
import effects from './effects.js';
import mix from './mix.js';
import control from './control.js';
import special from './special.js';
import { customDef, DEFAULT_CODE } from './custom.js';

export const CATEGORIES = {
  audio: { label: 'Audio', badge: 'AUDIO', color: '#ff9f1c' },
  control: { label: 'Control', badge: 'CV', color: '#3a86ff' },
  generator: { label: 'Generators', badge: 'GEN', color: '#2bb673' },
  effect: { label: 'Effects', badge: 'FX', color: '#9b5de5' },
  mix: { label: 'Mix', badge: 'MIX', color: '#00a6c8' },
  custom: { label: 'Code', badge: 'GLSL', color: '#f15bb5' },
  output: { label: 'Output', badge: 'OUT', color: '#e63946' },
};

// image nodes the shader check compiles (custom GLSL is checked through its default code)
export const imageNodes = [...generators, ...effects, ...mix, ...special, customDef(DEFAULT_CODE)];

const glslStub = { type: 'glsl', title: 'GLSL', category: 'custom', description: customDef(DEFAULT_CODE).description, tags: ['code', 'shader', 'custom', 'write'] };
export const allNodes = [...control, ...generators, ...effects, ...mix, ...special, glslStub];
const byType = new Map(allNodes.map((d) => [d.type, d]));

export function getDef(type) { return byType.get(type); }

// The definition for a placed node (custom GLSL nodes carry their own code).
export function defFor(node) {
  if (node.type === 'glsl') return customDef(node.code ?? DEFAULT_CODE);
  return byType.get(node.type);
}

export const isImage = (def) => !!def && typeof def.glsl === 'string';
export const isFloatParam = (p) => !p.type || p.type === 'float';
// float params and dropdowns take control cables
export const isPatchable = (p) => isFloatParam(p) || p.type === 'select';

export function inputPorts(def) {
  if (!def) return [];
  return [
    ...(def.inputs ?? []).map((i) => ({ name: i.name, label: i.label ?? i.name, kind: 'image' })),
    ...(def.params ?? []).filter(isPatchable).map((p) => ({ name: p.name, label: p.label ?? p.name, kind: 'float', param: p })),
  ];
}

export function outputPorts(def) {
  if (!def || def.category === 'output') return [];
  if (isImage(def)) return [{ name: 'out', label: 'Image', kind: 'image' }];
  return (def.outputs ?? []).map((o) => ({ name: o.name, label: o.label ?? o.name, kind: 'float' }));
}

export { DEFAULT_CODE };
