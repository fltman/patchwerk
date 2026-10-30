// Boot: wires the patch, the editor, the renderer and the transport together.
import { Graph } from './graph/graph.js';
import { Editor } from './graph/editor.js';
import { AddMenu } from './graph/menu.js';
import { Renderer } from './engine/renderer.js';
import { Transport } from './audio/transport.js';
import { renderDemoTrack } from './audio/demoTrack.js';
import { CodePanel } from './ui/code.js';
import { saveTrack, loadTrack } from './ui/storage.js';
import { PRESETS } from './presets.js';
import { isImage } from './nodes/index.js';
import { Chat } from './ai/chat.js';
import { Outputs } from './ui/outputs.js';

const $ = (id) => document.getElementById(id);
const PATCH_KEY = 'patchwerk.patch.v1';

const graph = new Graph();
const menu = new AddMenu(document.body);
const editor = new Editor($('graph'), graph, menu);
const renderer = new Renderer($('out'), graph);
const transport = new Transport();
const code = new CodePanel(graph, renderer, editor);
window.patchwerk = { graph, editor, renderer, transport }; // handy in the console

// ── toast & busy ────────────────────────────────────────
let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function busy(text, progress) {
  $('busy').classList.toggle('hidden', text === null);
  if (text !== null) {
    $('busy-text').textContent = text;
    $('busy-bar').style.width = `${Math.round((progress ?? 0) * 100)}%`;
  }
}
editor.addEventListener('message', (e) => toast(e.detail.text));
const chat = new Chat({ graph, editor, renderer, transport, toast });
document.getElementById('ai-btn').onclick = () => chat.toggle();
window.patchwerk.chat = chat;

// ── patch persistence ───────────────────────────────────
function loadPatch(json) {
  graph.load(json);
  graph.commit();
  requestAnimationFrame(() => editor.frameAll());
}
let saveTimer;
graph.addEventListener('commit', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem(PATCH_KEY, JSON.stringify(graph.toJSON())), 300);
});

PRESETS.forEach((p, i) => $('examples').append(new Option(p.name, i)));
$('examples').prepend(new Option('Load an example…', ''));
$('examples').value = '';
$('examples').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value];
  if (p) { loadPatch(structuredClone(p.patch)); toast(`Loaded “${p.name}” — ⌘Z to go back`); }
  e.target.value = '';
});

