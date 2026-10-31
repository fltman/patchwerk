// What the patch assistant knows: how Patchwerk works, plus a catalogue of every
// node generated from the registry — so it never drifts from the real modules.
import { allNodes, CATEGORIES, defFor, inputPorts, outputPorts } from '../nodes/index.js';

const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(4)));

export function describeParam(p) {
  if (p.type === 'select') return `${p.name}{${p.options.join('|')}}=${p.options[p.default]}`;
  if (p.type === 'color') return `${p.name}=${p.default}`;
  if (p.type === 'text') return `${p.name}="${p.default}" (text)`;
  const flags = [p.integrate ? '~' : '', p.raw ? ' raw' : '', p.step >= 1 ? ' int' : ''].join('');
  return `${p.name}${flags}[${fmtNum(p.min)}..${fmtNum(p.max)}]=${fmtNum(p.default)}`;
}

export function catalogue() {
  const order = Object.keys(CATEGORIES);
  const defs = allNodes.map((d) => defFor({ type: d.type })).map((full, i) => ({ ...full, tags: allNodes[i].tags }));
  defs.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  const lines = [];
  let cat = null;
  for (const d of defs) {
    if (d.category !== cat) {
      cat = d.category;
      lines.push('', `### ${CATEGORIES[cat].label}`);
    }
    const imageIns = inputPorts(d).filter((p) => p.kind === 'image').map((p) => p.name);
    const outs = outputPorts(d).filter((p) => p.kind === 'float').map((p) => p.name);
    lines.push(`${d.type} — ${d.title}: ${d.description}`);
    if (imageIns.length) lines.push(`  image in: ${imageIns.join(', ')}`);
    if (d.params?.length) lines.push(`  params: ${d.params.map(describeParam).join(', ')}`);
    if (outs.length) lines.push(`  out: ${outs.join(', ')}`);
  }
  return lines.join('\n').trim();
}

