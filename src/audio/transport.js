// Plays the track and owns "now". Visual time = what you hear, minus output latency.
import { createReader } from './features.js';

export class Transport extends EventTarget {
  constructor() {
    super();
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.recordStream = this.ctx.createMediaStreamDestination();
    this.out.connect(this.recordStream);
    this.buffer = null;
    this.mono = null;
    this.reader = null;
    this.name = '';
    this.source = null;
    this.offset = 0;
    this.startedAt = 0;
    this.playing = false;
    this.loop = true;
    this.live = null;   // a live source standing in for the track
    this.file = null;   // the track, while it does
  }

  get duration() { return this.buffer?.duration ?? 0; }

  get time() {
    if (this.live) return this.live.time;
    if (!this.playing) return this.offset;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    let t = this.ctx.currentTime - this.startedAt - latency;
    const d = this.duration;
    if (this.loop && d) t = ((t % d) + d) % d;
    return Math.max(0, Math.min(t, d));
  }

  // Decode, mix to mono, analyse in a worker. onProgress(0..1).
  async load(arrayBuffer, name, onProgress = () => {}) {
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
    await this.setBuffer(buffer, name, onProgress);
  }

  // The live source's clock takes over. Its own window plays the sound, so nothing is heard here.
  goLive(live) {
    if (this.live) return;
    this.pause();
    this.file = { buffer: this.buffer, mono: this.mono, reader: this.reader, name: this.name };
    this.live = live;
    Object.assign(this, { buffer: null, mono: live.samples, reader: live.reader, name: 'Soundwerk, live', playing: live.running });
    this.emit();
  }

  leaveLive() {
    if (!this.live) return;
    this.live = null;
    Object.assign(this, this.file, { file: null, playing: false });
    this.emit();
  }

  liveChanged() {
    if (!this.live) return;
    this.playing = this.live.running;
    this.emit();
  }

  async setBuffer(buffer, name, onProgress = () => {}) {
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels;
    }
    const analysis = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      const copy = mono.slice();
      worker.onmessage = (e) => {
        if (e.data.progress !== undefined) onProgress(e.data.progress);
        if (e.data.result) { resolve(e.data.result); worker.terminate(); }
      };
      worker.onerror = (e) => { reject(new Error(e.message)); worker.terminate(); };
      worker.postMessage({ samples: copy, sampleRate: buffer.sampleRate }, [copy.buffer]);
    });
    this.leaveLive();
    this.stopSource();
    this.playing = false;
    this.buffer = buffer;
    this.mono = mono;
    this.reader = createReader(analysis);
    this.name = name;
    this.offset = 0;
    this.emit();
  }

  play() {
    if (!this.buffer || this.playing || this.live) return;
    this.ctx.resume();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.loop = this.loop;
    s.connect(this.out);
    s.start(0, Math.min(this.offset, this.duration - 0.001));
    s.onended = () => {
      if (this.source !== s) return;
      this.source = null;
      this.playing = false;
      this.offset = 0;
      this.emit();
    };
    this.source = s;
    this.startedAt = this.ctx.currentTime - this.offset;
    this.playing = true;
    this.emit();
  }

  pause() {
    if (!this.playing || this.live) return;
    this.offset = this.time;
    this.stopSource();
    this.playing = false;
    this.emit();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (this.live) return;
    const was = this.playing;
    if (was) { this.stopSource(); this.playing = false; }
    this.offset = Math.max(0, Math.min(t, this.duration));
    if (was) this.play();
    else this.emit();
  }

  stopSource() {
    if (!this.source) return;
    const s = this.source;
    this.source = null;
    try { s.stop(); } catch { /* already stopped */ }
    s.disconnect();
  }

  emit() { this.dispatchEvent(new Event('change')); }
}