$('undo').onclick = () => graph.undo();
$('redo').onclick = () => graph.redo();
$('save').onclick = () => {
  const blob = new Blob([JSON.stringify(graph.toJSON(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `patchwerk-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('open').onclick = () => $('open-file').click();
$('open-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { loadPatch(JSON.parse(await f.text())); toast(`Opened ${f.name}`); } catch (err) { toast(`Couldn't open that: ${err.message}`); }
  e.target.value = '';
};

// ── tabs & code panel ───────────────────────────────────
let tab = 'graph';
function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('code').classList.toggle('hidden', t !== 'code');
  if (t === 'code') code.show([...editor.selected][0] ?? null);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
editor.addEventListener('open-code', (e) => { editor.select(e.detail.id); setTab('code'); });
editor.addEventListener('select', (e) => { if (tab === 'code') code.show(e.detail.ids[0] ?? null); });
$('add-btn').onclick = () => {
  setTab('graph');
  const r = $('graph').getBoundingClientRect();
  editor.openAdd(r.left + r.width / 2 - 170, r.top + 80);
};

// ── transport ───────────────────────────────────────────
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
async function useTrack(name, getBuffer, remember) {
  busy(`Decoding ${name}…`, 0);
  try {
    const data = await getBuffer();
    if (data instanceof AudioBuffer) await transport.setBuffer(data, name, (p) => busy(`Analysing ${name}…`, p));
    else {
      await transport.load(data.slice(0), name, (p) => busy(`Analysing ${name}…`, p));
      if (remember) saveTrack(name, data).catch(() => {});
    }
    const a = transport.reader.analysis;
    toast(`${name}: ${a.bpm.toFixed(1)} BPM, ${a.onsets.kick.times.length} kicks, ${fmtTime(a.duration)}`);
  } catch (err) {
    console.error(err);
    toast(`Couldn't load ${name}: ${err.message}`);
  }
  busy(null);
  drawOverview();
}
const loadDemo = () => useTrack('Patchwerk demo — acid loop (130 BPM)', () => renderDemoTrack(), false);
const loadFile = (file) => useTrack(file.name, () => file.arrayBuffer(), true);

$('play').onclick = () => transport.toggle();
$('load').onclick = () => $('load-file').click();
$('load-file').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
$('demo').onclick = loadDemo;
transport.addEventListener('change', () => {
  $('play').textContent = transport.playing ? '❚❚' : '▶';
  $('play').classList.toggle('playing', transport.playing);
  $('track-name').textContent = transport.name || 'No track';
  $('bpm').textContent = transport.reader ? `${transport.reader.analysis.bpm.toFixed(1)} BPM` : '— BPM';
});

// drag & drop a track anywhere
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('drop').classList.remove('hidden'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.add('hidden'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.add('hidden');
  const f = [...e.dataTransfer.files][0];
  if (!f) return;
  if (f.name.endsWith('.json')) f.text().then((t) => loadPatch(JSON.parse(t)));
  else loadFile(f);
});

// ── overview: the whole track, its bars, and where we are ──
const ov = $('overview');
const ovStatic = document.createElement('canvas');
function drawOverview() {
  const dpr = devicePixelRatio || 1;
  ov.width = ovStatic.width = Math.round(ov.clientWidth * dpr);
  ov.height = ovStatic.height = Math.round(ov.clientHeight * dpr);
  const c = ovStatic.getContext('2d');
  const W = ovStatic.width, H = ovStatic.height;
  c.clearRect(0, 0, W, H);
  const r = transport.reader;
  if (!r) return;
  const a = r.analysis;
  for (let x = 0; x < W; x++) {
    const f0 = Math.floor((x / W) * a.frames), f1 = Math.max(f0 + 1, Math.floor(((x + 1) / W) * a.frames));
    let lv = 0, bass = 0, en = 0;
    for (let f = f0; f < f1; f++) { lv = Math.max(lv, a.level[f]); bass = Math.max(bass, a.bands.bass[f]); en += a.energy[f]; }
    en /= f1 - f0;
    const h = lv * (H - 10);
    c.fillStyle = `hsl(${280 - en * 250}, 70%, ${28 + en * 30}%)`;
    c.fillRect(x, (H - h) / 2, 1, h);
    c.fillStyle = 'rgba(255,176,0,0.55)';
    c.fillRect(x, H - 2 - bass * 6, 1, 2);
  }
  a.beats.forEach((t, i) => {
    if ((((i - a.downbeat) % 4) + 4) % 4 !== 0) return;
    const x = Math.round((t / a.duration) * W);
    c.fillStyle = (((i - a.downbeat) / 4) | 0) % 4 === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)';
    c.fillRect(x, 0, 1, 5 * dpr);
  });
}
function drawPlayhead(t) {
  const c = ov.getContext('2d');
  c.clearRect(0, 0, ov.width, ov.height);
  c.drawImage(ovStatic, 0, 0);
  if (!transport.duration) return;
  const x = (t / transport.duration) * ov.width;
  c.fillStyle = '#fff';
  c.fillRect(Math.round(x), 0, 2, ov.height);
}
let seeking = false;
const seekTo = (e) => {
  const r = ov.getBoundingClientRect();
  transport.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * transport.duration);
};
ov.addEventListener('pointerdown', (e) => { seeking = true; ov.setPointerCapture(e.pointerId); seekTo(e); });
ov.addEventListener('pointermove', (e) => { if (seeking) seekTo(e); });
ov.addEventListener('pointerup', () => { seeking = false; });
addEventListener('resize', drawOverview);

// ── meter rack ──────────────────────────────────────────
const METERS = ['bass', 'lowmid', 'mid', 'high', 'treble', 'level', 'kick', 'snare', 'hat', 'beat', 'downbeat', 'phase', 'bar', 'energy'];
const meterEls = METERS.map((name) => {
  const m = document.createElement('div');
  m.className = `meter-v${['phase', 'bar', 'beat', 'downbeat'].includes(name) ? ' clock' : ''}`;
  m.innerHTML = '<div class="bar"><i></i></div><span></span>';
  m.querySelector('span').textContent = name;
  $('meters').append(m);
  return m.querySelector('i');
});

// ── settings ────────────────────────────────────────────
function setResolution(value) {
  const [w, h] = value.split('x').map(Number);
  renderer.setResolution(w, h);
  document.documentElement.style.setProperty('--aspect', `${w} / ${h}`);
  $('preview').style.aspectRatio = `${w} / ${h}`;
  $('preview').style.maxHeight = h > w ? '60vh' : '';
  localStorage.setItem('patchwerk.res', value);
}
$('resolution').value = localStorage.getItem('patchwerk.res') || '1280x720';
setResolution($('resolution').value);
$('resolution').onchange = (e) => setResolution(e.target.value);
$('thumbs').onchange = (e) => { editor.thumbsOn = e.target.checked; $('graph').classList.toggle('thumbs-off', !e.target.checked); };

$('fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('preview').requestFullscreen());
$('preview').addEventListener('dblclick', () => $('fullscreen').click());

// ── recording: the output canvas + the music, in real time ──
let recorder = null, recStart = 0;
$('rec').onclick = () => {
  if (recorder) { recorder.stop(); return; }
  const stream = new MediaStream([...$('out').captureStream(60).getVideoTracks(), ...transport.recordStream.stream.getAudioTracks()]);
  const type = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 16e6 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `patchwerk-${Date.now()}.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
    a.click();
    recorder = null;
    $('rec').classList.remove('recording');
    $('rec-time').classList.add('hidden');
    toast('Recording saved');
  };
  recorder.start(500);
  recStart = performance.now();
  $('rec').classList.add('recording');
  $('rec-time').classList.remove('hidden');
  if (!transport.playing) transport.play();
};

// ── keyboard ────────────────────────────────────────────
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || menu.isOpen) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); chat.toggle(); }
  else if (e.code === 'Space') { e.preventDefault(); transport.toggle(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? graph.redo() : graph.undo(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSelected(); }
  else if (tab !== 'graph') return;
  else if (e.key === 'Tab') { e.preventDefault(); editor.openAdd(editor.pointer.x, editor.pointer.y); }
  else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); editor.deleteSelected(); }
  else if (e.key === 'f' || e.key === 'F') editor.frameAll();
  else if (e.key === 'Escape') editor.select(null);
});

// ── the loop ────────────────────────────────────────────
let last = performance.now(), lastThumbs = 0, frames = 0, fpsAt = last;
// One frame of everything. `time`/`playing` come from the transport, or from the
// capture tool, which steps through a track frame by frame for perfectly synced video.
function step(now, time, playing, wallDt, everyThumb = false) {
  const visible = tab === 'graph' ? editor.visibleNodes() : [];
  const visibleImage = visible.filter((id) => isImage(graph.def(graph.nodes.get(id))));
  let thumbs = null;
  if (everyThumb || now - lastThumbs > 60) { thumbs = editor.thumbTargets(visibleImage); lastThumbs = now; }
  renderer.frame({
    time, dt: playing ? wallDt : 0, wallDt, playing,
    reader: transport.reader, mono: transport.mono, sampleRate: transport.buffer?.sampleRate ?? 44100,
    visible: editor.thumbsOn ? visibleImage : [], thumbs,
  });
  editor.tick(renderer, visible);
  if (tab === 'code') code.tick();

  if (transport.reader) {
    const f = transport.reader.features(time, 0.2);
    METERS.forEach((k, i) => { meterEls[i].style.height = `${Math.min(1, f[k]) * 100}%`; });
  }
  $('time').textContent = `${fmtTime(time)} / ${fmtTime(transport.duration)}`;
  drawPlayhead(time);
  if (recorder) $('rec-time').textContent = `● ${fmtTime((now - recStart) / 1000)}`;
  frames++;
  if (now - fpsAt > 500) { $('fps').textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps · ${graph.nodes.size} nodes`; frames = 0; fpsAt = now; }
}
function loop(now) {
  const wallDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(now, transport.time, transport.playing, wallDt);
  requestAnimationFrame(loop);
}

window.patchwerk.loadTrackUrl = (url, name) => useTrack(name ?? decodeURIComponent(url.split('/').pop()), () => fetch(url).then((r) => r.arrayBuffer()), false);

// ── capture mode (?capture): no live loop; tools/capture.mjs drives frames ──
const CAPTURE = new URLSearchParams(location.search).has('capture');
if (CAPTURE) {
  document.body.classList.add('capture');
  window.patchwerk.capture = {
    frame(t, fps = 30) {
      step(t * 1000, t, true, 1 / fps, true);
      $('play').textContent = '❚❚';
      $('play').classList.add('playing');
    },
    loadTrackUrl: (url, name) => window.patchwerk.loadTrackUrl(url, name),
    loadPatch: (json) => { graph.load(json); graph.commit(); editor.frameAll(); },
    loadPreset: (name) => { const p = PRESETS.find((x) => x.name === name); graph.load(structuredClone(p.patch)); graph.commit(); editor.frameAll(); },
    present(on) { document.body.classList.toggle('present', on); },
    setTab,
    setResolution: (v) => { $('resolution').value = v; setResolution(v); },
  };
}

// ── boot ────────────────────────────────────────────────
let saved = null;
try { saved = JSON.parse(localStorage.getItem(PATCH_KEY)); } catch { /* ignore */ }
loadPatch(saved?.nodes?.length ? saved : structuredClone(PRESETS[0].patch));
if (!CAPTURE) {
  window.patchwerk.outputs = new Outputs({ renderer, toast });
  requestAnimationFrame(loop);
}
const last_ = CAPTURE ? null : await loadTrack().catch(() => null);
if (last_) await useTrack(last_.name, async () => last_.data, false);
else if (!CAPTURE) await loadDemo();