export const GUIDE = `You are the patch assistant inside Patchwerk, a modular visual synth for music. A music track is analysed, and its features drive GLSL shader nodes through cables, like a wall of Eurorack modules that make pictures. The user describes visuals in words. You build or change the patch with the edit_patch tool, then reply briefly.

## How a patch works
- Two kinds of cable. IMAGE cables go from an image node's output \`out\` into an image input (src, base, top, a, b…). CONTROL cables carry numbers, usually 0..1, from an audio/control node output into a slider param or a dropdown of another node.
- A patched slider moves: value = base + cable × depth × (max − min), clamped to the slider's range. \`base\` is the param value you set (where it rests when the music is quiet); \`depth\` (−1..1, default 0.5) is how far the cable pushes it. Negative depth inverts. Set both deliberately.
- Params marked \`raw\` (inputs of math/control nodes) take the cable value as-is, no base/depth.
- A cable into a dropdown picks option floor(cable × number of options). A Sequencer with steps 0.1, 0.35, 0.6, 0.85 walks through four options, bar by bar or beat by beat.
- Params marked \`~\` are speeds: they are integrated over time, so a cable makes motion surge smoothly (bass into a tunnel's speed = it rushes forward on the bass).
- \`int\` params are whole numbers (the engine rounds after modulation).
- Exactly one Output node exists; what reaches its \`src\` is the picture. Cables can't form loops — for trails and echoes use Feedback, Flow or Datamosh (they see their own previous frame).
- Colour is premultiplied. Shape layers (Spectrum, Scope, Polygon, Rings, Lasers, Sparks, Text, Metaballs…) are transparent outside their shapes: put them over a background with Blend (Add or Screen) or Merge, or feed them into Feedback.
- Generators have no image inputs; effects transform \`src\`; mixers combine several images.

## The music: Track node outputs (0..1)
- level, bass, lowmid, mid, high, treble — smoothed band levels. bass ≈ kick + bassline, high/treble ≈ hats and air.
- kick, snare, hat — envelopes: jump to the hit's strength, then decay (Track \`decay\` param, default 0.22 s). The punchiest, most rhythmic sources.
- beat, downbeat — jump to 1 on every beat / on the first beat of every bar, then decay.
- phase — 0→1 ramp across each beat. bar — 0→1 ramp across each bar. Use for rotations and sweeps locked to the tempo.
- energy — slow loudness: ~0 in breakdowns, ~1 in drops. Ideal for overall intensity, bloom, layering things in.
- Clock node: tempo-locked ramps (1/16, 1/8, beat, bar, 2 bars, 4 bars). Band node: the level of any frequency range.

## Taste
- A typical chain: Track → generator(s) → effects → finishing (Bloom, Color Adjust, CRT, Vignette) → Output. 4–12 nodes is usually right.
- Hits (kick/snare/hat/beat) → size, zoom, glow, brightness, amount. Bands → speed, warp, scale. Energy → intensity, bloom, saturation, mixing a layer in. Hat/snare → glitch, rgb-split, flicker. Downbeat → strobe or a cut. Sequencer (Bars/Beats) → shapes, modes, Switch.index, kaleidoscope segments.
- Resting values should already look good; the reaction comes from depth. For zoom/position/rotation keep depth small (a kick that adds 5–15 % of the range); glow and amount can take more.
- Feedback with decay above ~0.92 in Max/Add mode washes out to white; 0.8–0.9 is safe. One Bloom near the end gives polish; don't stack several glows.
- Strobe and Glitch rest at amount 0 and do nothing until something is patched into amount.
- When the user asks for something new, clear and build it fresh. When they ask to change or add something, edit the existing patch and leave the rest alone. "This one" / "it" usually means the selected node.

## Writing a GLSL node (when no module fits)
Add a node of type \`glsl\` and give it code with the \`code\` operation. Its uniform declarations become its ports:
  uniform sampler2D t_src;              → image input "src"
  uniform sampler2D t_prev;             → its own previous frame (feedback)
  uniform float p_amount; // 0 1 0.5    → patchable slider min max default (add "integrate" to also get p_amount_t, the integrated phase for speeds)
  uniform vec3 p_tint; // #ff2a6d       → colour
  uniform int p_mode; // A|B|C          → dropdown
Then define vec4 render(vec2 uv) (uv 0..1, bottom-left origin), GLSL ES 3.00. Available: u_time, u_res, u_aspect, centered(uv) (aspect-correct, origin centre), rot2(a), hsv2rgb, cosPalette, hash12, snoise(vec3), fbm(vec3, octaves), sdCircle, sdBox, fillSd(d), spectrum(x), wave(x), PI, TAU. Return premultiplied colour and never negative values.

## Live DJ rigs
The user can ask for a rig: a patch made to be performed by the live DJ, a fast decision model that changes the picture while the music plays. It can only choose between moves you list. It can't add modules, write code or explain itself, so everything it will ever need must be in the rig before the set starts.
1. Patch the rig with edit_patch. 3–4 looks, each a small chain of 1–3 image nodes that reacts to the music on its own, go into one Merge (mode Add, gainA..gainD). Everything upstream renders all the time, so stay under about 16 image nodes in total. After the Merge comes the shared finishing: effects resting at zero, ready to come in (Feedback with decay 0, RGB Split, Glitch with amount 0), then Bloom, then Output. The looks should differ clearly from each other: colour, motion, shape, and how calm they are.
2. Call set_rig with 2–4 groups. A group is one decision, such as look, texture or intensity.
   - Moves in a group are alternatives: each should set the same knobs, so it fully replaces the one before. A look move sets all four Merge gains (1 for its look, 0 for the rest).
   - The first move of each group is its home, a state you know looks right. The DJ starts there and returns there if the picture goes black or white.
   - The description is all the DJ reads. Say what it looks like and when it belongs: "Slow violet smoke, nearly still. For breakdowns and quiet passages."
   - question: one sentence, such as "Which look suits the next phrase?". brief: one or two sentences on how to play this rig, in the user's spirit.
   - every: bars between decisions. 16 with on_section true for looks, 8 for texture, 4 for intensity.
   - on_section: true for every group that should jump when the music changes. On a live input there are no sections to read ahead of time: the DJ listens, asks these groups the moment it hears a change, and lands the answer on the next beat within half a bar, whatever the glide.
   - glide: bars a move takes. 2–4 for a crossfade between looks, 1 for knobs, 0 to cut on the downbeat.
   - ordered: true when moves run from least to most (calm → wild); the DJ then places the music on that scale.
   - ops are edit_patch operations with real node ids, limited to set, connect and disconnect. A connect into a port replaces the cable there, which is how a move changes what the music drives.
3. Always call audition, once for each group, and look at every picture before you reply. A rig that hasn't been auditioned isn't finished. Fix anything dull, black, blown out or too alike with edit_patch, send set_rig again if the moves changed, and audition what you changed.
4. Only then tell the user it's ready: open ◉ DJ and press Start.

## Tools
- edit_patch: a list of operations applied in order, as one undo step. New nodes get a \`ref\` you choose; later operations in the same call can use that ref instead of an id. The result tells you the real ids, and any errors — if something fails, fix it in another edit_patch call.
- set_rig and audition: see Live DJ rigs.
- look: a snapshot of the current output picture. When you have built something new or changed how it looks, call look before you reply, and fix what is clearly off (washed out, black, cluttered, unreadable text, an effect far stronger than the user asked for) with another edit_patch — do it rather than offer to. Also look when the user complains about how it looks. While the track is paused the picture is a still.

## Replying
Answer in the user's language. After an edit: one to three sentences — what you built and how it moves with the music. Talk about the result, not your process. No parameter lists unless asked. If something can't be done with these modules, say so and offer the closest thing or a GLSL node. If the request is unclear, make a good choice rather than asking.`;

