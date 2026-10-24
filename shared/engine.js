'use strict';
/* Auction engine: rules, lot flow, computer bidding, right-to-match, retentions and scoring.
   No DOM or network access. It runs on the room server, or in the page for solo play; clients
   also wrap a received state snapshot in an AuctionGame to ask rule questions (next bid, limits).
   All money is in lakhs (100 L = ₹1 Cr). */

const ALL_PLAYERS = [...PLAYERS, ...LEGENDS];
const PLAYER = Object.fromEntries(ALL_PLAYERS.map(pl => [pl.id, pl]));
const TEAM_META = Object.fromEntries(TEAMS.map(t => [t.id, t]));
const MIN_SLOT = 30;          // lakhs held back for each slot still needed to reach the minimum squad
const TURBO_HAMMER = 1100;    // ms on the hammer when no human is in the lot
const ROLE_MIX = { BAT: 5, WK: 2, AR: 5, FAST: 5, SPIN: 3 }; // computer squad shape for 20 players

function fmtAmt(l) { return l >= 100 ? `₹${(l / 100).toFixed(2)} Cr` : `₹${l} L`; }
function increment(amount) { return amount < 100 ? 5 : amount < 200 ? 10 : amount < 500 ? 20 : 25; }
const rand = (a, b) => a + Math.random() * (b - a);
const round5 = v => Math.round(v / 5) * 5;
const isOverseas = pl => pl.country !== 'IND';
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// Neutral market value: the scout's estimate and the base of computer valuations.
function fairValue(pl, scale = 1) {
  const r = Math.max(0, pl.rating - 58);
  return round5(pl.base + r * r * 1.45 * scale);
}

// Marquee sets first, then rotating sets by category, strongest players in the earlier sets.
function buildQueue(ids, setSize) {
  const chunk = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
  const bySet = set => ids.map(id => PLAYER[id]).filter(pl => pl.set === set).sort((a, b) => b.rating - a.rating).map(pl => pl.id);
  const queue = [];
  chunk(bySet('MQ'), 6).forEach((list, i) => shuffle(list).forEach(pid => queue.push({ pid, label: `Marquee set ${i + 1}` })));
  const order = ['BA', 'AL', 'WK', 'FA', 'SP', 'UC'];
  const groups = Object.fromEntries(order.map(s => [s, chunk(bySet(s), setSize)]));
  const rounds = Math.max(0, ...order.map(s => groups[s].length));
  for (let r = 0; r < rounds; r++) {
    for (const s of order) if (groups[s][r]) shuffle(groups[s][r]).forEach(pid => queue.push({ pid, label: `${SETS[s]} set ${r + 1}` }));
  }
  return queue;
}

class AuctionGame {
  constructor(state) {
    this.s = state;
    this.handlers = {};
    this.interval = null;
    this.last = 0;
  }

