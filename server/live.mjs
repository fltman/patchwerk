// The live input. Soundwerk's page sends what it is playing to /api/live?role=source and this hands
// it on to every Patchwerk page. A WebSocket ignores the browser's same-origin rule, so the check is
// here: a sender must be a Soundwerk page, a listener one of ours. Nothing is kept or looked at.
import { WebSocketServer } from 'ws';
import { sameOrigin } from './outputs.mjs';

const SENDERS = new Set((process.env.PATCHWERK_LIVE_ORIGINS ?? 'http://localhost:8280,http://127.0.0.1:8280').split(','));
const BACKLOG = 1 << 17; // bytes queued for a page: past this it misses a frame rather than falls behind

export function attachLive(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 16 });
  const pages = new Set();
  let source = null;
  const tell = (ws) => ws.send(JSON.stringify({ source: !!source }));

  const addSource = (ws) => {
    source?.close();   // the newest one wins
    source = ws;
    ws.on('message', (data, binary) => {
      if (ws !== source) return;
      for (const page of pages) if (page.bufferedAmount < BACKLOG) page.send(data, { binary });
    });
    ws.on('close', () => {
      if (ws !== source) return;
      source = null;
      pages.forEach(tell);
    });
    pages.forEach(tell);
  };

  const addPage = (ws) => {
    pages.add(ws);
    ws.on('close', () => pages.delete(ws));
    tell(ws);
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/live') return;
    const sending = url.searchParams.get('role') === 'source';
    if (sending ? !SENDERS.has(req.headers.origin) : !sameOrigin(req)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, sending ? addSource : addPage);
  });
}
