'use strict';
/* Game client: home, room lobby, auction and results. It renders the snapshots a room sends and
   sends the player's actions back; it never changes game state itself. Regions are patched only
   when their markup changes, so inputs keep focus and buttons survive rapid bidding. */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(`ipl-auction-room.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ipl-auction-room.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
// Reconnect tokens live per tab: a reload rejoins as the same player, a second tab joins as someone new.
const seat = {
  get(room) { try { return sessionStorage.getItem(`ipl-auction-room.seat.${room}`); } catch { return null; } },
  set(room, token) { try { sessionStorage.setItem(`ipl-auction-room.seat.${room}`, token); } catch { /* storage unavailable */ } },
};
const teamVars = id => { const t = TEAM_META[id]; return `--c1:${t.c1};--c2:${t.c2};--ink:${t.ink}`; };
const badge = (id, sm = false) => `<span class="badge${sm ? ' badge-sm' : ''}" style="${teamVars(id)}">${id}</span>`;
const initials = name => { const w = name.split(/\s+/); return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
const num = v => v == null ? '—' : Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toFixed(1);
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const isBowler = pl => pl.role === 'FAST' || pl.role === 'SPIN';
function avatar(pl, size = '') {
  const c = COUNTRIES[pl.country].c;
  return `<span class="avatar${size ? ' avatar-' + size : ''}" style="--a:${c[0]};--b:${c[1]}" aria-hidden="true">${initials(pl.name)}</span>`;
}
function patch(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }

const GAVEL = `<svg class="gavel" viewBox="0 0 64 64" aria-hidden="true"><g transform="rotate(-35 30 26)"><rect x="12" y="10" width="30" height="14" rx="3" fill="#f5b731"/><rect x="8" y="12" width="6" height="10" rx="2" fill="#ffd87a"/><rect x="40" y="12" width="6" height="10" rx="2" fill="#ffd87a"/><rect x="24" y="24" width="6" height="30" rx="3" fill="#c98a1c"/></g><rect x="30" y="52" width="30" height="8" rx="2" fill="#7a5a1c"/></svg>`;
const icon = d => `<svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const MODE_ICONS = {
  mega: icon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  mini: icon('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  legends: icon('<path d="M3 19h18M4 8l4 4 4-7 4 7 4-4-2 11H6z"/>'),
  blitz: icon('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
};

const app = {
  name: store.get('name', ''), link: null, pid: null, roomId: null, solo: false, online: true,
  room: null, game: null, recvAt: 0, offset: 0, screen: null, server: null, sample: null,
  fmt: 'IPL', side: 'teams', scout: [], scoutBusy: false, chatSeen: 0, sound: store.get('sound', true),
  prev: null, lastCall: '', modalCtx: null, poolRole: 'ALL', poolQuery: '',
};

/* ---------- small helpers ---------- */
const me = () => app.room && app.room.players.find(p => p.pid === app.pid);
const myTeamId = () => (me() || {}).team || null;
const myTeam = () => app.game && myTeamId() && app.game.team(myTeamId());
const isHost = () => !!(me() && me().host);
const send = msg => app.link && app.link.send(msg);
function currentRules() {
  if (app.game) return { ...app.game.cfg, teams: app.game.s.teams.length };
  const s = app.room ? app.room.settings : { mode: 'mega' };
  const r = effectiveRules(s.mode, s);
  return { ...r, teams: Math.max(r.teams, app.room ? app.room.players.filter(p => p.team).length : 1) };
}

let toastTimer = null;
function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

let actx = null;
function sfx(kind) {
  if (!app.sound) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    const tone = (freq, dur, type, gain, at = 0) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t0 + at);
      g.gain.setValueAtTime(gain, t0 + at); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(actx.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
    };
    if (kind === 'bid') tone(880, 0.08, 'triangle', 0.05);
    else if (kind === 'tick') tone(520, 0.07, 'square', 0.025);
    else if (kind === 'sold') { tone(95, 0.3, 'sine', 0.3); tone(60, 0.35, 'triangle', 0.2); tone(660, 0.18, 'triangle', 0.05, 0.14); tone(990, 0.35, 'triangle', 0.05, 0.24); }
    else if (kind === 'unsold') tone(200, 0.3, 'sine', 0.06);
    else if (kind === 'win') [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.06, i * 0.12));
  } catch { /* audio unavailable */ }
}

function confetti(teamId) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t = TEAM_META[teamId], colors = [t.c1, t.c2, '#ffd87a', '#ffffff'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
    c.style.animationDelay = `${Math.random() * 0.4}s`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3800);
  }
}

/* ---------- modal ---------- */
function openModal(html, ctx = null) {
  app.modalCtx = ctx;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  $('#modal .modal-card').scrollTop = 0;
}
function closeModal() { $('#modal').hidden = true; app.modalCtx = null; }
function refreshModal() {
  const c = app.modalCtx;
  if (!c || $('#modal').hidden) return;
  if (c.kind === 'squad') $('#modal-body').innerHTML = squadHTML(c.id);
  if (c.kind === 'rules') $('#modal-body').innerHTML = rulesHTML();
}

/* ---------- screens ---------- */
function mount(screen) {
  app.screen = screen;
  ['home', 'room', 'game', 'results'].forEach(s => { $('#' + s).hidden = s !== screen; });
  const el = $('#' + screen);
  el._mounted = false;
  if (screen === 'room') el.innerHTML = roomShell();
  if (screen === 'game') el.innerHTML = gameShell();
  if (screen === 'results') el.innerHTML = '';
  window.scrollTo(0, 0);
}

/* ---------- home ---------- */
function inviteCode() {
  const m = /^#([A-Za-z0-9]{5})$/.exec(location.hash);
  return m ? m[1].toUpperCase() : '';
}
function offlineNote() {
  return 'Rooms need the game server. Open the desktop app, or run "npm run server" and open the address it prints.';
}
function renderHome(message = '') {
  mount('home');
  const code = inviteCode(), saved = LocalLink.saved(), server = app.server;
  $('#home').innerHTML = `
  <div class="home">
    <header class="hero">
      <div class="brand">${GAVEL}<h1>IPL Auction <span>Room</span></h1></div>
      <p class="lede">Create a room, send the link to your friends and bid for real cricketers in Mega, Mini, Legends and Blitz auctions. Your personal AI scout tells you who to chase and how much to pay.</p>
    </header>
    ${message ? `<div class="invite-banner">${esc(message)}</div>` : ''}
    ${code ? `<div class="invite-banner"><span>You are invited to room <b class="mono">${code}</b>. Enter your name and press Join.</span></div>` : ''}
    <div class="card name-card">
      <div class="field"><label for="name">Your name</label><input class="input" id="name" maxlength="20" placeholder="Your name or nickname" autocomplete="nickname" value="${esc(app.name)}"></div>
    </div>
    <div class="home-actions">
      <section class="card action" style="--accent:var(--gold)">
        <p class="eyebrow">Multiplayer</p><h2>Create a room</h2>
        <p>Open a private room and share the code or the link. Up to 10 friends, one franchise each; the computer runs the rest.</p>
        ${server ? '' : `<p class="note">${offlineNote()}</p>`}
        <button type="button" class="btn btn-gold btn-lg" id="create" ${server ? '' : 'disabled'}>Create room</button>
      </section>
      <section class="card action" style="--accent:var(--sky)">
        <p class="eyebrow">Multiplayer</p><h2>Join a room</h2>
        <p>Got a room code or an invite link from a friend? Enter it here.</p>
        <div class="join-row"><input class="input" id="join-code" maxlength="80" placeholder="ABCDE" aria-label="Room code or invite link" value="${code}"><button type="button" class="btn btn-lg" id="join">Join</button></div>
        ${server ? '' : '<p class="note">Joining needs the game server too. An invite link from a friend opens it directly.</p>'}
      </section>
      <section class="card action" style="--accent:var(--ok)">
        <p class="eyebrow">Single player</p><h2>Play solo</h2>
        <p>Take on the computer franchises in any mode. Works offline, and your auction is saved as you play.</p>
        <div class="row"><button type="button" class="btn btn-lg" id="solo">New solo auction</button>${saved ? '<button type="button" class="btn btn-gold btn-lg" id="resume">Resume saved</button>' : ''}</div>
      </section>
    </div>
    <section class="stack">
      <p class="eyebrow">Four ways to auction</p>
      <div class="modes-strip">${MODE_ORDER.map(id => { const m = MODES[id], r = effectiveRules(id); return `<div class="mode-tile"><h3>${MODE_ICONS[id]}${m.name}</h3><p>${m.tagline}</p><div class="chips"><span class="chip">${cr(m.purse)}</span><span class="chip">${r.poolSize} players</span><span class="chip">${m.teams} teams</span></div></div>`; }).join('')}</div>
    </section>
    <p class="footer-note">Fan-made game, not affiliated with the IPL, BCCI or any franchise. Player stats are approximate career figures through 2025, rounded for gameplay.</p>
  </div>`;
}

