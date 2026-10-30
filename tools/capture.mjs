// Frame-exact video capture of Patchwerk, synced to a track.
//
//   node tools/capture.mjs <shots.json> [only-shot-name]
//
// Every frame is rendered at an exact song time t (the app runs in ?capture mode,
// no live loop), screenshotted, and piped to ffmpeg — so the visuals in a clip
// react to exactly the music at [t0, t0 + duration]. Clips have no audio; lay the
// same stretch of the song under them when editing.
//
// shots.json:
// {
//   "track": "/video/born.mp3",              // URL the app can fetch (served from the project root)
//   "fps": 30, "viewport": [1600, 900], "scale": 1.2,  // → 1920×1080 frames
//   "out": "video/clips",
//   "shots": [{
//     "name": "01-hero",
//     "t0": 61.7, "duration": 5.1,            // song seconds
//     "warmup": 2,                             // seconds rendered before t0, not saved (trails settle)
//     "patch": { "preset": "Acid tunnel" } | { "file": "video/x.json" } | { "chat": "video/chat.json", "state": "start" | "end" },
//     "view": "output" | "app",                // output = the picture alone, fullscreen
//     "resolution": "1920x1080",               // render resolution of the patch
//     "chat": true,                            // app view with the AI panel open
//     "camera": { "nodes": ["n3", "n4"] } | { "all": true } | { "x": 0, "y": 0, "zoom": 1 },
//     "setup": "js run in the page after the patch loads",
//     "events": [
//       { "at": 0.4, "type": "jag tänker mig en rymdresa", "cps": 18 },          // types into the chat box
//       { "at": 2.0, "chatStep": 0 },  { "at": 2.3, "chatThinking": true },     // replay recorded chat steps
//                                       (recording: the shot's {"chat": …} patch, or "chatFile" on the shot/event)
//       { "at": 1.0, "drag": ["css selector from", "css selector to"], "dur": 1.2 },
//       { "at": 0.0, "camera": { "nodes": ["n5"] }, "dur": 2.5 },              // smooth camera move
//       { "at": 3.0, "js": "window.patchwerk.editor.select('n4')" }
//     ]
//   }]
// }
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [specPath, only] = process.argv.slice(2);
if (!specPath) { console.error('usage: node tools/capture.mjs <shots.json> [shot-name]'); process.exit(1); }
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const FPS = spec.fps ?? 30;
const [VW, VH] = spec.viewport ?? [1600, 900];
const SCALE = spec.scale ?? 1.2;
const OUT = spec.out ?? 'video/clips';
mkdirSync(OUT, { recursive: true });

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const chats = new Map();
const loadChat = (p) => { if (!chats.has(p)) chats.set(p, JSON.parse(readFileSync(p, 'utf8'))); return chats.get(p); };

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
try {
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: SCALE });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${PORT}/?capture`);
  await page.waitForFunction(() => window.patchwerk?.capture);
  await page.evaluate(() => localStorage.clear());
  console.log('loading track…');
  await page.evaluate(([url]) => window.patchwerk.capture.loadTrackUrl(url), [spec.track]);
  await page.waitForFunction(() => window.patchwerk.transport.reader);
  const info = await page.evaluate(() => {
    const a = window.patchwerk.transport.reader.analysis;
    return { bpm: a.bpm, duration: a.duration };
  });
  console.log(`track: ${info.bpm.toFixed(2)} BPM, ${info.duration.toFixed(1)} s`);

  for (const shot of spec.shots) {
    if (only && shot.name !== only) continue;
    const t0 = performance.now();
    // ── set the scene ──
    let chatData = null;
    if (shot.patch?.chat) chatData = loadChat(shot.patch.chat);
    else if (shot.chatFile) chatData = loadChat(shot.chatFile);
    await page.evaluate(async ({ shot, chatData }) => {
      const P = window.patchwerk;
      const C = P.capture;
      C.present(shot.view === 'output');
      C.setTab(shot.tab ?? 'graph');
      C.setResolution(shot.resolution ?? (shot.view === 'output' ? '1920x1080' : '1280x720'));
      P.chat.toggle(!!shot.chat);
      P.chat.reset();
      P.chat.log.replaceChildren();
      P.chat.input.value = '';
      if (shot.patch?.preset) C.loadPreset(shot.patch.preset);
      else if (shot.patch?.json) C.loadPatch(shot.patch.json);
      else if (chatData) C.loadPatch(shot.patch.state === 'end' ? chatData.steps.filter((s) => s.patch).at(-1).patch : chatData.startPatch);
      P.editor.select(null);
      if (shot.setup) (0, eval)(shot.setup);
    }, { shot: { ...shot, patch: shot.patch?.file ? { json: JSON.parse(readFileSync(shot.patch.file, 'utf8')) } : shot.patch }, chatData });
    await page.waitForTimeout(150); // layout settles (node sizes are measured a frame later)
    if (shot.camera) await setCamera(page, shot.camera, 1);

    // ── warm-up frames: feedback trails and smoothing settle, nothing saved ──
    const warm = Math.round((shot.warmup ?? 2) * FPS);
    for (let i = warm; i > 0; i--) await page.evaluate(([t, fps]) => window.patchwerk.capture.frame(t, fps), [shot.t0 - i / FPS, FPS]);

    // ── record ──
    const file = `${OUT}/${shot.name}.mp4`;
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-vf', 'scale=1920:1080:flags=lanczos', file],
    { stdio: ['pipe', 'inherit', 'inherit'] });
    const n = Math.round(shot.duration * FPS);
    const events = (shot.events ?? []).map((e) => ({ ...e, frame: Math.round(e.at * FPS) }));
    const tweens = [];
    let mouseDown = null;
    for (let i = 0; i < n; i++) {
      const st = i / FPS;
      for (const e of events) {
        if (e.frame !== i) continue;
        if (e.js) await page.evaluate((code) => (0, eval)(code), e.js);
        if (e.camera) tweens.push({ kind: 'camera', start: i, frames: Math.max(1, Math.round((e.dur ?? 1.5) * FPS)), from: await page.evaluate(() => ({ ...window.patchwerk.editor.view })), to: await targetView(page, e.camera) });
        if (e.type !== undefined) tweens.push({ kind: 'type', start: i, text: e.type, frames: Math.max(1, Math.round((e.type.length / (e.cps ?? 18)) * FPS)) });
        if (e.drag) {
          const [a, b] = await Promise.all(e.drag.map((sel) => page.locator(sel).first().boundingBox()));
          const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 }, to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          mouseDown = true;
          tweens.push({ kind: 'drag', start: i, frames: Math.max(2, Math.round((e.dur ?? 1) * FPS)), from, to });
        }
        if (e.chatStep !== undefined && e.chatFile) chatData = loadChat(e.chatFile);
        if (e.chatStep !== undefined && !chatData) throw new Error(`shot ${shot.name}: chatStep needs a recording — set "chatFile" on the shot or the event`);
        if (e.chatStep !== undefined) await page.evaluate(([step]) => replayStep(step), [chatData.steps[e.chatStep]]).catch(async () => {
          await page.evaluate(installReplay);
          await page.evaluate(([step]) => replayStep(step), [chatData.steps[e.chatStep]]);
        });
        if (e.chatThinking !== undefined) {
          await page.evaluate(installReplay);
          await page.evaluate((on) => replayThinking(on), e.chatThinking);
        }
      }
      for (const tw of [...tweens]) {
        const k = Math.min(1, (i - tw.start + 1) / tw.frames);
        if (tw.kind === 'camera') {
          const e = ease(k);
          await page.evaluate((v) => { const ed = window.patchwerk.editor; ed.view = v; ed.applyView(); },
            { x: tw.from.x + (tw.to.x - tw.from.x) * e, y: tw.from.y + (tw.to.y - tw.from.y) * e, zoom: tw.from.zoom + (tw.to.zoom - tw.from.zoom) * e });
        } else if (tw.kind === 'type') {
          await page.evaluate(([text]) => { window.patchwerk.chat.input.value = text; }, [tw.text.slice(0, Math.round(tw.text.length * k))]);
        } else if (tw.kind === 'drag') {
          const e = ease(k);
          await page.mouse.move(tw.from.x + (tw.to.x - tw.from.x) * e, tw.from.y + (tw.to.y - tw.from.y) * e);
          if (k >= 1 && mouseDown) { await page.mouse.up(); mouseDown = null; }
        }
        if (k >= 1) tweens.splice(tweens.indexOf(tw), 1);
      }
      await page.evaluate(([t, fps]) => { window.patchwerk.capture.frame(t, fps); if (window.replayTick) window.replayTick(); }, [shot.t0 + st, FPS]);
      ff.stdin.write(await page.screenshot({ type: 'jpeg', quality: 93 }));
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    writeFileSync(`${OUT}/${shot.name}.json`, JSON.stringify({ name: shot.name, t0: shot.t0, duration: n / FPS, fps: FPS }, null, 2));
    console.log(`✓ ${file}  ${(n / FPS).toFixed(2)} s  (song ${shot.t0.toFixed(2)}–${(shot.t0 + n / FPS).toFixed(2)})  in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
} finally {
  await browser.close();
  server.kill();
}

