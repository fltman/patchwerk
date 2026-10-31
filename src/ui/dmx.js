// The Lights panel: connects a USB interface, and shows what is going out with or without one.
// The stage draws the lamps of every DMX Pixels module; the map is all 512 channels.
import { DmxSerial } from '../dmx/serial.js';

const CELL = 12;         // pixels per channel on the map
const PER_ROW = 32;
const EVERY_MS = 66;     // redraw, while open
const LAMP = 22;

export class DmxPanel {
  constructor({ renderer, graph, toast }) {
    Object.assign(this, { renderer, graph, toast });
    this.serial = new DmxSerial();
    this.panel = document.getElementById('dmx');
    this.btn = document.getElementById('dmx-btn');
    this.connectBtn = document.getElementById('dmx-connect');
    this.status = document.getElementById('dmx-status');
    this.stage = document.getElementById('dmx-stage');
    this.map = document.getElementById('dmx-map');
    this.map.width = PER_ROW * CELL;
    this.map.height = (512 / PER_ROW) * CELL;
    this.btn.onclick = () => this.toggle();
    document.getElementById('dmx-close').onclick = () => this.toggle(false);
    this.connectBtn.onclick = () => this.flip();
    this.serial.addEventListener('change', () => this.show());
    addEventListener('pagehide', () => this.serial.disconnect());
    this.drawn = 0;
    this.show();
  }

  toggle(open = this.panel.classList.contains('hidden')) {
    this.panel.classList.toggle('hidden', !open);
    this.btn.classList.toggle('active', open);
  }

  async flip() {
    try {
      if (this.serial.connected) await this.serial.disconnect();
      else await this.serial.connect();
    } catch (e) {
      if (e.name !== 'NotFoundError') this.toast(e.message); // no device picked: nothing to say
    }
    this.show();
  }

  show() {
    const s = this.serial;
    this.connectBtn.textContent = s.connected ? 'Disconnect' : 'Connect USB…';
    this.connectBtn.disabled = !s.supported;
    this.btn.classList.toggle('live', s.connected);
    this.status.textContent = !s.supported ? 'This browser has no Web Serial: use Chrome or Edge'
      : s.error || (s.connected ? `Sending to ${s.kind} interface` : 'No interface: what would go out shows here');
  }

  // every frame
  frame() {
    this.serial.frame(this.renderer.dmx);
    const now = performance.now();
    if (this.panel.classList.contains('hidden') || now - this.drawn < EVERY_MS) return;
    this.drawn = now;
    this.drawStage();
    this.drawMap();
  }

  drawStage() {
    const rigs = [...this.graph.nodes.values()].filter((n) => n.type === 'dmx-pixels')
      .map((n) => this.renderer.cpuState.get(n.id)?.lamps).filter(Boolean);
    const height = rigs.reduce((s, r) => s + r.h * LAMP + 6, 0);
    const width = Math.max(1, ...rigs.map((r) => r.w * LAMP));
    this.stage.classList.toggle('hidden', !rigs.length);
    if (this.stage.width !== width) this.stage.width = width;
    if (this.stage.height !== height) this.stage.height = height;
    const c = this.stage.getContext('2d');
    c.clearRect(0, 0, width, height);
    let top = 0;
    for (const { w, h, lamps } of rigs) {
      lamps.forEach(([r, g, b], i) => {
        c.fillStyle = `rgb(${r * 255} ${g * 255} ${b * 255})`;
        c.beginPath();
        c.arc((i % w) * LAMP + LAMP / 2, top + Math.floor(i / w) * LAMP + LAMP / 2, LAMP / 2 - 2, 0, 7);
        c.fill();
      });
      top += h * LAMP + 6;
    }
  }

  drawMap() {
    const c = this.map.getContext('2d');
    const { dmx } = this.renderer;
    c.fillStyle = '#111317';
    c.fillRect(0, 0, this.map.width, this.map.height);
    for (let i = 0; i < 512; i++) {
      if (!dmx[i]) continue;
      c.fillStyle = `rgb(255 209 102 / ${dmx[i] / 255})`;
      c.fillRect((i % PER_ROW) * CELL + 1, Math.floor(i / PER_ROW) * CELL + 1, CELL - 2, CELL - 2);
    }
  }
}
