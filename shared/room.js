'use strict';
/* A room: the people in it, their franchises and ready state, the host's settings, the auction
   in progress, room chat and scout questions. Runs on the server for multiplayer and inside the
   page for solo play. `send(to, msg)` delivers to one player id, or to everyone when `to` is '*'.
   `ask({context, question, history})`, when given, answers scout questions with Claude. */

const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const TIMER_CHOICES = [0, 6, 10, 15, 20];      // 0 = the mode's own hammer
const COUNTDOWN_MS = 3500;                     // "the auction begins in 3, 2, 1"
const ASK_GAP_MS = 3000;                       // at most one Claude question every 3 s per player
const ASK_LIMIT = 40;                          // Claude questions per player per auction
function makeId(len, chars = ROOM_CHARS) {
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanName = v => cleanText(v, 20) || 'Player';

class RoomHost {
  constructor(id, { send, ask = null, solo = false } = {}) {
    this.id = id;
    this.send = send;
    this.ask = ask;
    this.solo = solo;
    this.players = [];
    this.settings = { mode: 'mega', teams: MODES.mega.teams, timer: 0, aggression: 1 };
    this.phase = 'lobby';
    this.game = null;
    this.startsAt = 0;
    this.chat = [];
    this.scoutLog = {};
    this.pending = null;
    this.lastSent = 0;
    this.lastActive = Date.now();
  }

  player(pid) { return this.players.find(p => p.pid === pid); }
  connected() { return this.players.filter(p => p.connected); }

  /* ---------- membership ---------- */
  join(name, token) {
    const back = token && this.players.find(p => p.token === token);
    if (back) {
      back.connected = true;
      if (name) back.name = cleanName(name);
      if (this.game && back.team && back.autoByDisconnect) { back.autoByDisconnect = false; this.game.setAuto(back.team, false); }
      this.system(`${back.name} is back.`);
      this.ensureHost();
      this.update();
      return { player: back };
    }
    if (this.phase !== 'lobby') return { error: 'This auction has already started. Ask the host for a new room after it ends.' };
    if (this.players.length >= 10) return { error: 'This room is full: 10 players is the most one auction can take.' };
    const p = {
      pid: makeId(10, ID_CHARS), token: makeId(24, ID_CHARS), name: cleanName(name),
      team: null, ready: false, connected: true, host: !this.players.some(x => x.host), joinedAt: Date.now(),
    };
    this.players.push(p);
    if (!this.solo) this.system(`${p.name} joined the room.`);
    this.update();
    return { player: p };
  }

  disconnect(pid) {
    const p = this.player(pid);
    if (!p) return;
    p.connected = false;
    if (this.phase === 'lobby') {
      this.players = this.players.filter(x => x !== p);
      this.system(`${p.name} left the room.`);
    } else if (this.game && p.team) {
      const t = this.game.team(p.team);
      if (t && !t.auto) { p.autoByDisconnect = true; this.game.setAuto(p.team, true); }
      this.system(`${p.name} disconnected. The computer bids for ${p.team} until they return.`);
    }
    this.ensureHost();
    this.update();
  }

  ensureHost() {
    const host = this.players.find(p => p.host);
    if (host && host.connected) return;
    const next = this.players.find(p => p.connected);
    if (!next) return;
    if (host) host.host = false;
    next.host = true;
    this.system(`${next.name} is now the host.`);
  }

  /* ---------- messages from players ---------- */
  handle(pid, msg) {
    const p = this.player(pid);
    if (!p || !msg || typeof msg.t !== 'string') return;
    this.lastActive = Date.now();
    const g = this.game, l = g && g.lot;
    switch (msg.t) {
      case 'name':
        p.name = cleanName(msg.name);
        break;
      case 'team': {
        if (this.phase !== 'lobby' || !TEAM_META[msg.team]) return;
        const owner = this.players.find(x => x.team === msg.team && x !== p);
        if (owner) return this.error(pid, `${owner.name} already has ${msg.team}.`);
        p.team = p.team === msg.team ? null : msg.team;
        p.ready = false;
        break;
      }
      case 'ready':
        if (this.phase !== 'lobby') return;
        if (!p.team) return this.error(pid, 'Pick a franchise before you ready up.');
        p.ready = !!msg.on;
        break;
      case 'settings': {
        if (this.phase !== 'lobby' || !p.host) return;
        const s = this.settings, before = JSON.stringify(s);
        if (MODES[msg.mode] && msg.mode !== s.mode) { s.mode = msg.mode; s.teams = MODES[msg.mode].teams; }
        if (Number.isInteger(msg.teams)) s.teams = Math.max(2, Math.min(10, msg.teams));
        if (TIMER_CHOICES.includes(msg.timer)) s.timer = msg.timer;
        if (AI_LEVELS[msg.aggression]) s.aggression = msg.aggression;
        if (JSON.stringify(s) !== before) this.players.forEach(x => { x.ready = false; }); // rules changed: everyone re-reads them
        break;
      }
      case 'start':
        if (p.host && this.phase === 'lobby') this.start(p);
        return;
      case 'bid':
        if (g && p.team) g.placeBid(p.team);
        return;
      case 'pass':
        if (g && p.team) g.pass(p.team);
        return;
      case 'rtm':
        if (!l || l.phase !== 'rtm' || l.rtm.team !== p.team) return;
        if (l.rtm.stage === 'offer' && (msg.choice === 'use' || msg.choice === 'decline')) g.rtmOffer(msg.choice === 'use');
        if (l.rtm.stage === 'match' && (msg.choice === 'match' || msg.choice === 'decline')) g.rtmMatch(msg.choice === 'match');
        return;
      case 'raise':
        if (l && l.phase === 'rtm' && l.rtm.stage === 'raise' && l.bidder === p.team) g.rtmRaise(Number(msg.amount) || null);
        return;
      case 'auto':
        if (!g || !p.team) return;
        p.autoByDisconnect = false;
        g.setAuto(p.team, !!msg.on);
        if (!this.solo) this.system(msg.on ? `${p.name} switched on autopilot for ${p.team}.` : `${p.name} took back the ${p.team} paddle.`);
        break;
      case 'pause':
        if (!g || !p.host || g.s.status === 'done') return;
        g.setPaused(!!msg.on);
        if (!this.solo) this.system(msg.on ? `${p.name} paused the auction.` : `${p.name} resumed the auction.`);
        break;
      case 'chat': {
        const text = cleanText(msg.text, 240);
        if (!text) return;
        this.chat.push({ id: makeId(8, ID_CHARS), pid, name: p.name, team: p.team, text, at: Date.now() });
        if (this.chat.length > 80) this.chat.shift();
        break;
      }
      case 'ask':
        this.askScout(p, cleanText(msg.text, 300));
        return;
      case 'lobby':
        if (!p.host || this.phase !== 'done') return;
        this.reset();
        break;
      default:
        return;
    }
    this.update();
  }

  start(hostPlayer) {
    const people = this.players.filter(p => p.connected);
    if (people.some(p => !p.team || !p.ready)) {
      return this.error(hostPlayer.pid, 'Everyone needs a franchise and has to accept the rules before the auction starts.');
    }
    this.players = people;
    const count = Math.max(this.settings.teams, people.length);
    const ids = people.map(p => p.team);
    for (const t of TEAMS) if (ids.length < count && !ids.includes(t.id)) ids.push(t.id);
    ids.sort((a, b) => TEAMS.findIndex(t => t.id === a) - TEAMS.findIndex(t => t.id === b));
    this.attachGame(AuctionGame.fresh({
      mode: this.settings.mode, teamIds: ids, humans: people.map(p => p.team),
      timer: this.settings.timer || undefined, aggression: this.settings.aggression,
    }));
    this.scoutLog = {};
    this.startsAt = Date.now() + COUNTDOWN_MS;
    this.system(`${MODES[this.settings.mode].name} begins with ${ids.length} franchises. Good luck!`);
    this.startTimer = setTimeout(() => { if (this.game) this.game.run(); }, COUNTDOWN_MS);
    this.update();
  }

  attachGame(game) {
    this.game = game;
    this.phase = game.s.status === 'done' ? 'done' : 'game';
    game.on('*', evt => {
      if (evt === 'done') this.phase = 'done';
      this.update();
    });
  }

  // Solo play only: pick up a saved auction where it stopped.
  restore(saved) {
    const p = this.players[0];
    if (!p || !saved || !saved.game) return false;
    p.team = saved.team;
    p.ready = true;
    this.settings = { ...this.settings, ...saved.settings };
    const game = new AuctionGame(saved.game);
    game.resumeLot();
    this.attachGame(game);
    this.startsAt = 0;
    if (this.phase === 'game') game.run();
    this.update();
    return true;
  }

  reset() {
    this.dispose();
    this.game = null;
    this.phase = 'lobby';
    this.players = this.players.filter(p => p.connected);
    this.players.forEach(p => { p.ready = false; p.autoByDisconnect = false; });
    this.system('Back in the lobby. Pick franchises and ready up for the next auction.');
  }

  dispose() {
    clearTimeout(this.startTimer);
    clearTimeout(this.pending);
    this.pending = null;
    if (this.game) this.game.stop();
  }

  /* ---------- scout ---------- */
  askScout(p, question) {
    if (!question) return;
    const reply = (text, source) => this.send(p.pid, { t: 'scout', text, source });
    const g = this.game;
    if (!g || !p.team || this.phase === 'lobby') return reply('I start scouting once the auction begins. Pick your franchise and ready up!', 'scout');
    const log = this.scoutLog[p.pid] ||= { asked: 0, last: 0, turns: [] };
    const now = Date.now();
    if (!this.ask || log.asked >= ASK_LIMIT || now - log.last < ASK_GAP_MS) return reply(scoutAnswer(g, p.team, question), 'scout');
    log.asked++;
    log.last = now;
    this.send(p.pid, { t: 'scout-wait' });
    this.ask({ context: scoutContext(g, p.team), question, history: log.turns.slice(-4) })
      .then(text => {
        log.turns.push({ q: question, a: text });
        reply(text, 'claude');
      })
      .catch(() => reply(scoutAnswer(g, p.team, question), 'scout'));
  }

  /* ---------- outgoing ---------- */
  system(text) {
    this.chat.push({ id: makeId(8, ID_CHARS), system: true, text, at: Date.now() });
    if (this.chat.length > 80) this.chat.shift();
  }
  error(pid, text) { this.send(pid, { t: 'error', text }); }

  // Coalesce bursts of engine events into at most ~12 snapshots a second.
  update() {
    if (this.pending) return;
    const wait = Math.max(30, 80 - (Date.now() - this.lastSent));
    this.pending = setTimeout(() => { this.pending = null; this.lastSent = Date.now(); this.send('*', this.snapshot()); }, wait);
  }

  snapshot() {
    return {
      t: 'state', serverNow: Date.now(),
      room: {
        id: this.id, phase: this.phase, solo: this.solo, settings: { ...this.settings }, startsAt: this.startsAt, ai: !!this.ask,
        players: this.players.map(({ token, autoByDisconnect, ...rest }) => rest),
        chat: this.chat.slice(-60),
      },
      // AI valuations stay on the host: nobody gets to read the computer's hand.
      game: this.game ? JSON.parse(JSON.stringify(this.game.s, (k, v) => (k === 'val' ? undefined : v))) : null,
    };
  }
}

if (typeof module === 'object' && module.exports) Object.assign(globalThis, { RoomHost, makeId, ROOM_CHARS });