  // teamIds: franchises in this auction; humans: the ones people control.
  static fresh({ mode = 'mega', teamIds, humans = [], timer, aggression }) {
    const cfg = effectiveRules(mode, { teams: teamIds.length, timer, aggression });
    const teams = teamIds.map(id => ({
      id, human: humans.includes(id), auto: false, purse: cfg.purse, startPurse: cfg.purse,
      squad: [], rtmLeft: cfg.rtm, mood: +rand(0.88, 1.12).toFixed(3), initial: 0, plan: cfg.targetSquad,
    }));
    let pool = modePool(MODES[mode]);
    if (cfg.retain) {
      const kept = new Set();
      for (const t of teams) {
        const core = PLAYERS.filter(pl => pl.prev === t.id).sort((a, b) => b.rating - a.rating);
        let os = 0;
        for (const pl of core) {
          if (t.squad.length >= cfg.retain) break;
          if (isOverseas(pl) && os >= cfg.retainOverseas) continue;
          const price = Math.max(pl.base, round5(fairValue(pl) * 0.85));
          if (t.purse - price < cfg.retainFloor) continue;
          t.squad.push({ pid: pl.id, price, retained: true, round: 0 });
          t.purse -= price;
          if (isOverseas(pl)) os++;
          kept.add(pl.id);
        }
        t.startPurse = t.purse;
        t.initial = t.squad.length;
        t.plan = Math.max(1, cfg.targetSquad - t.initial);
      }
      pool = pool.filter(id => !kept.has(id));
    }
    const queue = buildQueue(pool, cfg.setSize);
    return new AuctionGame({
      v: 2, cfg, teams, queue, total: queue.length, lotNo: 0, round: 1,
      unsold: [], history: [], lot: null, status: 'running', startedAt: Date.now(),
    });
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  emit(evt, data) {
    (this.handlers[evt] || []).forEach(fn => fn(data));
    (this.handlers['*'] || []).forEach(fn => fn(evt, data));
  }

  /* ---------- queries ---------- */
  get cfg() { return this.s.cfg; }
  get lot() { return this.s.lot; }
  team(id) { return this.s.teams.find(t => t.id === id); }
  humans() { return this.s.teams.filter(t => t.human); }
  isBot(team) { return !team.human || team.auto; }
  isHumanTurn(teamId) { const t = this.team(teamId); return !!t && !this.isBot(t); }
  overseasCount(team) { return team.squad.filter(x => isOverseas(PLAYER[x.pid])).length; }
  roleCounts(team) {
    const c = { BAT: 0, WK: 0, AR: 0, FAST: 0, SPIN: 0 };
    team.squad.forEach(x => c[PLAYER[x.pid].role]++);
    return c;
  }
  roleTargets() {
    const k = this.cfg.targetSquad / 20;
    return Object.fromEntries(Object.entries(ROLE_MIX).map(([r, n]) => [r, Math.max(1, Math.round(n * k))]));
  }
  reserve(team) { return Math.max(0, this.cfg.minSquad - team.squad.length - 1) * MIN_SLOT; }
  maxBid(team) { return team.purse - this.reserve(team); }
  value(pl) { return fairValue(pl, this.cfg.valueScale); }

  blockReason(team, pl, amount) {
    if (team.squad.length >= this.cfg.maxSquad) return 'Squad is full';
    if (isOverseas(pl) && this.overseasCount(team) >= this.cfg.maxOverseas) return 'Overseas slots full';
    if (amount > team.purse) return 'Not enough purse';
    if (amount > this.maxBid(team)) return `Keep ${fmtAmt(this.reserve(team))} for min squad`;
    return null;
  }

  nextBid() {
    const l = this.s.lot;
    return l.bidder ? l.bid + increment(l.bid) : l.base;
  }

  // A person is "in" the lot while they hold the bid or could still raise it.
  humanEngaged() {
    const l = this.s.lot;
    if (!l) return false;
    const pl = PLAYER[l.pid], amt = this.nextBid();
    return this.s.teams.some(t => !this.isBot(t) && (l.bidder === t.id || (!l.out.includes(t.id) && !this.blockReason(t, pl, amt))));
  }
  turbo() { return !this.humanEngaged(); }
  hammerTime() { return this.turbo() ? TURBO_HAMMER : this.cfg.timer * 1000 * (this.s.round === 2 ? 0.6 : 1); }
  // Early bids fly in; the room slows down as the price nears what the computer franchises will pay.
  aiDelay() {
    if (this.turbo()) return rand(60, 180);
    return this.aiHeadroom() > 1.6 ? rand(140, 360) : rand(450, 1300);
  }
  aiHeadroom() {
    const l = this.s.lot;
    if (!l || !l.bidder) return 0;
    const top = Math.max(0, ...this.s.teams.filter(t => this.isBot(t) && t.id !== l.bidder).map(t => l.val[t.id] || 0));
    return top / this.nextBid();
  }
  setClock(ms) { this.s.lot.t = ms; this.s.lot.tMax = ms; this.emit('clock'); }

  /* ---------- run loop ---------- */
  run() {
    this.stop();
    if (this.s.status === 'done') return;
    this.s.status = 'running';
    this.last = Date.now();
    this.interval = setInterval(() => this.tick(), 100);
    if (!this.s.lot) this.beginLot();
  }
  stop() { clearInterval(this.interval); this.interval = null; }
  // After restoring a saved game: a lot interrupted mid-bidding starts again, a settled one moves on.
  resumeLot() {
    const l = this.s.lot;
    if (l && l.phase !== 'result') { this.s.queue.unshift({ pid: l.pid, label: l.label }); this.s.lotNo--; }
    this.s.lot = null;
  }
  setPaused(paused) {
    if (this.s.status === 'done') return;
    this.s.status = paused ? 'paused' : 'running';
    this.last = Date.now();
    this.emit('status');
  }
  setAuto(teamId, on) {
    const t = this.team(teamId);
    if (!t || !t.human || t.auto === on) return;
    t.auto = on;
    const l = this.s.lot;
    if (on && l && l.phase === 'bidding' && this.turbo()) this.setClock(Math.min(l.t, TURBO_HAMMER));
    this.emit('status');
  }

  // Time warp: when every person is on autopilot the auction runs 40 steps per tick.
  warp() { return this.s.teams.some(t => !this.isBot(t)) ? 1 : 40; }

  tick() {
    const now = Date.now();
    const dt = Math.min(250, now - this.last);
    this.last = now;
    for (let i = 0, n = this.warp(); i < n && this.s.status === 'running' && this.s.lot; i++) this.step(dt);
  }

  step(dt) {
    const l = this.s.lot;
    l.t -= dt;
    if (l.phase === 'intro') {
      if (l.t <= 0) { l.phase = 'bidding'; this.setClock(this.hammerTime()); l.aiWait = this.aiDelay(); this.emit('phase'); }
    } else if (l.phase === 'bidding') {
      if (this.turbo() && l.t > TURBO_HAMMER) this.setClock(TURBO_HAMMER);
      l.aiWait -= dt;
      if (l.aiWait <= 0) { this.aiAct(); l.aiWait = this.aiDelay(); }
      if (l.t <= 0) this.hammer();
    } else if (l.phase === 'rtm') {
      if (l.t <= 0) this.rtmTimeout();
    } else if (l.phase === 'result') {
      if (l.t <= 0) this.beginLot();
    }
  }

  noBuyersLeft() { return this.s.teams.every(t => t.squad.length >= this.cfg.maxSquad || this.maxBid(t) < MIN_SLOT); }

  beginLot() {
    const s = this.s;
    if (!s.queue.length) {
      if (s.round === 1 && s.unsold.length && this.cfg.accelerated) {
        s.round = 2;
        s.queue = shuffle(s.unsold.splice(0)).map(pid => ({ pid, label: 'Accelerated round' }));
        s.total = s.lotNo + s.queue.length;
        this.emit('round', s.queue.length);
      } else return this.finish();
    }
    if (this.noBuyersLeft()) return this.finish();
    const { pid, label } = s.queue.shift();
    const pl = PLAYER[pid];
    s.lotNo++;
    const val = {};
    s.teams.forEach(t => { val[t.id] = this.valuation(t, pl); });
    s.lot = { pid, label, base: pl.base, bid: 0, bidder: null, bids: [], out: [], val, phase: 'intro', t: 0, tMax: 0, aiWait: 0, outcome: null, rtm: null };
    this.setClock(this.turbo() ? 350 : 1800);
    this.emit('lot', s.lot);
  }

  /* ---------- computer franchises ---------- */
  valuation(team, pl) {
    if (!this.isBot(team) || this.blockReason(team, pl, pl.base)) return 0;
    const cfg = this.cfg;
    const have = this.roleCounts(team)[pl.role], want = this.roleTargets()[pl.role];
    let need = have < want ? 1 + 0.15 * (want - have) / want : have < want + 2 ? 0.7 : 0.35;
    if (pl.role === 'WK' && have === 0) need *= 1.08;
    const bought = team.squad.length - team.initial;
    const perSlotNow = team.purse / Math.max(1, team.plan - bought);
    const pace = Math.min(1.2, Math.max(0.5, perSlotNow / (team.startPurse / team.plan)));
    const short = team.squad.length < cfg.minSquad;
    let interest = Math.min(1, 0.3 + (pl.rating - 60) / 40) * Math.min(1, need);
    // Keep pace with the auction: a franchise behind schedule chases bodies, a full one sits back.
    const expected = this.s.round === 2 ? cfg.minSquad : team.initial + (this.s.lotNo / this.s.total) * team.plan;
    if (team.squad.length < expected - 2) { interest = Math.max(interest, 0.85); need *= 1.1; }
    if (team.squad.length >= cfg.targetSquad) interest *= this.s.round === 2 ? 0.25 : 0.45;
    // Scarcity: once the players left barely cover every franchise's minimum, full squads step aside.
    const deficit = this.s.teams.reduce((a, t) => a + Math.max(0, cfg.minSquad - t.squad.length), 0);
    const left = this.s.queue.length + (this.s.round === 1 && cfg.accelerated ? this.s.unsold.length * 0.6 : 0);
    if (!short && deficit && left < deficit * 1.6) interest *= 0.2;
    if ((this.s.round === 2 || !cfg.accelerated) && short) interest = Math.max(interest, 0.9);
    if (Math.random() > interest) return 0;
    let v = this.value(pl) * need * pace * team.mood * cfg.aggression * rand(0.9, 1.1);
    if (team.squad.length >= cfg.targetSquad + 1) v *= 0.7;
    if (team.squad.length >= cfg.maxSquad - 3) v *= 0.6;
    if (isOverseas(pl) && this.overseasCount(team) >= cfg.maxOverseas - 2) v *= 0.75;
    // Budget discipline: cap any one player, and hold money back for the slots still to fill.
    const perSlotReserve = Math.min(100, (team.startPurse / team.plan) * 0.4);
    const keepBack = Math.max(0, cfg.targetSquad - team.squad.length - 1) * perSlotReserve;
    v = Math.min(v, team.startPurse * cfg.capShare * cfg.aggression, team.purse * 0.45, team.purse - keepBack);
    if ((this.s.round === 2 || !cfg.accelerated) && short) v = Math.max(v, pl.base * 1.25);
    return Math.max(0, Math.min(Math.round(v), this.maxBid(team)));
  }

  aiAct() {
    const l = this.s.lot, pl = PLAYER[l.pid], amt = this.nextBid();
    const keen = [];
    for (const t of this.s.teams) {
      if (!this.isBot(t) || t.id === l.bidder || l.out.includes(t.id)) continue;
      if ((l.val[t.id] || 0) < amt || this.blockReason(t, pl, amt)) { l.out.push(t.id); continue; }
      keen.push(t);
    }
    if (!keen.length) return;
    if (!this.turbo() && l.t > 3000 && this.aiHeadroom() <= 1.6 && Math.random() < 0.3) return; // let the room breathe
    const w = keen.map(t => (l.val[t.id] - amt) / l.val[t.id] + 0.15);
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    const pick = keen.find((t, i) => (r -= w[i]) <= 0) || keen[keen.length - 1];
    this.placeBid(pick.id, true);
  }

  /* ---------- bidding ---------- */
  placeBid(teamId, byComputer = false) {
    const l = this.s.lot;
    if (!l || l.phase !== 'bidding' || l.bidder === teamId || this.s.status !== 'running') return false;
    const team = this.team(teamId);
    if (!team || this.isBot(team) !== byComputer) return false; // autopilot owns a paddle until switched off
    const amt = this.nextBid();
    if (this.blockReason(team, PLAYER[l.pid], amt)) return false;
    l.out = l.out.filter(id => id !== teamId);
    l.bid = amt;
    l.bidder = teamId;
    l.bids.push({ team: teamId, amt });
    this.setClock(this.hammerTime());
    this.emit('bid', { team: teamId, amt });
    return true;
  }

  pass(teamId) {
    const l = this.s.lot;
    if (!l || l.phase !== 'bidding' || l.bidder === teamId || l.out.includes(teamId)) return;
    l.out.push(teamId);
    if (this.turbo() && l.t > TURBO_HAMMER) this.setClock(TURBO_HAMMER);
    this.emit('pass', teamId);
  }

  hammer() {
    const l = this.s.lot, pl = PLAYER[l.pid];
    if (!l.bidder) return this.settle(null, 0);
    const holder = pl.prev && this.team(pl.prev);
    if (this.cfg.rtm > 0 && holder && holder.id !== l.bidder && holder.rtmLeft > 0 && !this.blockReason(holder, pl, l.bid)) {
      l.phase = 'rtm';
      l.rtm = { team: holder.id, stage: 'offer', price: l.bid, raised: null };
      this.emit('rtm', l.rtm);
      this.setClock(this.isHumanTurn(holder.id) ? 20000 : 1500);
      return;
    }
    this.settle(l.bidder, l.bid);
  }

  /* ---------- right to match ----------
     offer: the player's 2025 franchise may match the hammer price.
     raise: if it does, the buyer gets one final raise.
     match: the old franchise must match the raised price to keep the player. */
  rtmTimeout() {
    const l = this.s.lot, r = l.rtm;
    if (r.stage === 'offer') this.rtmOffer(this.isHumanTurn(r.team) ? false : this.aiWantsRtm(this.team(r.team), r.price));
    else if (r.stage === 'raise') this.rtmRaise(this.isHumanTurn(l.bidder) ? null : this.aiRaise(this.team(l.bidder), r.price));
    else if (r.stage === 'match') this.rtmMatch(this.isHumanTurn(r.team) ? false : this.aiWantsRtm(this.team(r.team), r.raised));
  }

  aiWantsRtm(team, price) {
    const l = this.s.lot, pl = PLAYER[l.pid];
    const v = Math.max(l.val[team.id] || 0, this.value(pl) * team.mood * this.cfg.aggression * rand(0.8, 1.05));
    return v >= price && !this.blockReason(team, pl, price);
  }

  aiRaise(team, price) {
    const v = this.s.lot.val[team.id] || 0, cap = this.maxBid(team);
    if (v < price * 1.08 || cap <= price) return null;
    const amt = round5(Math.min(cap, price + (v - price) * rand(0.5, 1)));
    return amt > price ? amt : null;
  }

  rtmOffer(accept) {
    const l = this.s.lot;
    if (!l || l.phase !== 'rtm' || l.rtm.stage !== 'offer') return;
    if (!accept) return this.settle(l.bidder, l.rtm.price);
    l.rtm.stage = 'raise';
    this.emit('rtm', l.rtm);
    this.setClock(this.isHumanTurn(l.bidder) ? 25000 : 1500);
  }

  rtmRaise(amount) {
    const l = this.s.lot;
    if (!l || l.phase !== 'rtm' || l.rtm.stage !== 'raise') return;
    const r = l.rtm, holder = this.team(r.team), buyer = this.team(l.bidder), pl = PLAYER[l.pid];
    if (amount && amount > r.price && !this.blockReason(buyer, pl, amount)) {
      if (this.blockReason(holder, pl, amount)) return this.settle(buyer.id, amount); // old franchise cannot afford to match
      r.raised = amount;
      r.stage = 'match';
      this.emit('rtm', r);
      this.setClock(this.isHumanTurn(holder.id) ? 20000 : 1500);
      return;
    }
    this.settle(holder.id, r.price, true);
  }

  rtmMatch(accept) {
    const l = this.s.lot;
    if (!l || l.phase !== 'rtm' || l.rtm.stage !== 'match') return;
    if (accept) this.settle(l.rtm.team, l.rtm.raised, true);
    else this.settle(l.bidder, l.rtm.raised);
  }

  settle(teamId, price, viaRtm = false) {
    const s = this.s, l = s.lot;
    l.phase = 'result';
    if (!teamId) {
      l.outcome = 'unsold';
      if (s.round === 1 && this.cfg.accelerated) s.unsold.push(l.pid);
      s.history.unshift({ pid: l.pid, team: null, price: 0, round: s.round });
    } else {
      const team = this.team(teamId);
      team.purse -= price;
      team.squad.push({ pid: l.pid, price, rtm: viaRtm, round: s.round });
      if (viaRtm) team.rtmLeft--;
      l.outcome = 'sold';
      l.winner = teamId;
      l.price = price;
      l.viaRtm = viaRtm;
      s.history.unshift({ pid: l.pid, team: teamId, price, rtm: viaRtm, round: s.round });
    }
    const peopleWatching = s.teams.some(t => !this.isBot(t));
    const humanInvolved = s.teams.some(t => t.human && (t.id === teamId || l.bids.some(b => b.team === t.id)));
    this.emit('settled', l);
    this.setClock(!peopleWatching ? 300 : humanInvolved || !this.turbo() ? 2600 : 900);
  }

  finish() {
    this.s.status = 'done';
    this.s.lot = null;
    this.stop();
    this.emit('done');
  }

  /* ---------- scoring ---------- */
  bestXI(team) {
    const squad = team.squad.map(x => PLAYER[x.pid]).sort((a, b) => b.rating - a.rating);
    const xi = [];
    let os = 0;
    const add = pl => { xi.push(pl); if (isOverseas(pl)) os++; };
    const keeper = squad.find(pl => pl.role === 'WK');
    if (keeper) add(keeper);
    for (const pl of squad) {
      if (xi.length >= 11) break;
      if (xi.includes(pl) || (isOverseas(pl) && os >= this.cfg.xiOverseas)) continue;
      add(pl);
    }
    return xi;
  }

  strength(team) {
    const xi = this.bestXI(team);
    const ratings = xi.map(pl => pl.rating);
    while (ratings.length < 11) ratings.push(35);
    let score = ratings.reduce((a, b) => a + b, 0) / 11;
    const bowling = xi.filter(pl => pl.role === 'FAST' || pl.role === 'SPIN' || pl.role === 'AR').length;
    const batting = xi.filter(pl => pl.role === 'BAT' || pl.role === 'WK' || pl.role === 'AR').length;
    if (bowling < 5) score -= (5 - bowling) * 2.5;
    if (batting < 6) score -= (6 - batting) * 2;
    if (!xi.some(pl => pl.role === 'WK')) score -= 4;
    score -= Math.max(0, this.cfg.minSquad - team.squad.length) * 0.5;
    return Math.max(0, Math.round(score * 10) / 10);
  }

  flags(team) {
    const out = [];
    if (team.squad.length < this.cfg.minSquad) out.push(`Short of the ${this.cfg.minSquad}-player minimum`);
    if (this.cfg.minSpend && team.startPurse - team.purse < team.startPurse * this.cfg.minSpend) out.push(`Spent under ${this.cfg.minSpend * 100}% of the purse`);
    return out;
  }

  results() {
    return this.s.teams.map(t => ({
      team: t, spent: this.cfg.purse - t.purse, // includes mini-auction retention costs
      strength: this.strength(t), xi: this.bestXI(t), overseas: this.overseasCount(t), flags: this.flags(t),
    })).sort((a, b) => b.strength - a.strength);
  }
}

if (typeof module === 'object' && module.exports) {
  Object.assign(globalThis, { ALL_PLAYERS, PLAYER, TEAM_META, MIN_SLOT, fmtAmt, increment, round5, isOverseas, fairValue, AuctionGame });
}
