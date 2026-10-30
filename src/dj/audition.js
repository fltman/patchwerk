// Tries every move of a rig, instantly, so the assistant can see and measure each
// one before a set. Leaves the rig on its home moves.
const SETTLE_FRAMES = 24; // feedback and trails need a moment
const frames = (n) => new Promise((done) => {
  const step = () => (n-- > 0 ? requestAnimationFrame(step) : done());
  step();
});

export async function audition({ dj, renderer, transport, group, width = 320 }) {
  const rig = dj.rig;
  if (!rig) return { lines: ['This patch has no rig yet.'], images: [] };
  if (dj.running) dj.stop();
  const groups = rig.groups.filter((g) => !group || g.name === group);
  if (!groups.length) return { lines: [`No group "${group}" (groups: ${rig.groups.map((g) => g.name).join(', ')})`], images: [] };

  // paused: look at the loudest part of the track, not wherever the playhead was left
  const back = transport.playing ? null : transport.time;
  const loud = transport.reader?.analysis.sections?.reduce((a, b) => (b.energy > a.energy ? b : a));
  if (back !== null && loud) transport.seek(loud.start + 2 * transport.reader.period);

  const lines = [], images = [];
  try {
    for (const g of groups) {
      for (const m of g.moves) {
        dj.fire(g, m, { by: 'audition', bars: 0 });
        await frames(SETTLE_FRAMES);
        const url = await renderer.snapshot(width);
        const p = dj.picture;
        const warn = !p ? '' : p.brightness < 0.03 ? '  ⚠ nearly black' : p.brightness > 0.8 ? '  ⚠ nearly white' : '';
        lines.push(`image ${images.length + 1}: ${g.name}/${m.name}${p ? ` — brightness ${p.brightness}, saturation ${p.saturation}, motion ${p.motion}` : ''}${warn}`);
        images.push(url);
      }
    }
  } finally {
    for (const g of rig.groups) dj.fire(g, g.moves[0], { by: 'audition', bars: 0 });
    if (back !== null) transport.seek(back);
    dj.update();
  }
  return { lines, images };
}
