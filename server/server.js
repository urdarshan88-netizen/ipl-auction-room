'use strict';
/* Game server: serves the web client and runs multiplayer rooms over WebSockets at /ws.
   Run `node server/server.js [port]` (default 7777, or $PORT). The desktop app starts it in-process.
   Set ANTHROPIC_API_KEY to let the scout answer with Claude; without it the built-in scout answers. */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const SHARED = path.join(__dirname, '..', 'shared');
const WEB = path.join(__dirname, '..', 'web');
for (const f of ['data', 'legends', 'modes', 'engine', 'scout', 'room']) require(path.join(SHARED, `${f}.js`));

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const ROOM_IDLE_MS = 15 * 60 * 1000;
const MAX_MESSAGE = 4096;

// IPv4 addresses friends on the same network can reach, real Wi-Fi/Ethernet adapters first and
// virtual ones (WSL, Hyper-V, VPNs, hotspots) last.
function lanAddresses() {
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback|Bluetooth|vpn|tailscale|zerotier|Local Area Connection\*/i;
  const physical = /Wi-?Fi|Wireless|WLAN|^en|^eth|^wl|Ethernet/i;
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, address: a.address })))
    .map(a => ({ ...a, score: (virtual.test(a.name) ? 2 : 0) + (physical.test(a.name) ? 0 : 1) + (a.address.startsWith('192.168.137.') ? 2 : 0) }))
    .sort((a, b) => a.score - b.score)
    .map(a => a.address);
}

// Claude-powered scout, when credentials are configured. Returns null otherwise.
function makeAsk() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let client;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new (Anthropic.default || Anthropic)();
  } catch (err) {
    console.warn('Claude scout disabled:', err.message);
    return null;
  }
  const model = process.env.SCOUT_MODEL || 'claude-opus-5-5';
  return async ({ context, question, history }) => {
    const messages = [];
    for (const turn of history) messages.push({ role: 'user', content: turn.q }, { role: 'assistant', content: turn.a });
    messages.push({ role: 'user', content: `Game data right now:\n${context}\n\nQuestion: ${question}` });
    const res = await client.beta.messages.create({
      model,
      max_tokens: 2000,
      system: SCOUT_BRIEF,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages,
    });
    if (res.stop_reason === 'refusal') throw new Error('refused');
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error('empty answer');
    return text;
  };
}

function startServer({ port = 7777, host = '0.0.0.0' } = {}) {
  const ask = makeAsk();
  const rooms = new Map();

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ app: 'ipl-auction-room', lan: lanAddresses(), port: server.address().port, ai: !!ask }));
    }
    const base = url.startsWith('/shared/') ? SHARED : WEB;
    const rel = url.startsWith('/shared/') ? url.slice('/shared/'.length) : url === '/' ? 'index.html' : url.slice(1);
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE });

  function newRoom() {
    let id;
    do id = makeId(5); while (rooms.has(id));
    const room = new RoomHost(id, { ask, send: (to, msg) => deliver(room, to, msg) });
    room.sockets = new Map();
    rooms.set(id, room);
    return room;
  }

  function deliver(room, to, msg) {
    const data = JSON.stringify(msg);
    if (to === '*') room.sockets.forEach(ws => ws.readyState === ws.OPEN && ws.send(data));
    else { const ws = room.sockets.get(to); if (ws && ws.readyState === ws.OPEN) ws.send(data); }
  }

  wss.on('connection', ws => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const send = msg => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    let room = null, pid = null;

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (room) return room.handle(pid, msg);
      if (msg.t !== 'hello') return;
      const target = msg.create ? newRoom() : rooms.get(String(msg.room || '').toUpperCase());
      if (!target) return send({ t: 'error', fatal: true, code: 'no_room', text: `Room ${String(msg.room || '').toUpperCase()} does not exist or has closed.` });
      const res = target.join(msg.name, msg.token);
      if (res.error) {
        if (msg.create) rooms.delete(target.id);
        return send({ t: 'error', fatal: true, text: res.error });
      }
      room = target;
      pid = res.player.pid;
      const old = room.sockets.get(pid);
      if (old && old !== ws) old.close(4000, 'Opened in another tab');
      room.sockets.set(pid, ws);
      send({ t: 'welcome', pid, token: res.player.token, room: room.id });
      room.update();
    });

    ws.on('close', () => {
      if (!room || room.sockets.get(pid) !== ws) return;
      room.sockets.delete(pid);
      room.disconnect(pid);
    });
  });

  // Keep connections alive through proxies, and close rooms nobody has used for a while.
  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (!room.connected().length && now - room.lastActive > ROOM_IDLE_MS) { room.dispose(); rooms.delete(id); }
      else if (!room.players.length) { room.dispose(); rooms.delete(id); }
    }
  }, 30000);
  server.on('close', () => clearInterval(heartbeat));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, port: actual, lan: lanAddresses(), ai: !!ask, close: () => { wss.close(); server.close(); } });
    });
  });
}

module.exports = { startServer, lanAddresses };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 7777;
  startServer({ port }).then(({ port: p, lan, ai }) => {
    console.log(`IPL Auction Room is running at http://localhost:${p}`);
    lan.forEach(ip => console.log(`  Friends on your network can join at http://${ip}:${p}`));
    console.log(ai ? '  Scout: Claude-powered (ANTHROPIC_API_KEY found)' : '  Scout: built-in (set ANTHROPIC_API_KEY for Claude answers)');
  }).catch(err => { console.error(err.message); process.exit(1); });
}