function readName() {
  const input = $('#name');
  const name = (input ? input.value : app.name).trim().slice(0, 20);
  if (!name) { toast('Enter your name first.', true); if (input) input.focus(); return null; }
  app.name = name;
  store.set('name', name);
  return name;
}

function connect(kind, extra = {}) {
  const name = readName();
  if (!name) return;
  leaveLink();
  Object.assign(app, { solo: kind === 'solo', scout: [], scoutBusy: false, room: null, game: null, prev: null, chatSeen: 0, side: 'teams', online: true });
  if (app.solo) {
    app.link = new LocalLink(onMessage);
    app.link.open({ name, resume: !!extra.resume });
  } else {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    app.link = new SocketLink(url, onMessage, status => { app.online = status === 'online'; renderConn(); });
    const token = extra.room ? seat.get(extra.room) : null;
    app.link.open({ t: 'hello', name, create: !!extra.create, room: extra.room, token });
  }
}

function joinFromInput() {
  const raw = ($('#join-code').value || '').trim();
  if (!raw) return toast('Enter a room code or paste an invite link.', true);
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.host !== location.host) { location.href = u.href; return; }
      return joinCode(u.hash.slice(1));
    } catch { return toast('That link does not look right.', true); }
  }
  joinCode(raw);
}
function joinCode(code) {
  code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 5) return toast('Room codes have 5 letters and numbers.', true);
  if (!app.server) return toast(offlineNote(), true);
  connect('ws', { room: code });
}

function leaveLink() { if (app.link) { app.link.close(); app.link = null; } }
function goHome(message = '') {
  leaveLink();
  app.room = null; app.game = null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ }
  closeModal();
  renderHome(message);
}

/* ---------- messages from the room ---------- */
function onMessage(msg) {
  if (msg.t === 'welcome') {
    app.pid = msg.pid;
    app.roomId = msg.room;
    if (!app.solo) {
      seat.set(msg.room, msg.token);
      try { if (location.hash !== `#${msg.room}`) history.replaceState(null, '', `#${msg.room}`); } catch { /* sandboxed */ }
    }
    return;
  }
  if (msg.t === 'state') return applyState(msg);
  if (msg.t === 'scout-wait') { app.scoutBusy = true; return renderScout(); }
  if (msg.t === 'scout') { app.scoutBusy = false; app.scout.push({ who: 'bot', text: msg.text, source: msg.source }); return renderScout(); }
  if (msg.t === 'error') return msg.fatal ? goHome(msg.text) : toast(msg.text, true);
}

function applyState(msg) {
  app.room = msg.room;
  app.game = msg.game ? new AuctionGame(msg.game) : null;
  app.recvAt = performance.now();
  app.offset = msg.serverNow - Date.now();
  const screen = app.room.phase === 'lobby' ? 'room' : app.room.phase === 'game' ? 'game' : 'results';
  if (screen !== app.screen) mount(screen);
  moments();
  render();
  refreshModal();
}

// Sounds, toasts and confetti for what changed since the last snapshot.
function moments() {
  const g = app.game, prev = app.prev, mine = myTeamId();
  const l = g && g.lot;
  const now = { lot: l && l.pid, bids: l ? l.bids.length : 0, bidder: l && l.bidder, outcome: l && l.outcome, rtm: l && l.rtm && l.rtm.stage, round: g && g.s.round, phase: app.room.phase };
  app.prev = now;
  if (!prev || !g) return;
  const quiet = g.turbo();
  if (now.lot === prev.lot && now.bids > prev.bids) {
    if (!quiet) sfx('bid');
    if (prev.bidder === mine && now.bidder !== mine) toast(`Outbid by ${now.bidder}: now ${cr(l.bid)}`);
  }
  if (now.outcome && now.outcome !== prev.outcome && now.lot === prev.lot) {
    if (now.outcome === 'sold' && l.winner === mine) { sfx('win'); confetti(mine); toast(`You bought ${PLAYER[l.pid].name} for ${cr(l.price)}!`); }
    else if (now.outcome === 'sold' && !quiet) sfx('sold');
    else if (now.outcome === 'unsold' && !quiet) sfx('unsold');
  }
  if (now.rtm && now.rtm !== prev.rtm) sfx('tick');
  if (now.round === 2 && prev.round === 1) toast('Accelerated round: unsold players return with a shorter hammer.');
  if (now.phase === 'done' && prev.phase !== 'done') sfx('win');
}

function render() {
  if (app.screen === 'room') renderRoom();
  else if (app.screen === 'game') renderGame();
  else if (app.screen === 'results') renderResults();
}

function renderConn() {
  const el = $('#conn');
  if (!el) return;
  el.className = `conn${app.online ? '' : ' bad'}`;
  el.textContent = app.solo ? '' : app.online ? '● Connected' : '● Reconnecting…';
}

/* ---------- room lobby ---------- */
function roomShell() {
  return `
  <div class="topbar">
    <button type="button" class="btn btn-ghost btn-sm" id="leave">← Leave</button>
    <div id="room-code"></div><span id="conn" class="conn"></span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-sm" id="open-rules">Rules</button>
    <button type="button" class="btn btn-sm" id="open-pool">Player pool</button>
  </div>
  <div class="lobby-grid">
    <section class="card" id="mode-panel"></section>
    <section class="card" id="team-panel"></section>
    <div class="stack">
      <section class="card" id="players-panel"></section>
      <section class="card chat" id="lobby-chat" ${app.solo ? 'hidden' : ''}>
        <div><h3 class="mini-title">Room chat</h3><div class="chat-log" id="lobby-chat-log"></div></div>
        <form class="chat-form" data-chat><input class="input" id="lobby-chat-input" maxlength="240" placeholder="Say hi to the room" aria-label="Chat message" autocomplete="off"><button class="btn" type="submit">Send</button></form>
      </section>
    </div>
  </div>`;
}

function inviteLink() {
  const lan = app.server && app.server.lan && app.server.lan[0];
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const base = local && lan ? `http://${lan}:${app.server.port}/` : `${location.origin}${location.pathname}`;
  return `${base}#${app.roomId}`;
}