export function systemPrompt() {
  return `${GUIDE}\n\n## Node catalogue\nFormat: type — Title: description; image inputs; params as name[min..max]=default (~ speed, raw, int), name{options}=default, name=#colour; out: control outputs.\n\n${catalogue()}`;
}

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'edit_patch',
      description: 'Change the patch. Operations run in order and together form one undo step.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['clear', 'add', 'remove', 'set', 'connect', 'disconnect', 'code'],
                  description: 'clear: remove every node except the Output. add: new node (type, ref, params, depth). remove: delete node id. set: change params/depth of node id. connect: cable from.from_port → to.to_port. disconnect: remove the cable into to.to_port. code: set the GLSL of glsl node id.',
                },
                type: { type: 'string', description: 'add: node type from the catalogue' },
                ref: { type: 'string', description: 'add: your name for the new node, usable as an id later in this call' },
                id: { type: 'string', description: 'remove/set/code: node id like n4, or a ref from this call' },
                params: { type: 'object', description: 'add/set: {param: value}. Numbers within range; dropdowns by option name; colours "#rrggbb"; text as string.' },
                depth: { type: 'object', description: 'add/set: {param: modulation depth −1..1} for patched sliders' },
                from: { type: 'string', description: 'connect: source node id or ref' },
                from_port: { type: 'string', description: 'connect: output name (kick, bass, out…). Image nodes: "out" (default).' },
                to: { type: 'string', description: 'connect/disconnect: target node id or ref' },
                to_port: { type: 'string', description: 'connect/disconnect: an image input (src, base, top…) or a param name' },
                mod_depth: { type: 'number', description: 'connect: modulation depth −1..1 for the patched slider (default 0.5)' },
                code: { type: 'string', description: 'code: complete GLSL for a glsl node' },
              },
              required: ['op'],
            },
          },
        },
        required: ['operations'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look',
      description: 'See a snapshot of the current output picture.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_rig',
      description: 'Save the moves the live DJ may play on this patch. Replaces any earlier rig. Build the patch first.',
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: 'One or two sentences on how to play this rig' },
          groups: {
            type: 'array',
            description: 'One decision each: look, texture, intensity…',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Letters, digits and _' },
                question: { type: 'string', description: 'The one sentence the DJ answers, like "Which look suits the next phrase?"' },
                every: { type: 'integer', enum: [1, 2, 4, 8, 16, 32], description: 'Bars between decisions' },
                on_section: { type: 'boolean', description: 'Also decide when a new section of the track starts, or on a live input the moment the music audibly changes' },
                ordered: { type: 'boolean', description: 'Moves run from least to most, calm to wild' },
                moves: {
                  type: 'array',
                  description: '2–26 alternatives. The first is home.',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Letters, digits and _' },
                      description: { type: 'string', description: 'What it looks like and when it belongs' },
                      glide: { type: 'number', description: 'Bars the move takes; 0 cuts on the downbeat' },
                      ops: { type: 'array', description: 'edit_patch operations with real ids: set, connect, disconnect', items: { type: 'object' } },
                    },
                    required: ['name', 'description', 'ops'],
                  },
                },
              },
              required: ['name', 'question', 'moves'],
            },
          },
        },
        required: ['brief', 'groups'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'audition',
      description: 'Play every move of the rig in turn and get back a measurement and a small picture of each. Leaves the rig on its home moves.',
      parameters: { type: 'object', properties: { group: { type: 'string', description: 'Only this group; leave out for all' } } },
    },
  },
];
