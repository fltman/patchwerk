// DMX512 over USB, through the browser's Web Serial, so there is nothing to install. Two kinds of
// interface are understood. A Pro (Enttec DMX USB Pro and the many that copy its protocol) keeps
// the line going by itself and gets a framed message. A plain FTDI cable (Enttec Open DMX and its
// copies) is just a serial port: every frame needs its break and all 513 bytes from here.
// It asks the interface who it is: a Pro answers, a plain cable doesn't.
const BAUD = 250000;
const SIZE = 512;
const START = 0x7e, END = 0xe7, GET_PARAMS = 3, SEND_DMX = 6;
const LISTEN_MS = 250;   // how long a Pro gets to answer
const EVERY_MS = 25;     // a full DMX frame takes 23 ms on the wire. Frames go with the screen: 30 a second at 60 Hz

const message = (label, data) => Uint8Array.from([START, label, data.length & 255, data.length >> 8, ...data, END]);

export const askWho = () => message(GET_PARAMS, [0, 0]);
export const proFrame = (universe) => message(SEND_DMX, [0, ...universe]);
export function plainFrame(universe) {
  const out = new Uint8Array(SIZE + 1); // start code 0, then the channels
  out.set(universe.subarray(0, SIZE), 1);
  return out;
}

// did an answer to askWho arrive in these bytes?
export const isPro = (bytes) => bytes.some((b, i) => b === START && bytes[i + 1] === GET_PARAMS);

export class DmxSerial extends EventTarget {
  constructor({ serial = navigator.serial, now = () => performance.now() } = {}) {
    super();
    this.serial = serial;
    this.now = now;
    this.port = null;
    this.kind = null;       // 'Pro' | 'Open DMX'
    this.busy = false;
    this.last = -Infinity;
    this.frames = 0;
    this.error = '';
  }

  get supported() { return !!this.serial; }
  get connected() { return !!this.port; }

  said() { this.dispatchEvent(new Event('change')); }

  // needs a click: the browser asks which device, once. After that it remembers.
  async connect() {
    const [known] = await this.serial.getPorts();
    const port = known ?? await this.serial.requestPort();
    await port.open({ baudRate: BAUD, dataBits: 8, stopBits: 2, parity: 'none' });
    this.writer = port.writable.getWriter();
    this.kind = await this.ask(port) ? 'Pro' : 'Open DMX';
    this.port = port;
    this.error = '';
    this.frames = 0;
    this.gone = (e) => { if (e.target === port || e.port === port) this.lost('The DMX interface was unplugged'); };
    this.serial.addEventListener('disconnect', this.gone);
    this.said();
  }

  async ask(port) {
    await this.writer.write(askWho());
    const reader = port.readable.getReader();
    const heard = [];
    let waiting = true;
    const timer = setTimeout(() => { waiting = false; reader.cancel(); }, LISTEN_MS);
    try {
      while (waiting) {
        const { value, done } = await reader.read();
        if (done) break;
        heard.push(...value);
        if (isPro(heard)) break;
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    return isPro(heard);
  }

  // every animation frame. Skips a frame rather than queue up behind the wire.
  frame(universe) {
    if (!this.port || this.busy || this.now() - this.last < EVERY_MS) return;
    this.last = this.now();
    this.busy = true;
    this.write(universe).then(() => { this.busy = false; this.frames++; }, (e) => { this.busy = false; this.lost(e.message); });
  }

  async write(universe) {
    if (this.kind === 'Pro') return this.writer.write(proFrame(universe));
    await this.port.setSignals({ break: true });
    await this.port.setSignals({ break: false });
    return this.writer.write(plainFrame(universe));
  }

  lost(message) {
    this.error = message;
    this.release();
    this.said();
  }

  // lights off, then let go of the port
  async disconnect() {
    const { port, writer } = this;
    if (!port) return;
    this.port = null;
    try { await this.blackout(writer, port); } catch { /* it may have gone already */ }
    await this.release(port, writer);
    this.said();
  }

  async blackout(writer, port) {
    const dark = new Uint8Array(SIZE);
    if (this.kind === 'Pro') return writer.write(proFrame(dark));
    await port.setSignals({ break: true });
    await port.setSignals({ break: false });
    return writer.write(plainFrame(dark));
  }

  async release(port = this.port, writer = this.writer) {
    this.port = null;
    this.serial.removeEventListener('disconnect', this.gone);
    try { writer?.releaseLock(); await port?.close(); } catch { /* unplugged */ }
  }
}