async function targetView(page, cam) {
  return page.evaluate((cam) => {
    const ed = window.patchwerk.editor;
    if (cam.zoom !== undefined && cam.x !== undefined) return { x: cam.x, y: cam.y, zoom: cam.zoom };
    const saved = { ...ed.view };
    const ids = cam.all ? null : new Set(cam.nodes);
    // frame the chosen nodes the same way "frame all" does, then restore
    const all = ed.graph.nodes;
    const keep = new Map(all);
    if (ids) for (const id of [...all.keys()]) if (!ids.has(id)) all.delete(id);
    ed.frameAll();
    if (ids) { all.clear(); for (const [k, v] of keep) all.set(k, v); }
    const v = { ...ed.view };
    if (cam.zoomBy) { const r = ed.root.getBoundingClientRect(); const cx = (r.width - (ed.insetRight ?? 0)) / 2, cy = r.height / 2; v.x = cx - (cx - v.x) * cam.zoomBy; v.y = cy - (cy - v.y) * cam.zoomBy; v.zoom *= cam.zoomBy; }
    ed.view = saved;
    ed.applyView();
    return v;
  }, cam);
}

async function setCamera(page, cam) {
  const v = await targetView(page, cam);
  await page.evaluate((v) => { const ed = window.patchwerk.editor; ed.view = v; ed.applyView(); }, v);
}

// Installed in the page: replays a recorded assistant conversation step by step.
function installReplay() {
  if (window.replayStep) return;
  let thinking = null, dots = 0;
  window.replayThinking = (on) => {
    thinking?.remove();
    thinking = null;
    if (!on) return;
    thinking = document.createElement('div');
    thinking.className = 'chat-status';
    thinking.textContent = 'Thinking…';
    window.patchwerk.chat.log.append(thinking);
    window.patchwerk.chat.scroll();
  };
  window.replayTick = () => { if (thinking) thinking.textContent = 'Thinking' + '.'.repeat(1 + (Math.floor(dots++ / 8) % 3)); };
  window.replayStep = (step) => {
    const P = window.patchwerk;
    window.replayThinking(false);
    if (step.kind === 'user') P.chat.input.value = '';
    if (step.patch) {
      P.graph.load(step.patch);
      P.graph.commit();
      P.editor.frameAll();
    }
    const { patch, ...item } = step;
    P.chat.add(item);
  };
}
