// Syphon / Spout / NDI switches. The server does the publishing (a page can't);
// while an output is on, this streams it the finished frames over a WebSocket.
import { FrameTap } from '../engine/tap.js';

const STORE = 'patchwerk.outputs';
const LABELS = { syphon: 'Syphon', spout: 'Spout', ndi: 'NDI' };
const TIPS = {
  syphon: 'Share the picture with VJ apps on this Mac (Resolume, MadMapper, OBS…) through Syphon',
  spout: 'Share the picture with VJ apps on this PC (Resolume, TouchDesigner, OBS…) through Spout',
  ndi: 'Send the picture over the network with NDI',
};
const FPS = 60;
const IN_FLIGHT = 2; // frames sent but not yet answered by the server

export class Outputs {
  constructor({ renderer, toast }) {
    this.renderer = renderer;
    this.toast = toast;
    this.el = document.getElementById('outputs');
    this.boxes = new Map();
    try { this.wanted = new Set(JSON.parse(localStorage.getItem(STORE)) ?? []); } catch { this.wanted = new Set(); }
    this.last = 0;
    this.tap = new FrameTap(renderer.gl, { wants: () => this.wants(), onFrame: (buf) => this.send(buf) });
    this.connect();
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/out`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.connected = true; this.inFlight = 0; this.sync(); };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.inFlight--; // a frame was handed on
      else this.show(JSON.parse(e.data));
    };
    ws.onclose = () => {
      this.renderer.tap = null;
      this.el.classList.add('hidden');
      // the server restarted: come back when it does (a server without outputs: give up)
      if (this.connected) setTimeout(() => this.connect(), 2000);
    };
    this.ws = ws;
  }

  sync() {
    localStorage.setItem(STORE, JSON.stringify([...this.wanted]));
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ on: [...this.wanted] }));
  }

  // read back this frame? Not faster than FPS, and not while the server is still behind.
  // (The socket's bufferedAmount can't tell: it empties as soon as the browser's
  // network process has taken the data, however far behind the server is.)
  wants() {
    const now = performance.now();
    if (this.ws.readyState !== WebSocket.OPEN || this.inFlight >= IN_FLIGHT || now - this.last < 1000 / FPS - 2) return false;
    this.last = now;
    return true;
  }

  send(buf) {
    this.inFlight++;
    this.ws.send(buf);
  }

  show({ available, on, receivers, error }) {
    this.el.classList.toggle('hidden', !available.length);
    for (const kind of available) {
      if (this.boxes.has(kind)) continue;
      const label = document.createElement('label');
      label.className = 'check';
      label.title = TIPS[kind];
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.out = kind;
      box.onchange = () => {
        if (box.checked) this.wanted.add(kind);
        else this.wanted.delete(kind);
        this.sync();
      };
      label.append(box, ` ${LABELS[kind]}`);
      this.el.append(label);
      this.boxes.set(kind, { label, box });
    }
    if (error) {
      this.toast(error);
      for (const kind of available) if (!on.includes(kind)) this.wanted.delete(kind);
      this.sync();
    }
    for (const [kind, { label, box }] of this.boxes) {
      box.checked = this.wanted.has(kind);
      label.classList.toggle('live', on.includes(kind));
    }
    const ndi = this.boxes.get('ndi');
    if (ndi) ndi.label.title = on.includes('ndi') ? `NDI: ${receivers} receiving` : TIPS.ndi;
    this.renderer.tap = on.length ? this.tap : null;
  }
}
