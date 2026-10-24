'use strict';
/* Links between the page and a room. Both speak the same messages:
   page -> room: {t: 'hello' | 'team' | 'ready' | 'settings' | 'start' | 'bid' | 'pass' | 'rtm' | 'raise' | 'auto' | 'pause' | 'chat' | 'ask' | 'lobby', ...}
   room -> page: {t: 'welcome' | 'state' | 'scout' | 'scout-wait' | 'error', ...}
   SocketLink talks to the game server; LocalLink runs the room inside this page for solo play. */

const SOLO_SAVE_KEY = 'ipl-auction-room.solo.v2';

class LocalLink {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.pid = null;
    this.room = new RoomHost('SOLO', {
      solo: true,
      send: (to, msg) => {
        if (to !== '*' && to !== this.pid) return;
        if (msg.t === 'state') this.autosave(msg);
        queueMicrotask(() => this.onMessage(msg));
      },
    });
    this.savedAt = 0;
  }

  open(hello) {
    const { player } = this.room.join(hello.name);
    this.pid = player.pid;
    this.onMessage({ t: 'welcome', pid: player.pid, token: player.token, room: 'SOLO', solo: true });
    if (hello.resume) this.room.restore(LocalLink.saved());
    this.room.update();
  }

  send(msg) { this.room.handle(this.pid, msg); }
  close() { this.room.dispose(); }

  autosave(state) {
    if (!state.game || state.room.phase === 'lobby' || Date.now() - this.savedAt < 1500) return;
    this.savedAt = Date.now();
    const me = state.room.players[0];
    try {
      if (state.room.phase === 'done') localStorage.removeItem(SOLO_SAVE_KEY);
      else localStorage.setItem(SOLO_SAVE_KEY, JSON.stringify({ game: state.game, team: me.team, settings: state.room.settings, savedAt: Date.now() }));
    } catch { /* storage unavailable */ }
  }

  static saved() {
    try { return JSON.parse(localStorage.getItem(SOLO_SAVE_KEY)); } catch { return null; }
  }
  static clearSaved() { try { localStorage.removeItem(SOLO_SAVE_KEY); } catch { /* storage unavailable */ } }
}

class SocketLink {
  constructor(url, onMessage, onStatus) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.hello = null;
    this.closed = false;
    this.retries = 0;
  }

  open(hello) {
    this.hello = hello;
    this.connect();
  }

  connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => { this.retries = 0; this.onStatus('online'); ws.send(JSON.stringify(this.hello)); };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'welcome') this.hello = { t: 'hello', name: this.hello.name, room: msg.room, token: msg.token }; // reconnect as the same player
      if (msg.t === 'error' && msg.fatal) this.closed = true;
      this.onMessage(msg);
    };
    ws.onclose = e => {
      if (this.ws !== ws || this.closed) return;
      if (e.code === 4000) { this.closed = true; return this.onMessage({ t: 'error', fatal: true, text: 'This room is open in another tab.' }); }
      this.retry();
    };
  }

  retry() {
    if (this.closed) return;
    this.retries++;
    if (this.retries > 12) { this.closed = true; return this.onMessage({ t: 'error', fatal: true, text: 'Lost the connection to the game server.' }); }
    this.onStatus('reconnecting');
    setTimeout(() => this.connect(), Math.min(5000, 400 * this.retries));
  }

  send(msg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  close() { this.closed = true; if (this.ws) this.ws.close(); }
}
