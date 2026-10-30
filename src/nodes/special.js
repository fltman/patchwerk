// Nodes the engine treats a little specially: the Output, and Text (drawn on a 2D canvas).

export default [
  {
    type: 'output',
    title: 'Output',
    category: 'output',
    description: 'What the preview, fullscreen and recording show',
    inputs: [{ name: 'src', label: 'Image' }],
    params: [
      { name: 'brightness', label: 'Brightness', min: 0, max: 2, default: 1 },
      { name: 'fade', label: 'Fade out', min: 0, max: 1, default: 0 },
    ],
    glsl: `
vec4 render(vec2 uv) {
  vec3 c = texture(t_src, uv).rgb * p_brightness * (1.0 - p_fade);
  return vec4(clamp(c, 0.0, 1.0), 1.0);
}`,
  },
  {
    type: 'text',
    title: 'Text',
    category: 'generator',
    description: 'A word or a title, with glow',
    tags: ['type', 'title', 'font', 'words', 'letters'],
    samplers: ['canvas'],
    params: [
      { name: 'text', label: 'Text', type: 'text', default: 'PATCHWERK' },
      { name: 'font', label: 'Font', type: 'select', options: ['Sans', 'Mono', 'Serif', 'Condensed'], default: 0 },
      { name: 'size', label: 'Size', min: 0.1, max: 3, default: 1 },
      { name: 'x', label: 'X', min: -1, max: 1, default: 0 },
      { name: 'y', label: 'Y', min: -1, max: 1, default: 0 },
      { name: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { name: 'glow', label: 'Glow', min: 0, max: 3, default: 0.6 },
    ],
    // Drawn once per change of the non-float params, white on transparent, then
    // positioned / scaled / glowed on the GPU so those params stay patchable.
    canvas: {
      keys: ['text', 'font'],
      draw(c, w, h, p) {
        const fonts = ['800 {s}px Inter, Helvetica, Arial, sans-serif', '700 {s}px "SF Mono", Menlo, monospace',
          '700 {s}px Georgia, "Times New Roman", serif', '800 {s}px "Arial Narrow", "Helvetica Neue", sans-serif'];
        c.clearRect(0, 0, w, h);
        const lines = String(p.text || '').split('\\n');
        let size = h * 0.22;
        c.font = fonts[p.font].replace('{s}', size);
        const widest = Math.max(1, ...lines.map((l) => c.measureText(l).width));
        if (widest > w * 0.9) size *= (w * 0.9) / widest;
        c.font = fonts[p.font].replace('{s}', size);
        c.fillStyle = '#fff';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        lines.forEach((l, i) => c.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.05));
      },
    },
    glsl: `
vec4 render(vec2 uv) {
  vec2 p = centered(uv) - vec2(p_x * u_aspect, p_y) * 0.5;
  vec2 s = uncenter(p / p_size);
  float a = texBorder(t_canvas, s).a;
  float g = 0.0;
  if (p_glow > 0.0) {
    g = textureLod(t_canvas, s, 3.0).a * 0.5 + textureLod(t_canvas, s, 5.0).a * 0.8 + textureLod(t_canvas, s, 6.5).a;
    g *= p_glow * 0.6;
  }
  float cover = clamp(a + g, 0.0, 1.0);
  return vec4(p_color * (a + g), cover);
}`,
  },
];
