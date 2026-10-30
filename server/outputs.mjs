// Outputs: Syphon (macOS), Spout (Windows) and NDI (any machine on the network).
// A web page can't publish video to other apps, so the page streams its finished
// frames here over a WebSocket (/api/out) and this process hands them on.
// A frame is an 8-byte header — uint32 width, uint32 height, little-endian —
// followed by BGRA pixels, top row first: what all three take as they are.
// Each frame is answered with an empty binary message once it has been handed
// on; the page keeps at most two frames unanswered, so a slow consumer slows
// the stream instead of piling frames up inside the browser.
// Every output is optional; one whose native module is missing is not offered.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const NAME = 'Patchwerk';
const SPOUT_DLL = fileURLToPath(new URL('../vendor/spout/SpoutLibrary.dll', import.meta.url));
const GL_BGRA = 0x80e1;
const ACK = Buffer.alloc(0);

// ── Syphon: GPU texture sharing on macOS ────────────────
// Syphon finds servers through Cocoa notifications, which only arrive while the
// main thread's run loop turns. Node never turns it, so we do — otherwise an app
// started after Patchwerk would never see the server.
let pump = null;
function cocoaPump() {
  const koffi = require('koffi');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cfString = cf.func('void* CFStringCreateWithCString(void*, const char*, uint32_t)');
  const runInMode = cf.func('int32_t CFRunLoopRunInMode(void*, double, uint8_t)');
  const mode = cfString(null, 'kCFRunLoopDefaultMode', 0x08000100);
  // returns 4 while it handled something; run until nothing is waiting
  return () => { for (let i = 0; i < 16 && runInMode(mode, 0, 1) === 4; i++); };
}

function openSyphon() {
  const { TextureSender } = require('@napolab/texture-bridge');
  pump ??= cocoaPump();
  const timer = setInterval(pump, 100); // answer apps that look for servers between frames
  let sender = null;
  return {
    send(px, w, h) {
      (sender ??= new TextureSender(NAME, w, h)).sendRgbaBuffer(px, w, h);
      pump();
    },
    close() { clearInterval(timer); sender?.stop(); },
  };
}

// ── Spout: GPU texture sharing on Windows ───────────────
// SpoutLibrary.dll is Spout's C-compatible build: GetSpout() returns an object
// whose methods are called through its vtable. The slot numbers belong to the
// vendored 2.007.018 DLL; vendor/spout/README.md tells how they were checked.
function openSpout() {
  const koffi = require('koffi');
  const self = koffi.load(SPOUT_DLL).func('void* GetSpout()')();
  if (!self) throw new Error('SpoutLibrary did not start');
  const vtable = koffi.decode(self, 'void*');
  const method = (slot, result, args) => {
    const fn = koffi.decode(vtable, slot * 8, 'void*');
    const type = koffi.proto(result, ['void*', ...args]);
    return (...a) => koffi.call(fn, type, self, ...a);
  };
  const setSenderName = method(0, 'void', ['const char*']);
  const releaseSender = method(2, 'void', ['uint32_t']);
  const sendImage = method(5, 'bool', ['const uint8_t*', 'uint32_t', 'uint32_t', 'uint32_t', 'bool']);
  const createOpenGL = method(151, 'bool', ['void*']);
  const closeOpenGL = method(152, 'bool', []);
  const release = method(169, 'void', []);
  if (!createOpenGL(null)) {
    release();
    throw new Error('Spout could not create an OpenGL context');
  }
  setSenderName(NAME);
  return {
    send(px, w, h) {
      if (!sendImage(px, w, h, GL_BGRA, false)) throw new Error('Spout refused the frame');
    },
    close() { releaseSender(0); closeOpenGL(); release(); },
  };
}

// ── NDI: video over the network ─────────────────────────
async function openNdi() {
  const { default: grandi } = await import('grandi');
  const sender = await grandi.send({ name: NAME, clockVideo: false });
  let busy = false;
  return {
    receivers: () => sender.connections(),
    send(px, w, h) {
      // nobody watching, or NDI still encoding the last frame: skip this one
      if (busy || sender.connections() === 0) return;
      busy = true;
      sender.video({
        xres: w, yres: h, frameRateN: 60, frameRateD: 1, pictureAspectRatio: w / h,
        frameFormatType: grandi.FrameType.Progressive, fourCC: grandi.FourCC.BGRX, lineStrideBytes: w * 4, data: px,
      }).catch(() => {}).finally(() => { busy = false; });
    },
    close() { sender.destroy(); },
  };
}

const OUTPUTS = {
  syphon: {
    label: 'Syphon',
    check: () => {
      if (process.platform !== 'darwin') throw new Error('macOS only');
      require('@napolab/texture-bridge');
      require('koffi');
    },
    open: openSyphon,
  },
  spout: {
    label: 'Spout',
    check: () => {
      if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('64-bit Windows only');
      if (!existsSync(SPOUT_DLL)) throw new Error('vendor/spout/SpoutLibrary.dll is missing');
      require('koffi');
    },
    open: openSpout,
  },
  ndi: {
    label: 'NDI',
    check: async () => {
      const { default: grandi } = await import('grandi');
      if (!grandi.isSupportedCPU()) throw new Error('NDI does not run on this CPU');
    },
    open: openNdi,
  },
};

// which outputs this machine can offer — the native modules load once, here
export async function availableOutputs() {
  const ok = [];
  for (const [kind, o] of Object.entries(OUTPUTS)) {
    try { await o.check(); ok.push(kind); } catch { /* not offered */ }
  }
  return ok;
}

// One page drives the outputs it switches on; they close when it goes away.
function session(ws, available) {
  const live = new Map();
  let error = null;
  let queue = Promise.resolve();

  const status = () => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ available, on: [...live.keys()], receivers: live.get('ndi')?.receivers() ?? 0, error }));
    error = null;
  };
  const close = (kind) => {
    try { live.get(kind)?.close(); } catch (e) { console.error(`${OUTPUTS[kind].label} did not close cleanly: ${e.message}`); }
    live.delete(kind);
  };
  const fail = (kind, e) => {
    close(kind);
    error = `${OUTPUTS[kind].label}: ${e.message}`;
    console.error(error);
  };
  const apply = async (wanted) => {
    for (const kind of [...live.keys()]) if (!wanted.includes(kind)) close(kind);
    for (const kind of wanted) {
      if (live.has(kind) || !available.includes(kind)) continue;
      try { live.set(kind, await OUTPUTS[kind].open()); } catch (e) { fail(kind, e); }
    }
    status();
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let on;
      try { ({ on } = JSON.parse(data)); } catch { return; } // not a message of ours
      queue = queue.then(() => apply(Array.isArray(on) ? on : [])).catch((e) => console.error(e)); // one change at a time
      return;
    }
    if (data.length >= 8) {
      const w = data.readUInt32LE(0), h = data.readUInt32LE(4);
      if (data.length === 8 + w * h * 4) {
        for (const [kind, out] of live) {
          try { out.send(data.subarray(8), w, h); } catch (e) { fail(kind, e); status(); }
        }
      }
    }
    ws.send(ACK);
  });
  const timer = setInterval(() => live.has('ndi') && status(), 1000);
  ws.on('close', () => {
    clearInterval(timer);
    queue.then(() => { for (const kind of [...live.keys()]) close(kind); });
  });
  status();
}

// a page served from here, not any website you happen to visit
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function attachOutputs(server, available) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/api/out' || !sameOrigin(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => session(ws, available));
  });
}

export const outputLabels = (kinds) => kinds.map((k) => OUTPUTS[k].label);
