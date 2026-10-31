// Lights: the bytes that go out on the wire, the modules that fill the universe, and what an
// interface does when it's the wrong kind, too slow or pulled out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DmxSerial, askWho, isPro, plainFrame, proFrame } from '../src/dmx/serial.js';
import { HEADER } from '../src/engine/tap.js';
import { Graph } from '../src/graph/graph.js';
import { checkRig } from '../src/dj/rig.js';
import { getDef } from '../src/nodes/index.js';

const tick = () => new Promise((r) => setImmediate(r));

test('a Pro frame is the documented message: label 6, 513 bytes, start code 0', () => {
  const u = new Uint8Array(512);
  u[0] = 10; u[511] = 20;
  const m = proFrame(u);
  assert.equal(m.length, 518);
  assert.deepEqual([...m.subarray(0, 5)], [0x7e, 6, 0x01, 0x02, 0]);
  assert.equal(m[5], 10);
  assert.equal(m[516], 20);
  assert.equal(m[517], 0xe7);
});

test('a plain frame is the start code and the channels', () => {
  const u = new Uint8Array(512).fill(7);
  const m = plainFrame(u);
  assert.equal(m.length, 513);
  assert.equal(m[0], 0);
  assert.equal(m[512], 7);
});

test('the question a Pro answers, and how the answer is recognised', () => {
  assert.deepEqual([...askWho()], [0x7e, 3, 2, 0, 0, 0, 0xe7]);
  assert.ok(isPro([0, 0x7e, 3, 5, 0, 1, 2, 3, 4, 5, 0xe7]));
  assert.ok(!isPro([0x7e, 5, 3]));
});

function fakePort({ answers = false, breaks = [] } = {}) {
  const port = {
    written: [],
    opened: null,
    closed: false,
    hold: null,
    failWrites: false,
    async open(o) { port.opened = o; },
    async close() { port.closed = true; },
    async setSignals(s) { breaks.push(s.break); },
    writable: { getWriter: () => ({
      write(bytes) {
        if (port.failWrites) return Promise.reject(new Error('the device has been lost'));
        port.written.push(bytes);
        return port.hold ?? Promise.resolve();
      },
      releaseLock() {},
    }) },
    readable: { getReader() {
      let sent = false, cancel;
      return {
        read() {
          if (answers && !sent) { sent = true; return Promise.resolve({ value: Uint8Array.from([0x7e, 3, 5, 0, 1, 2, 3, 4, 5, 0xe7]), done: false }); }
          return new Promise((ok) => { cancel = () => ok({ done: true }); });
        },
        cancel() { cancel?.(); return Promise.resolve(); },
        releaseLock() {},
      };
    } },
  };
  return port;
}
function fakeSerial(port) {
  const s = new EventTarget();
  s.getPorts = async () => [port];
  s.requestPort = async () => port;
  return s;
}

function setup(options) {
  const port = fakePort(options);
  const serial = fakeSerial(port);
  let t = 0;
  const dmx = new DmxSerial({ serial, now: () => t });
  return { port, serial, dmx, advance: (ms) => { t += ms; } };
}

test('it opens the line at DMX speed and knows a Pro when one answers', async () => {
  const { dmx, port } = setup({ answers: true });
  await dmx.connect();
  assert.deepEqual(port.opened, { baudRate: 250000, dataBits: 8, stopBits: 2, parity: 'none' });
  assert.equal(dmx.kind, 'Pro');
});

test('silence means a plain cable, and each of its frames starts with a break', async () => {
  const breaks = [];
  const { dmx, port, advance } = setup({ breaks });
  await dmx.connect();
  assert.equal(dmx.kind, 'Open DMX');
  port.written.length = 0;
  advance(100);
  dmx.frame(new Uint8Array(512).fill(9));
  await tick(); await tick();
  assert.deepEqual(breaks, [true, false]);
  assert.equal(port.written[0].length, 513);
});

test('it never outruns the wire: it skips frames rather than queue', async () => {
  const { dmx, port, advance } = setup({ answers: true });
  await dmx.connect();
  port.written.length = 0;
  const u = new Uint8Array(512);
  advance(100);
  dmx.frame(u);
  dmx.frame(u);                      // too soon
  await tick();
  assert.equal(port.written.length, 1);
  let release;
  port.hold = new Promise((ok) => { release = ok; });
  advance(100);
  dmx.frame(u);
  await tick();
  advance(100);
  dmx.frame(u);                      // the wire is still busy
  await tick();
  assert.equal(port.written.length, 2);
  release();
  port.hold = null;
  await tick();
  advance(100);
  dmx.frame(u);
  await tick();
  assert.equal(port.written.length, 3);
});