function renderRoom() {
  const room = app.room, s = room.settings, host = isHost(), r = currentRules();
  patch($('#room-code'), app.solo
    ? '<div class="room-code"><span class="eyebrow">Solo auction</span></div>'
    : `<div class="room-code"><span class="eyebrow">Room</span><b>${esc(room.id)}</b><button type="button" class="btn btn-sm" data-copy="code">Copy code</button><button type="button" class="btn btn-sm btn-gold" data-copy="link">Copy invite link</button></div>`);
  renderConn();

  const timerChoices = [[0, `Mode default (${MODES[s.mode].timer}s)`], [6, '6 seconds'], [10, '10 seconds'], [15, '15 seconds'], [20, '20 seconds']];
  patch($('#mode-panel'), `
    <h2 class="card-title"><small>1</small>Auction mode</h2>
    ${host ? '' : '<p class="hint" style="margin-top:8px">The host chooses the mode and settings.</p>'}
    <div class="mode-cards">${MODE_ORDER.map(id => `<button type="button" class="mode-card" data-mode="${id}" aria-pressed="${s.mode === id}" ${host ? '' : 'disabled'}><h3>${MODE_ICONS[id]}${MODES[id].name}</h3><p>${MODES[id].tagline}</p></button>`).join('')}</div>
    <div class="settings">
      <div class="field"><span class="label">Franchises</span>${host
        ? `<div class="stepper"><button type="button" class="btn" data-teams="-1" aria-label="Fewer franchises">−</button><b>${s.teams}</b><button type="button" class="btn" data-teams="1" aria-label="More franchises">+</button></div>`
        : `<b class="mono">${s.teams}</b>`}</div>
      <div class="field"><label for="set-timer">Hammer</label>${host
        ? `<select class="select" id="set-timer" data-setting="timer">${timerChoices.map(([v, l]) => `<option value="${v}" ${s.timer === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`
        : `<b>${s.timer || MODES[s.mode].timer} seconds</b>`}</div>
      <div class="field"><label for="set-ai">Computer bidding</label>${host
        ? `<select class="select" id="set-ai" data-setting="aggression">${Object.entries(AI_LEVELS).map(([v, l]) => `<option value="${v}" ${Number(v) === s.aggression ? 'selected' : ''}>${l}</option>`).join('')}</select>`
        : `<b>${AI_LEVELS[s.aggression]}</b>`}</div>
    </div>
    <div class="rule-chips">
      <span class="chip chip-gold">${cr(r.purse)} purse</span><span class="chip">Squad ${r.minSquad}–${r.maxSquad}</span>
      <span class="chip">Max ${r.maxOverseas} overseas</span><span class="chip">${r.poolSize} players</span>
      ${r.rtm ? `<span class="chip">${r.rtm} RTM cards</span>` : ''}${r.retain ? `<span class="chip">Keep ${r.retain} from 2025</span>` : ''}
      <span class="chip">${r.accelerated ? 'Accelerated round' : 'No second round'}</span>
    </div>`);

  const mine = myTeamId();
  patch($('#team-panel'), `
    <h2 class="card-title"><small>2</small>Pick your franchise</h2>
    <p class="hint" style="margin-top:8px">${s.teams} franchises take part. The computer runs every one nobody picks.${r.retain ? ' In the Mini Auction you inherit that team\'s 2025 core.' : ''}</p>
    <div class="team-grid">${TEAMS.map(t => {
      const owner = room.players.find(p => p.team === t.id);
      const isMine = owner && owner.pid === app.pid;
      const cls = isMine ? ' mine' : owner ? ' taken' : '';
      const who = isMine ? 'You' : owner ? esc(owner.name) : 'Open';
      return `<button type="button" class="team-tile${cls}" style="${teamVars(t.id)}" data-team="${t.id}" ${owner && !isMine ? 'disabled' : ''}>${badge(t.id)}<span class="tt-name">${esc(t.name)}<span class="tt-owner">${who}</span></span></button>`;
    }).join('')}</div>`);

  const everyone = room.players;
  const notReady = everyone.filter(p => !p.team || !p.ready);
  const self = me();
  let cta;
  if (!mine) cta = '<p class="hint">Pick a franchise to continue.</p>';
  else if (!self.ready) cta = '<button type="button" class="btn btn-gold btn-lg" id="read-rules">Read the rules &amp; ready up</button>';
  else cta = '<button type="button" class="btn btn-lg btn-on" data-ready="0">Ready ✓ (tap to undo)</button>';
  const startBtn = host
    ? `<button type="button" class="btn btn-gold btn-xl" id="start" ${notReady.length ? 'disabled' : ''}>Start the auction</button>
       <p class="hint">${notReady.length ? `Waiting for ${notReady.map(p => esc(p.name)).join(', ')}.` : 'Everyone is ready.'}</p>`
    : `<p class="hint">Waiting for ${esc((everyone.find(p => p.host) || {}).name || 'the host')} to start.</p>`;
  patch($('#players-panel'), `
    <h2 class="card-title"><small>3</small>${app.solo ? 'Get ready' : `Players · ${everyone.length}/10`}</h2>
    ${app.solo ? '' : `<p class="hint" style="margin-top:8px">Invite friends with the code <b class="mono">${esc(room.id)}</b> or the invite link.</p>`}
    <div class="players">${everyone.map(p => `<div class="player-row${p.pid === app.pid ? ' me' : ''}">
      ${p.team ? badge(p.team, true) : '<span class="badge badge-sm" style="--c1:#2c2660;--c2:#342d68;--ink:#7a74ab">—</span>'}
      <span class="pname">${esc(p.name)}${p.pid === app.pid ? ' (you)' : ''}</span>${p.host ? '<span class="host-tag">Host</span>' : ''}
      <span class="ready-dot${!p.connected ? ' away' : p.ready ? ' on' : ''}">${!p.connected ? 'Away' : p.ready ? 'Ready' : p.team ? 'Reading rules' : 'Choosing'}</span>
    </div>`).join('')}</div>
    <div class="lobby-cta">${cta}${startBtn}</div>`);

  renderChat('lobby');
}

function renderChat(where) {
  const log = $(`#${where}-chat-log`);
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  patch(log, app.room.chat.map(m => m.system
    ? `<p class="chat-msg system">${esc(m.text)}</p>`
    : `<p class="chat-msg">${m.team ? badge(m.team, true) + ' ' : ''}<b>${esc(m.name)}:</b> ${esc(m.text)}</p>`).join('') || '<p class="empty">No messages yet.</p>');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/* ---------- rules popup ---------- */
function rulesItems() {
  const r = currentRules(), room = app.room;
  const people = room ? room.players.filter(p => p.team).length || 1 : 1;
  const pool = r.mode === 'legends' ? `${r.poolSize} retired greats from every era, from Sachin and Lara to Warne and Wasim.`
    : r.mode === 'blitz' ? `Only the ${r.poolSize} highest-rated current players. Every lot matters.`
    : r.mode === 'mini' ? 'Every current player who was not retained: about a hundred names.'
    : `All ${r.poolSize} current players: marquee stars, batters, keepers, all-rounders, pacers, spinners and uncapped talent.`;
  const items = [
    ['The goal', `Build the strongest squad. When the last lot is sold, every franchise is ranked by the rating of its best XI${r.xiOverseas < 11 ? ` (at most ${r.xiOverseas} overseas players, a wicketkeeper and five bowling options)` : ' (a wicketkeeper and five bowling options; Legends has no overseas cap)'}.`],
    ['Purse and squad', `Every franchise gets ${cr(r.purse)}. Buy between ${r.minSquad} and ${r.maxSquad} players, with no more than ${r.maxOverseas} from overseas.`],
  ];
  if (r.retain) items.push(['Retentions', `Before bidding starts, every franchise keeps up to ${r.retain} of its 2025 players (at most ${r.retainOverseas} overseas), paid for from the purse. You start with that core and the money left over.`]);
  items.push(
    ['Player pool', pool],
    ['Sets', 'Players come up set by set: marquee names first, then batters, all-rounders, wicketkeepers, fast bowlers, spinners and uncapped players in rotation. The next six lots are always on screen.'],
    ['Bidding', 'Bidding opens at the base price (₹30 L to ₹2 Cr). Each bid adds ₹5 L below ₹1 Cr, ₹10 L up to ₹2 Cr, ₹20 L up to ₹5 Cr and ₹25 L above. You cannot raise your own bid.'],
    ['The hammer', `After every bid the timer resets to ${r.timer} seconds: going once at half time, going twice at a quarter, then sold. No bid at all means unsold.`],
    ['Purse reserve', `You must keep ₹30 L for every slot still needed to reach ${r.minSquad} players, so your highest bid is your purse minus that reserve.`],
  );
  if (r.rtm) items.push(['Right to Match', `Each franchise holds ${r.rtm} RTM cards for its 2025 players. When one sells to another team, the old team may match the price. The buyer then gets one final raise, which the old team must also match to keep the player.`]);
  items.push(
    [r.accelerated ? 'Accelerated round' : 'No second chances', r.accelerated ? 'Unsold players return once at the end with a hammer 40% shorter.' : 'Unsold players are gone for good, so plan your squad early.'],
    ['Computer franchises', `${Math.max(0, r.teams - people)} of the ${r.teams} franchises are run by the computer (${AI_LEVELS[r.aggression] || 'Balanced'}). They price players on form, squad needs and money left.`],
    ['Autopilot and disconnects', 'Switch on autopilot and the computer bids for your team; switch it off to take the paddle back. If you lose your connection, autopilot covers you until you return. When everyone is on autopilot the auction fast-forwards.'],
    ['Your AI scout', `Scout reads the live auction and gives you a verdict and a bid ceiling for every player. Ask it anything in the Scout tab${room && room.ai ? '; answers come from Claude' : ''}.`],
    ['Penalties', `Teams that finish below ${r.minSquad} players${r.minSpend ? ` or spend under ${r.minSpend * 100}% of the purse` : ''} are flagged in the results, and every missing XI player counts against the rating.`],
    ['Fair play', 'Only you can bid for your franchise. The host can pause the auction for everyone. Keep the chat friendly.'],
  );
  return items;
}

function rulesHTML() {
  const r = currentRules(), room = app.room, self = me();
  const canReady = room && room.phase === 'lobby' && self && self.team && !self.ready;
  return `<h2 id="modal-title">${MODE_ICONS[r.mode]} ${esc(r.modeName)} rules</h2>
    <p class="hint">${esc(MODES[r.mode].tagline)}</p>
    <ol class="rules-list">${rulesItems().map(([h, t]) => `<li><strong>${esc(h)}</strong>${esc(t)}</li>`).join('')}</ol>
    <div class="rules-foot">${canReady
      ? `<button type="button" class="btn btn-gold btn-lg" id="accept-rules">I understand the rules. I'm ready</button><button type="button" class="btn btn-lg btn-ghost" id="modal-cancel">Not yet</button>`
      : '<button type="button" class="btn btn-lg" id="modal-cancel">Close</button>'}</div>`;
}
function openRules() { openModal(rulesHTML(), { kind: 'rules' }); }

/* ---------- auction screen ---------- */
function gameShell() {
  return `
  <div class="game-head">
    <span class="set-label" id="set-label"></span><span class="chip mono" id="lot-count"></span><span id="round-chip"></span><span id="conn" class="conn"></span>
    <span class="spacer"></span>
    <button type="button" class="btn btn-sm" id="btn-pause" hidden></button>
    <button type="button" class="btn btn-sm" id="btn-auto"></button>
    <button type="button" class="btn btn-sm" id="btn-sound"></button>
    <button type="button" class="btn btn-sm" id="btn-squads">Squads</button>
    <button type="button" class="btn btn-sm" id="open-pool">Pool</button>
    <button type="button" class="btn btn-sm" id="open-rules">Rules</button>
    <button type="button" class="btn btn-sm btn-ghost" id="leave">Leave</button>
  </div>
  <div class="scoreboard" id="scoreboard" aria-live="polite">
    <div class="sb-player" id="sb-player"></div>
    <div class="sb-bid" id="sb-bid"></div>
    <div class="sb-clock"><div class="call" id="call"><span id="call-text"></span><span class="mono" id="secs"></span></div><div class="fuse"><i id="fuse"></i></div></div>
  </div>
  <div class="game-grid">
    <article class="card player-card" id="player-card"></article>
    <section class="card console" id="console">
      <button type="button" class="paddle" id="paddle"><span class="pt" id="paddle-team"></span><span class="pa" id="paddle-amt"></span><kbd>Space</kbd></button>
      <div class="console-row">
        <button type="button" class="btn btn-lg" id="pass">Pass</button>
        <button type="button" class="btn btn-lg" id="auto-quick"></button>
      </div>
      <p class="note" id="paddle-note"></p>
      <div id="console-dyn"></div>
    </section>
    <aside class="side">
      <div class="tabs" role="tablist" id="side-tabs"></div>
      <div id="side-teams" class="team-list"></div>
      <section id="side-scout" class="card scout">
        <div class="scout-log" id="scout-log" aria-live="polite"></div>
        <div class="quick">${['Who should I target?', 'How is my squad?', 'Budget plan', 'Is this player worth it?', 'Best keepers left'].map(q => `<button type="button" data-ask="${q}">${q}</button>`).join('')}</div>
        <form class="chat-form" id="scout-form"><input class="input" id="scout-input" maxlength="300" placeholder="Ask your scout…" aria-label="Ask your scout" autocomplete="off"><button class="btn btn-gold" type="submit">Ask</button></form>
      </section>
      <section id="side-chat" class="card chat">
        <div class="chat-log" id="game-chat-log"></div>
        <form class="chat-form" data-chat><input class="input" id="game-chat-input" maxlength="240" placeholder="Message the room" aria-label="Chat message" autocomplete="off"><button class="btn" type="submit">Send</button></form>
      </section>
    </aside>
  </div>
  <div class="game-foot">
    <section class="card"><h3 class="mini-title">Next on the block</h3><ol class="list" id="next-up"></ol></section>
    <section class="card"><h3 class="mini-title">Recent results</h3><ol class="list" id="recent"></ol></section>
  </div>
  <div class="countdown" id="countdown" hidden></div>`;
}

function renderGame() {
  const g = app.game;
  if (!g) return;
  const s = g.s, l = g.lot, mine = myTeam(), host = isHost();
  $('#set-label').textContent = l ? l.label : 'Starting';
  $('#lot-count').textContent = `Lot ${Math.max(1, s.lotNo)} of ${s.total}`;
  patch($('#round-chip'), s.round === 2 ? '<span class="chip chip-gold">Accelerated round</span>' : '');
  renderConn();
  const pause = $('#btn-pause');
  pause.hidden = !host;
  pause.textContent = s.status === 'paused' ? 'Resume' : 'Pause';
  const autoLabel = mine && mine.auto ? 'Autopilot on' : 'Autopilot';
  $('#btn-auto').textContent = autoLabel;
  $('#btn-auto').classList.toggle('btn-on', !!(mine && mine.auto));
  $('#btn-sound').textContent = app.sound ? 'Sound on' : 'Sound off';

  renderScoreboard();
  renderPlayerCard();
  renderConsole();
  renderSide();
  renderFoot();
}

function renderScoreboard() {
  const g = app.game, l = g.lot;
  if (!l) {
    patch($('#sb-player'), '<div><p class="eyebrow">On the block</p><p class="sb-name">Get ready</p></div>');
    patch($('#sb-bid'), '');
    return;
  }
  const pl = PLAYER[l.pid];
  patch($('#sb-player'), `${avatar(pl, 'sm')}<div style="min-width:0"><p class="eyebrow">On the block · ${esc(l.label)}</p>
    <p class="sb-name">${esc(pl.name)}</p><p class="sb-sub">${ROLES[pl.role]} · ${COUNTRIES[pl.country].name} · Rating ${pl.rating}</p></div>`);
  const amount = l.outcome === 'sold' ? l.price : l.bidder ? l.bid : l.base;
  const label = l.outcome === 'sold' ? 'Sold for' : l.outcome === 'unsold' ? 'Unsold' : l.bidder ? 'Current bid' : 'Base price';
  const leader = l.outcome === 'sold' ? `${badge(l.winner, true)} ${esc(TEAM_META[l.winner].name)}`
    : l.bidder ? `${badge(l.bidder, true)} ${l.bidder === myTeamId() ? 'You hold the bid' : `${esc(TEAM_META[l.bidder].name)} leads`}`
    : l.outcome === 'unsold' ? 'No bids' : 'Waiting for the first paddle';
  const el = $('#sb-bid'), key = `${l.pid}|${l.bids.length}`;
  const bump = el._key && el._key !== key && l.bids.length;
  el._key = key;
  patch(el, `<p class="eyebrow">${label}</p><p class="sb-amount${bump ? ' bump' : ''}" data-k="${key}">${cr(amount)}</p><div class="sb-leader">${leader}</div>`);
}

function callState() {
  const g = app.game, l = g && g.lot;
  if (!l) return ['', ''];
  if (g.s.status === 'paused') return ['Paused', 'once'];
  if (l.phase === 'intro') return [`Lot ${g.s.lotNo}`, ''];
  if (l.phase === 'result') return [l.outcome === 'sold' ? 'Sold!' : 'Unsold', ''];
  if (l.phase === 'rtm') return ['Right to Match', 'once'];
  const f = lotRemaining() / l.tMax;
  return f > 0.5 ? ['Bidding open', ''] : f > 0.25 ? ['Going once…', 'once'] : ['Going twice…', 'twice'];
}
function lotRemaining() {
  const g = app.game, l = g && g.lot;
  if (!l) return 0;
  if (g.s.status !== 'running') return l.t;
  return Math.max(0, l.t - (performance.now() - app.recvAt));
}
function tickClock() {
  if (app.screen !== 'game' || !app.game) return;
  const l = app.game.lot, fuse = $('#fuse');
  const cd = $('#countdown'), left = app.room.startsAt - (Date.now() + app.offset);
  if (left > 0 && app.room.phase === 'game') {
    cd.hidden = false;
    patch(cd, `<div><p class="eyebrow">${esc(app.game.cfg.modeName)}${myTeamId() ? ` · You are ${esc(TEAM_META[myTeamId()].name)}` : ''}</p><p class="num">${Math.ceil(left / 1000)}</p><h2>The auction begins</h2></div>`);
  } else cd.hidden = true;
  if (!l || !fuse) return;
  const live = l.phase === 'bidding' || l.phase === 'rtm';
  const rem = lotRemaining();
  fuse.style.width = `${(live ? Math.min(1, rem / l.tMax) : l.phase === 'intro' ? 1 : 0) * 100}%`;
  $('#secs').textContent = live ? `${(rem / 1000).toFixed(1)}s` : '';
  const [text, cls] = callState();
  if (app.lastCall !== text) {
    app.lastCall = text;
    $('#call-text').textContent = text;
    $('#call').className = `call ${cls}`;
    if ((text === 'Going once…' || text === 'Going twice…') && !app.game.turbo()) sfx('tick');
  }
}

function renderPlayerCard() {
  const l = app.game.lot, el = $('#player-card');
  if (!l) return patch(el, '<p class="empty">The first player is about to be called.</p>');
  const pl = PLAYER[l.pid];
  if (!pl.stats[app.fmt]) app.fmt = FORMATS.find(f => pl.stats[f]) || 'IPL';
  patch(el, playerHTML(pl));
}

function playerHTML(pl) {
  const g = app.game, co = COUNTRIES[pl.country];
  const fv = g ? g.value(pl) : fairValue(pl);
  const lo = Math.max(pl.base, round5(fv * 0.8)), hi = Math.max(pl.base, round5(fv * 1.2));
  const era = typeof pl.age === 'string' ? `Career ${pl.age}` : `${pl.age} yrs`;
  const rtmOn = g ? g.cfg.rtm > 0 : false;
  return `
  <header class="pc-head">${avatar(pl)}
    <div class="pc-id">
      <p class="eyebrow">${SETS[pl.set]} set · ${ROLES[pl.role]}</p>
      <h2 class="pc-name">${esc(pl.name)}</h2>
      <p class="pc-sub">${co.name} · ${era} · ${esc(pl.style)}</p>
      <div class="chips">${isOverseas(pl) ? '<span class="chip chip-os">Overseas</span>' : '<span class="chip">Indian</span>'}${pl.capped ? '<span class="chip">Capped</span>' : '<span class="chip chip-uc">Uncapped</span>'}${pl.id > 1000 ? '<span class="chip chip-gold">Legend</span>' : pl.prev ? `<span class="chip">2025: ${esc(TEAM_META[pl.prev].name)}</span>` : ''}${rtmOn && pl.prev ? `<span class="chip chip-gold">RTM: ${pl.prev}</span>` : ''}</div>
    </div>
  </header>
  <div class="figs">
    <div class="fig"><span class="label">Base price</span><b>${cr(pl.base)}</b></div>
    <div class="fig"><span class="label">Rating</span><b>${pl.rating}<small>/100</small></b><span class="meter"><i style="width:${pl.rating}%"></i></span></div>
    <div class="fig"><span class="label">Scout's value</span><b>${lo === hi ? cr(lo) : `${cr(lo)}–${cr(hi)}`}</b></div>
  </div>
  <div class="tabs" role="tablist" aria-label="Stats by format">${FORMATS.map(f => `<button type="button" role="tab" data-fmt="${f}" aria-selected="${f === app.fmt}" ${pl.stats[f] ? '' : 'disabled title="Did not play this format"'}>${f}</button>`).join('')}</div>
  ${statsHTML(pl, app.fmt)}
  ${chartHTML(pl)}`;
}

function statsHTML(pl, f) {
  const r = pl.stats[f];
  if (!r) return '<p class="empty" style="margin-top:12px">No matches in this format.</p>';
  const [m, runs, avg, sr, h, f50, hs, w, bavg, econ, best] = r;
  const bowler = isBowler(pl);
  const stat = (label, v, key = false) => `<div class="stat${key ? ' key' : ''}"><b>${v}</b><span>${label}</span></div>`;
  const bat = runs == null ? '' : `<div class="stat-group"><h4>Batting · ${f}</h4><div class="stat-grid">${stat('Matches', num(m))}${stat('Runs', num(runs), !bowler)}${stat('Average', num(avg))}${stat('Strike rate', num(sr), !bowler)}${stat('100s / 50s', `${h} / ${f50}`)}${stat('Highest', esc(hs))}</div></div>`;
  const bowl = !w && econ == null ? '' : `<div class="stat-group"><h4>Bowling · ${f}</h4><div class="stat-grid">${runs == null ? stat('Matches', num(m)) : ''}${stat('Wickets', num(w), bowler)}${stat('Average', num(bavg))}${stat('Economy', num(econ), bowler)}${stat('Best', esc(best))}</div></div>`;
  return bowler ? bowl + bat : bat + bowl;
}

function chartHTML(pl) {
  const series = idx => FORMATS.map(f => ({ f, played: !!pl.stats[f], v: pl.stats[f] ? pl.stats[f][idx] || 0 : 0 }));
  const bars = (title, data, color) => {
    const max = Math.max(...data.map(d => d.v));
    if (!max) return `<div><h4 class="mini-title">${title}</h4><p class="empty">None recorded.</p></div>`;
    return `<div><h4 class="mini-title">${title}</h4>${data.map(d => `<div class="bar-row"><span>${d.f}</span><span class="bar-track"><i style="width:${(d.v / max * 100).toFixed(1)}%;--bar:${color}"></i></span><span class="mono">${d.played ? d.v.toLocaleString('en-IN') : '—'}</span></div>`).join('')}</div>`;
  };
  const runs = bars('Career runs by format', series(1), 'var(--gold)');
  const wkts = bars('Career wickets by format', series(7), 'var(--live)');
  return `<div class="charts">${isBowler(pl) ? wkts + runs : runs + wkts}</div>`;
}

function renderConsole() {
  const g = app.game, l = g.lot, mine = myTeam();
  const paddle = $('#paddle'), pass = $('#pass'), quick = $('#auto-quick'), note = $('#paddle-note');
  const id = myTeamId();
  if (id) paddle.setAttribute('style', teamVars(id));
  $('#paddle-team').textContent = id || '';
  const amt = l && l.phase !== 'result' ? g.nextBid() : 0;
  const live = !!(l && l.phase === 'bidding' && g.s.status === 'running' && mine && !mine.auto);
  const leading = !!(l && mine && l.bidder === mine.id);
  const reason = l && mine ? g.blockReason(mine, PLAYER[l.pid], amt || PLAYER[l.pid].base) : null;
  const passed = !!(l && mine && l.out.includes(mine.id));
  $('#paddle-amt').innerHTML = mine && mine.auto ? 'Autopilot bidding<small>Switch it off to bid yourself</small>'
    : leading ? `Leading at ${cr(l.bid)}<small>Hold your nerve</small>`
    : l && l.phase === 'bidding' ? `Bid ${cr(amt)}<small>${esc(TEAM_META[id].name)}</small>`
    : `Wait for the call<small>${l && l.phase === 'intro' ? 'Next player coming up' : l && l.phase === 'rtm' ? 'Right to Match in progress' : 'Lot closed'}</small>`;
  paddle.disabled = !live || leading || !!reason;
  pass.disabled = !live || leading || passed;
  pass.textContent = passed ? 'Passed' : 'Pass';
  quick.textContent = mine && mine.auto ? 'Take the paddle back' : 'Autopilot';
  quick.classList.toggle('btn-on', !!(mine && mine.auto));
  note.textContent = !mine ? '' : reason && live ? reason
    : `Purse ${cr(mine.purse)} · Max bid ${cr(Math.max(0, g.maxBid(mine)))} · Squad ${mine.squad.length}/${g.cfg.maxSquad} · Overseas ${g.overseasCount(mine)}/${g.cfg.maxOverseas}`;

  let dyn = '';
  if (l && l.phase === 'rtm') dyn += rtmHTML();
  if (l && mine) {
    const tip = scoutTip(g, mine.id);
    if (tip) dyn += `<div class="tip ${tip.tone}"><div class="tip-head"><span class="eyebrow">Scout says</span><span class="tip-verdict">${esc(tip.verdict)}</span>${tip.maxBid ? `<span class="chip chip-gold">Max ${cr(tip.maxBid)}</span>` : ''}</div><ul>${tip.lines.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  }
  dyn += `<div class="trail"><h4 class="mini-title">Bids on this lot · ${l ? l.bids.length : 0}</h4>${l && l.bids.length
    ? `<ol>${l.bids.slice(-12).reverse().map(b => `<li>${badge(b.team, true)}<span>${esc(TEAM_META[b.team].name)}</span><span class="mono">${cr(b.amt)}</span></li>`).join('')}</ol>`
    : '<p class="empty">No paddles raised yet.</p>'}</div>`;
  if (l && l.phase === 'result') dyn += stampHTML();
  patch($('#console-dyn'), dyn);
}

function rtmHTML() {
  const g = app.game, l = g.lot, r = l.rtm, pl = PLAYER[l.pid], mine = myTeamId();
  const hn = esc(TEAM_META[r.team].name), bn = esc(TEAM_META[l.bidder].name);
  const holder = g.team(r.team), buyer = g.team(l.bidder);
  const myTurn = id => id === mine && g.isHumanTurn(id);
  const wait = id => `<p class="thinking">${id} is deciding</p>`;
  let body;
  if (r.stage === 'offer') {
    body = `<p><strong>${bn}</strong> won the bidding at <strong>${cr(r.price)}</strong>. ${esc(pl.name)} played for <strong>${hn}</strong> in 2025, so they can match that price.</p>` +
      (myTurn(r.team) ? `<div class="row"><button type="button" class="btn btn-gold" data-rtm="use">Use RTM card · ${holder.rtmLeft} left</button><button type="button" class="btn" data-rtm="decline">Let the player go</button></div>` : wait(r.team));
  } else if (r.stage === 'raise') {
    const amounts = [...new Set([increment(r.price), 50, 100, 200, 500].map(x => r.price + x))];
    body = `<p><strong>${hn}</strong> used a Right to Match card. <strong>${bn}</strong> gets one final raise above ${cr(r.price)}.</p>` +
      (myTurn(l.bidder) ? `<div class="row">${amounts.map(a => `<button type="button" class="btn" data-raise="${a}" ${g.blockReason(buyer, pl, a) ? 'disabled' : ''}>Raise to ${cr(a)}</button>`).join('')}<button type="button" class="btn btn-ghost" data-raise="0">No raise</button></div>` : wait(l.bidder));
  } else {
    body = `<p><strong>${bn}</strong> raised to <strong>${cr(r.raised)}</strong>. <strong>${hn}</strong> must match to keep the player.</p>` +
      (myTurn(r.team) ? `<div class="row"><button type="button" class="btn btn-gold" data-rtm="match" ${g.blockReason(holder, pl, r.raised) ? 'disabled' : ''}>Match ${cr(r.raised)}</button><button type="button" class="btn" data-rtm="decline">Decline</button></div>` : wait(r.team));
  }
  return `<div class="rtm-box"><h3>Right to Match</h3>${body}</div>`;
}

function stampHTML() {
  const l = app.game.lot, pl = PLAYER[l.pid];
  if (l.outcome === 'sold') {
    return `<div class="stamp-wrap"><div class="stamp" style="${teamVars(l.winner)}"><span class="stamp-word">Sold</span><strong>${esc(pl.name)}</strong><p>to ${esc(TEAM_META[l.winner].name)} for <b class="mono">${cr(l.price)}</b></p>${l.viaRtm ? '<span class="chip chip-gold">Right to Match</span>' : ''}</div></div>`;
  }
  return `<div class="stamp-wrap"><div class="stamp unsold"><span class="stamp-word">Unsold</span><strong>${esc(pl.name)}</strong><p>${app.game.s.round === 1 && app.game.cfg.accelerated ? 'Returns in the accelerated round' : 'No franchise bid'}</p></div></div>`;
}

function renderSide() {
  const unread = Math.max(0, app.room.chat.filter(m => !m.system).length - app.chatSeen);
  if (app.side === 'chat') app.chatSeen = app.room.chat.filter(m => !m.system).length;
  const tabs = [['teams', 'Franchises'], ['scout', 'Scout AI'], ...(app.solo ? [] : [['chat', 'Chat']])];
  patch($('#side-tabs'), tabs.map(([k, label]) => `<button type="button" role="tab" data-side="${k}" aria-selected="${app.side === k}">${label}${k === 'chat' && unread && app.side !== 'chat' ? `<span class="count">${unread}</span>` : ''}</button>`).join(''));
  $('#side-teams').hidden = app.side !== 'teams';
  $('#side-scout').hidden = app.side !== 'scout';
  $('#side-chat').hidden = app.side !== 'chat';
  if (app.side === 'teams') renderTeams();
  if (app.side === 'scout') renderScout();
  if (app.side === 'chat') renderChat('game');
}

function renderTeams() {
  const g = app.game, l = g.lot, cfg = g.cfg, mine = myTeamId();
  const owners = Object.fromEntries(app.room.players.filter(p => p.team).map(p => [p.team, p]));
  patch($('#side-teams'), g.s.teams.map(t => {
    const o = owners[t.id];
    const tag = t.id === mine ? '<em>You</em>' : o ? `<em>${esc(o.name)}</em>` : '';
    const leading = l && l.bidder === t.id && l.phase !== 'result';
    return `<button type="button" class="team-row${leading ? ' leading' : ''}${t.id === mine ? ' mine' : ''}" data-squad="${t.id}" style="${teamVars(t.id)}">
      ${badge(t.id)}
      <span class="tr-info"><span class="tr-name">${esc(TEAM_META[t.id].name)}${tag}${t.human && t.auto ? ' <em>Auto</em>' : ''}</span>
        <span class="purse"><i style="width:${Math.max(0, t.purse / cfg.purse * 100).toFixed(1)}%"></i></span>
        <span class="tr-stats mono">${cr(t.purse)} · ${t.squad.length}/${cfg.maxSquad} · OS ${g.overseasCount(t)}/${cfg.maxOverseas}</span></span>
      ${cfg.rtm ? `<span class="dots" title="Right to Match cards left">${'●'.repeat(t.rtmLeft)}${'○'.repeat(cfg.rtm - t.rtmLeft)}</span>` : '<span></span>'}
    </button>`;
  }).join(''));
}

function renderScout() {
  const log = $('#scout-log');
  if (!log) return;
  const intro = `<div class="bubble bot"><span class="src">Scout</span>I'm your personal scout. I watch every lot for ${myTeamId() ? esc(TEAM_META[myTeamId()].name) : 'your team'} and give a verdict on the Bid panel. Ask me who to target, how your squad looks, or whether a player is worth the money.</div>`;
  const bubbles = app.scout.map(m => m.who === 'you'
    ? `<div class="bubble you">${esc(m.text)}</div>`
    : `<div class="bubble bot"><span class="src">${m.source === 'claude' ? 'Scout · Claude' : 'Scout'}</span>${esc(m.text)}</div>`).join('');
  patch(log, intro + bubbles + (app.scoutBusy ? '<div class="bubble bot"><span class="thinking">Scouting</span></div>' : ''));
  log.scrollTop = log.scrollHeight;
}

async function askScout(text) {
  text = String(text || '').trim();
  if (!text) return;
  app.scout.push({ who: 'you', text });
  if (app.side !== 'scout') app.side = 'scout';
  const g = app.game, team = myTeamId();
  // In a claude.ai page the scout can ask Claude directly; otherwise the room answers.
  if (app.sample && g && team && !(app.room && app.room.ai)) {
    app.scoutBusy = true;
    renderSide();
    try {
      const { text: answer } = await app.sample(`${SCOUT_BRIEF}\n\nGame data right now:\n${scoutContext(g, team)}\n\nQuestion: ${text}`, { cache: false, modelTier: 'quick' });
      app.scout.push({ who: 'bot', text: answer, source: 'claude' });
    } catch (e) {
      if (e && ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) app.sample = null;
      app.scout.push({ who: 'bot', text: scoutAnswer(g, team, text), source: 'scout' });
    }
    app.scoutBusy = false;
    return renderSide();
  }
  renderSide();
  send({ t: 'ask', text });
}

function historyRow(h) {
  const pl = PLAYER[h.pid];
  const tail = h.team ? `${badge(h.team, true)}<span class="mono end">${cr(h.price)}${h.rtm ? ' · RTM' : ''}</span>` : '<span class="unsold">Unsold</span>';
  return `<li class="click" data-player="${pl.id}">${avatar(pl, 'xs')}<span class="nm">${esc(pl.name)}</span>${tail}</li>`;
}

function renderFoot() {
  const s = app.game.s;
  patch($('#next-up'), s.queue.slice(0, 6).map(q => {
    const pl = PLAYER[q.pid];
    return `<li class="click" data-player="${pl.id}">${avatar(pl, 'xs')}<span class="nm">${esc(pl.name)}</span><span class="role">${ROLES[pl.role]}</span><span class="mono end">${cr(pl.base)}</span></li>`;
  }).join('') || `<li class="empty">${s.round === 1 && s.unsold.length && app.game.cfg.accelerated ? 'Unsold players return next in the accelerated round.' : 'This is the final lot.'}</li>`);
  patch($('#recent'), s.history.slice(0, 6).map(historyRow).join('') || '<li class="empty">Nothing sold yet.</li>');
}

/* ---------- pool, player and squad popups ---------- */
const POOL_FILTERS = [['ALL', 'All'], ['BAT', 'Batters'], ['WK', 'Keepers'], ['AR', 'All-rounders'], ['FAST', 'Pace'], ['SPIN', 'Spin'], ['UC', 'Uncapped'], ['OS', 'Overseas']];
function poolIds() {
  if (app.game) {
    const ids = new Set([...app.game.s.queue.map(q => q.pid), ...app.game.s.history.map(h => h.pid), ...app.game.s.teams.flatMap(t => t.squad.map(x => x.pid))]);
    if (app.game.lot) ids.add(app.game.lot.pid);
    return [...ids];
  }
  return modePool(MODES[(app.room && app.room.settings.mode) || 'mega']);
}
function poolMatch(pl, key) {
  if (key === 'ALL') return true;
  if (key === 'UC') return !pl.capped;
  if (key === 'OS') return isOverseas(pl);
  return pl.role === key;
}
function statusOf(pid) {
  const g = app.game;
  if (!g) return '<span class="empty">In the pool</span>';
  for (const t of g.s.teams) { const x = t.squad.find(y => y.pid === pid); if (x) return `${badge(t.id, true)} <span class="mono">${cr(x.price)}</span>${x.retained ? ' <span class="chip">Retained</span>' : ''}`; }
  if (g.lot && g.lot.pid === pid && g.lot.phase !== 'result') return '<span class="chip chip-live">On the block</span>';
  if (g.s.history.some(h => h.pid === pid && !h.team)) return '<span class="unsold" style="margin:0">Unsold</span>';
  return '<span class="empty">Waiting</span>';
}
function poolTable() {
  const q = app.poolQuery.trim().toLowerCase();
  const rows = poolIds().map(id => PLAYER[id]).filter(pl => poolMatch(pl, app.poolRole) && (!q || pl.name.toLowerCase().includes(q) || COUNTRIES[pl.country].name.toLowerCase().includes(q)))
    .sort((a, b) => b.rating - a.rating);
  if (!rows.length) return '<p class="empty" style="padding:14px">No players match that search.</p>';
  return `<table><thead><tr><th>Player</th><th>Role</th><th>Country</th><th class="num">Base</th><th class="num">Rating</th><th>Status</th></tr></thead><tbody>
    ${rows.map(pl => `<tr class="click" tabindex="0" data-player="${pl.id}"><td><span class="cell-name">${avatar(pl, 'xs')}${esc(pl.name)}</span></td><td>${ROLES[pl.role]}</td><td>${COUNTRIES[pl.country].name}</td><td class="num">${cr(pl.base)}</td><td class="num">${pl.rating}</td><td>${statusOf(pl.id)}</td></tr>`).join('')}
  </tbody></table>`;
}
function openPool() {
  const ids = poolIds().map(id => PLAYER[id]);
  openModal(`<h2 id="modal-title">Player pool</h2>
    <div class="pill-tabs">${POOL_FILTERS.map(([k, label]) => `<button type="button" data-pool="${k}" aria-pressed="${app.poolRole === k}">${label} · ${ids.filter(pl => poolMatch(pl, k)).length}</button>`).join('')}</div>
    <input class="input" id="pool-search" type="search" placeholder="Search by name or country" aria-label="Search players" value="${esc(app.poolQuery)}">
    <div class="table-wrap" id="pool-table">${poolTable()}</div>`, { kind: 'pool' });
}
function openPlayer(pid, back = app.modalCtx) {
  const pl = PLAYER[pid];
  if (!pl.stats[app.fmt]) app.fmt = FORMATS.find(f => pl.stats[f]) || 'IPL';
  const backBtn = back && back.kind === 'pool' ? '<button type="button" class="btn btn-sm" data-back style="justify-self:start">← Back to the pool</button>'
    : back && back.kind === 'squad' ? `<button type="button" class="btn btn-sm" data-back style="justify-self:start">← Back to ${back.id}</button>` : '';
  openModal(`${backBtn}<div>${playerHTML(pl)}</div><p class="hint">Status: ${statusOf(pid)}</p>`, { kind: 'player', id: pid, back });
}
function squadHTML(teamId) {
  const g = app.game, t = g.team(teamId), cfg = g.cfg;
  const xi = new Set(g.bestXI(t).map(pl => pl.id));
  const kv = (k, v) => `<span class="kv"><span>${k}</span><b>${v}</b></span>`;
  const owner = app.room.players.find(p => p.team === teamId);
  const groups = ['BAT', 'WK', 'AR', 'FAST', 'SPIN'].map(role => ({ role, items: t.squad.filter(x => PLAYER[x.pid].role === role).sort((a, b) => b.price - a.price) }));
  return `<h2 id="modal-title">${esc(TEAM_META[teamId].name)}${owner ? ` · ${esc(owner.pid === app.pid ? 'You' : owner.name)}` : ' · Computer'}</h2>
    <div class="pill-tabs">${g.s.teams.map(x => `<button type="button" data-squad-tab="${x.id}" aria-pressed="${x.id === teamId}">${x.id}</button>`).join('')}</div>
    <div class="squad-head">${badge(teamId)}${kv('Purse left', cr(t.purse))}${kv('Spent', cr(cfg.purse - t.purse))}${kv('Players', `${t.squad.length}/${cfg.maxSquad}`)}${kv('Overseas', `${g.overseasCount(t)}/${cfg.maxOverseas}`)}${cfg.rtm ? kv('RTM left', t.rtmLeft) : ''}${kv('XI rating', g.strength(t))}</div>
    ${t.squad.length ? `<div class="role-groups">${groups.map(gr => `<div class="role-group"><h4 class="mini-title">${ROLES[gr.role]}s · ${gr.items.length}</h4>${gr.items.length
      ? `<ol class="list">${gr.items.map(x => { const pl = PLAYER[x.pid]; return `<li class="click" data-player="${pl.id}">${avatar(pl, 'xs')}<span class="nm">${esc(pl.name)}${xi.has(pl.id) ? ' <span class="xi">★ XI</span>' : ''}</span><span class="mono end">${cr(x.price)}${x.retained ? ' · kept' : x.rtm ? ' · RTM' : ''}</span></li>`; }).join('')}</ol>`
      : '<p class="empty">None yet.</p>'}</div>`).join('')}</div>` : '<p class="empty">No players yet.</p>'}`;
}
function openSquads(teamId) { if (app.game) openModal(squadHTML(teamId), { kind: 'squad', id: teamId }); }

/* ---------- results ---------- */
function renderResults() {
  const g = app.game;
  if (!g) return;
  const res = g.results(), mine = myTeamId(), host = isHost();
  const sold = g.s.history.filter(h => h.team);
  const owners = Object.fromEntries(app.room.players.filter(p => p.team).map(p => [p.team, p]));
  const who = id => id === mine ? 'You' : owners[id] ? esc(owners[id].name) : 'Computer';
  const myRank = res.findIndex(r => r.team.id === mine) + 1;
  const headline = res[0].team.id === mine ? 'You built the strongest squad!' : `${TEAM_META[res[0].team.id].name} win the auction`;
  const priciest = [...sold].sort((a, b) => b.price - a.price).slice(0, 8);
  const steals = sold.map(h => ({ ...h, ratio: g.value(PLAYER[h.pid]) / h.price })).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
  patch($('#results'), `
    <div class="topbar"><button type="button" class="btn btn-ghost btn-sm" id="leave">← Leave</button><span class="spacer"></span><button type="button" class="btn btn-sm" id="copy-results">Copy results</button></div>
    <header class="stack" style="gap:10px">
      <p class="eyebrow">${esc(g.cfg.modeName)} complete · ${sold.length} sold · ${cr(sold.reduce((a, h) => a + h.price, 0))} spent</p>
      <h1 class="display" style="font-size:clamp(38px,6vw,72px);line-height:.95">${esc(headline)}</h1>
      ${mine ? `<p class="lede muted" style="font-size:17px">${esc(TEAM_META[mine].name)} finished ${ordinal(myRank)} of ${res.length} with an XI rating of ${res[myRank - 1].strength}.</p>` : ''}
    </header>
    <div class="podium">${res.slice(0, 3).map((r, i) => `<div class="pod p${i + 1}" data-squad="${r.team.id}" style="cursor:pointer"><span class="place">${i + 1}</span>${badge(r.team.id)}<strong>${esc(TEAM_META[r.team.id].name)}</strong><span class="muted">${who(r.team.id)}</span><span class="score">${r.strength}</span><span class="eyebrow">XI rating</span></div>`).join('')}</div>
    <ol class="standings">${res.map((r, i) => `<li class="standing${r.team.id === mine ? ' mine' : ''}">
      <span class="rank">${i + 1}</span>${badge(r.team.id)}
      <span class="nm">${esc(TEAM_META[r.team.id].name)} · ${who(r.team.id)}${r.flags.length ? `<small>${esc(r.flags.join(' · '))}</small>` : ''}</span>
      <span class="kv"><span>Spent</span><b>${cr(r.spent)}</b></span><span class="kv"><span>Players</span><b>${r.team.squad.length}</b></span>
      <span class="kv score"><span>XI rating</span><b>${r.strength}</b></span>
      <button type="button" class="btn btn-sm" data-squad="${r.team.id}">Squad</button></li>`).join('')}</ol>
    <div class="results-grid">
      <section class="card"><h3 class="mini-title">Biggest buys</h3><ol class="list">${priciest.map(historyRow).join('')}</ol></section>
      <section class="card"><h3 class="mini-title">Best value for money</h3><ol class="list">${steals.map(historyRow).join('')}</ol></section>
    </div>
    <div class="row" style="margin-top:18px">${host ? `<button type="button" class="btn btn-gold btn-lg" id="to-lobby">${app.solo ? 'Play again' : 'Back to the lobby'}</button>` : '<p class="hint">The host can take everyone back to the lobby for another auction.</p>'}<button type="button" class="btn btn-lg" id="leave-2">Leave room</button></div>`);
}

function resultsText() {
  const g = app.game, lines = [`IPL Auction Room · ${g.cfg.modeName} results`, ''];
  g.results().forEach((r, i) => {
    lines.push(`${i + 1}. ${TEAM_META[r.team.id].name}: XI rating ${r.strength}, ${r.team.squad.length} players, ${cr(r.spent)} spent`);
    const top = [...r.team.squad].sort((a, b) => b.price - a.price).slice(0, 3).map(x => `${PLAYER[x.pid].name} ${cr(x.price)}`);
    if (top.length) lines.push(`   Top buys: ${top.join(', ')}`);
  });
  return lines.join('\n');
}

function copyText(text, done) {
  const fallback = () => {
    openModal(`<h2 id="modal-title">Copy</h2><p class="hint">Select the text and copy it.</p><textarea class="input" rows="10" readonly>${esc(text)}</textarea>`);
    const ta = $('#modal-body textarea'); ta.focus(); ta.select();
  };
  try { navigator.clipboard.writeText(text).then(() => toast(done), fallback); } catch { fallback(); }
}

function confirmLeave() {
  const inGame = app.room && app.room.phase === 'game';
  if (!inGame) return goHome();
  openModal(`<h2 id="modal-title">Leave the auction?</h2>
    <p class="muted">${app.solo ? 'Your solo auction is saved on this device. Resume it from the home screen.' : 'The computer takes over your franchise. Rejoin with the same link to get it back.'}</p>
    <div class="row"><button type="button" class="btn btn-gold" id="confirm-leave">Leave</button><button type="button" class="btn" id="modal-cancel">Keep bidding</button></div>`);
}

/* ---------- input ---------- */
document.addEventListener('click', e => {
  if (e.target === $('#modal')) return closeModal();
  const el = e.target.closest('button, [data-player], [data-squad]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (el.id) {
    case 'modal-x': case 'modal-cancel': return closeModal();
    case 'create': return connect('ws', { create: true });
    case 'join': return joinFromInput();
    case 'solo': LocalLink.clearSaved(); return connect('solo');
    case 'resume': return connect('solo', { resume: true });
    case 'leave': case 'leave-2': return confirmLeave();
    case 'confirm-leave': return goHome();
    case 'open-rules': case 'read-rules': return openRules();
    case 'accept-rules':
      send({ t: 'ready', on: true });
      closeModal();
      return toast(isHost() ? "You're ready. Press Start when everyone else is too." : "You're ready. Waiting for the host to start.");
    case 'open-pool': return openPool();
    case 'start': return send({ t: 'start' });
    case 'paddle': return send({ t: 'bid' });
    case 'pass': return send({ t: 'pass' });
    case 'auto-quick': case 'btn-auto': { const t = myTeam(); return send({ t: 'auto', on: !(t && t.auto) }); }
    case 'btn-pause': return send({ t: 'pause', on: app.game.s.status === 'running' });
    case 'btn-sound': app.sound = !app.sound; store.set('sound', app.sound); return renderGame();
    case 'btn-squads': return openSquads(myTeamId() || app.game.s.teams[0].id);
    case 'to-lobby': return send({ t: 'lobby' });
    case 'copy-results': return copyText(resultsText(), 'Results copied.');
  }
  if (d.copy) return copyText(d.copy === 'code' ? app.room.id : inviteLink(), d.copy === 'code' ? `Room code ${app.room.id} copied.` : 'Invite link copied. Send it to your friends!');
  if (d.mode) return send({ t: 'settings', mode: d.mode });
  if (d.teams) return send({ t: 'settings', teams: app.room.settings.teams + Number(d.teams) });
  if (d.team) return send({ t: 'team', team: d.team });
  if (d.ready === '0') return send({ t: 'ready', on: false });
  if (d.rtm) return send({ t: 'rtm', choice: d.rtm });
  if (d.raise !== undefined) return send({ t: 'raise', amount: Number(d.raise) });
  if (d.side) { app.side = d.side; return renderSide(); }
  if (d.ask) return askScout(d.ask);
  if (d.fmt) {
    app.fmt = d.fmt;
    if (el.closest('#modal')) return openPlayer(app.modalCtx.id, app.modalCtx.back);
    return renderPlayerCard();
  }
  if (d.player) return openPlayer(Number(d.player), !$('#modal').hidden ? app.modalCtx : null);
  if (d.back !== undefined) {
    const back = app.modalCtx && app.modalCtx.back;
    if (back && back.kind === 'pool') return openPool();
    if (back && back.kind === 'squad') return openSquads(back.id);
    return closeModal();
  }
  if (d.pool) { app.poolRole = d.pool; return openPool(); }
  if (d.squadTab) return openSquads(d.squadTab);
  if (d.squad) return openSquads(d.squad);
});

document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'scout-form') { const input = $('#scout-input'); askScout(input.value); input.value = ''; return; }
  if (form.dataset.chat !== undefined) { const input = form.querySelector('input'); if (input.value.trim()) send({ t: 'chat', text: input.value }); input.value = ''; }
});