test('disconnecting turns the lights off before it lets go', async () => {
  const { dmx, port } = setup({ answers: true });
  await dmx.connect();
  await dmx.disconnect();
  const last = port.written.at(-1);
  assert.equal(last.length, 518);
  assert.ok(last.subarray(5, 517).every((b) => b === 0));
  assert.ok(port.closed);
  assert.equal(dmx.connected, false);
});

test('pulling the interface out says so and does not throw', async () => {
  const { dmx, port, advance } = setup({ answers: true });
  await dmx.connect();
  port.failWrites = true;
  advance(100);
  dmx.frame(new Uint8Array(512));
  await tick(); await tick();
  assert.equal(dmx.connected, false);
  assert.match(dmx.error, /lost/);
  advance(100);
  dmx.frame(new Uint8Array(512));   // nothing to send to now
});

test('the browser saying it was unplugged is heard too', async () => {
  const { dmx, port, serial } = setup({ answers: true });
  await dmx.connect();
  const e = new Event('disconnect');
  Object.defineProperty(e, 'port', { value: port });
  serial.dispatchEvent(e);
  await tick();
  assert.equal(dmx.connected, false);
  assert.match(dmx.error, /unplugged/);
});

const out = getDef('dmx-out'), pixels = getDef('dmx-pixels');
const channels = (values = {}) => ({ ch1: 0, ch2: 0, ch3: 0, ch4: 0, ch5: 0, ch6: 0, ch7: 0, ch8: 0, ...values });

test('DMX Out writes eight channels from its address', () => {
  const dmx = new Uint8Array(512);
  out.process({ dmx }, { address: 10, ...channels({ ch1: 1, ch8: 0.5 }) });
  assert.equal(dmx[8], 0);
  assert.equal(dmx[9], 255);
  assert.equal(dmx[16], 128);
  assert.equal(dmx[17], 0);
});

test('where two modules claim a channel the higher one wins', () => {
  const dmx = new Uint8Array(512);
  out.process({ dmx }, { address: 1, ...channels({ ch1: 0.2 }) });
  out.process({ dmx }, { address: 1, ...channels({ ch1: 0.9 }) });
  out.process({ dmx }, { address: 1, ...channels({ ch1: 0.5 }) });
  assert.equal(dmx[0], Math.round(0.9 * 255));
});

test('a module running past channel 512 just stops there', () => {
  const dmx = new Uint8Array(512);
  out.process({ dmx }, { address: 510, ...channels({ ch1: 1, ch3: 1, ch4: 1 }) });
  assert.equal(dmx[509], 255);
  assert.equal(dmx[511], 255);
  assert.equal(dmx.length, 512);
});

// a little picture as the engine hands it over: width, height, then BGRA rows from the top
function picture(w, h, rgb) {
  const pic = new Uint8Array(HEADER + w * h * 4);
  const head = new DataView(pic.buffer);
  head.setUint32(0, w, true);
  head.setUint32(4, h, true);
  rgb.forEach(([r, g, b], i) => pic.set([b, g, r, 255], HEADER + i * 4));
  return pic;
}
const lit = (st, p) => {
  const dmx = new Uint8Array(512);
  pixels.process({ dmx }, { address: 1, level: 1, ...p }, st);
  return dmx;
};

test('DMX Pixels lights fixtures left to right, top row first', () => {
  const st = { picture: picture(2, 2, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 20, 30]]) };
  assert.deepEqual([...lit(st, { layout: 0 }).subarray(0, 13)], [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 0]);
  assert.equal(st.lamps.lamps.length, 4);
});

test('the fixture layouts: RGBW takes the white out, dimmer-first opens the dimmer', () => {
  const st = { picture: picture(1, 1, [[200, 100, 100]]) };
  assert.deepEqual([...lit(st, { layout: 1 }).subarray(0, 4)], [100, 0, 0, 100]);
  assert.deepEqual([...lit(st, { layout: 2 }).subarray(0, 4)], [255, 200, 100, 100]);
});

test('level dims the lights and nothing is sent before a picture has arrived', () => {
  const st = { picture: picture(1, 1, [[200, 200, 200]]) };
  assert.equal(lit(st, { layout: 0, level: 0.5 })[0], 100);
  assert.ok(lit({}, { layout: 0 }).every((b) => b === 0));
});

test('a rig can move the lights like any other knob', () => {
  const g = new Graph();
  g.load({ nodes: [{ id: 'n1', type: 'dmx-out' }, { id: 'n2', type: 'output' }], links: [] });
  const { problems } = checkRig(g, { brief: 'lights', groups: [{ name: 'room', question: 'How bright?', every: 4, moves: [
    { name: 'dim', description: 'Dim', glide: 1, ops: [{ op: 'set', id: 'n1', params: { ch1: 0.1 } }] },
    { name: 'full', description: 'Full', glide: 0, ops: [{ op: 'set', id: 'n1', params: { ch1: 1 } }] },
  ] }] });
  assert.deepEqual(problems, []);
});