document.addEventListener('change', e => {
  const key = e.target.dataset.setting;
  if (key) send({ t: 'settings', [key]: Number(e.target.value) });
});

document.addEventListener('input', e => {
  if (e.target.id === 'pool-search') { app.poolQuery = e.target.value; $('#pool-table').innerHTML = poolTable(); }
  if (e.target.id === 'name') app.name = e.target.value;
});

document.addEventListener('keydown', e => {
  if (!$('#modal').hidden) {
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'Enter' && e.target.dataset && e.target.dataset.player) openPlayer(Number(e.target.dataset.player));
    return;
  }
  if (app.screen === 'home' && e.key === 'Enter' && e.target.id === 'join-code') return joinFromInput();
  if (app.screen !== 'game' || e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space' || e.key === 'b' || e.key === 'B') { e.preventDefault(); send({ t: 'bid' }); }
  else if (e.key === 'p' || e.key === 'P') send({ t: 'pass' });
});
// Space is the bid key, so it must not also press whichever button has focus.
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && app.screen === 'game' && $('#modal').hidden && e.target.closest('button')) e.preventDefault();
});

window.addEventListener('hashchange', () => { if (app.screen === 'home') renderHome(); });

(function loop() { requestAnimationFrame(loop); tickClock(); })();

async function boot() {
  renderHome();
  if (/^https?:$/.test(location.protocol)) {
    try {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 2500);
      const info = await (await fetch('api/info', { signal: ctl.signal, cache: 'no-store' })).json();
      if (info && info.app === 'ipl-auction-room') app.server = info;
    } catch { /* no game server: solo only */ }
  }
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('sample').then(s => { app.sample = s; }).catch(() => {});
  }
  if (app.screen !== 'home') return;
  renderHome();
  // A reload inside a room rejoins it as the same player.
  const code = inviteCode();
  if (code && app.server && app.name && seat.get(code)) connect('ws', { room: code });
}
boot();
