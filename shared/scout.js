'use strict';
/* Scout: each player's personal auction advisor.
   scoutTip()     a verdict and bid ceiling for the player on the block, for one franchise
   scoutAnswer()  rule-based replies to typed questions (works offline, no API key)
   scoutContext() a compact game summary handed to Claude when a Claude-powered scout is available */

const ROLE_WORDS = [
  [/\b(wk|keeper|keepers|wicket ?keepers?|wicketkeeping)\b/, 'WK'],
  [/\b(spin|spinners?|leg ?spinners?|off ?spinners?|wrist)\b/, 'SPIN'],
  [/\b(pace|pacers?|fast|quicks?|seam(ers?)?|fast bowlers?)\b/, 'FAST'],
  [/\b(all[ -]?rounders?|allrounders?|ar)\b/, 'AR'],
  [/\b(bat|batters?|batsm[ae]n|openers?|top order|finishers?)\b/, 'BAT'],
];
const BOWLING_WORDS = /\b(bowlers?|bowling)\b/;

function scoutNeeds(game, team) {
  const have = game.roleCounts(team), want = game.roleTargets();
  return Object.keys(want).map(role => ({ role, have: have[role], want: want[role], gap: want[role] - have[role] }));
}

function slotPlan(game, team) {
  const slots = Math.max(1, game.cfg.targetSquad - team.squad.length);
  return { slots, perSlot: Math.floor(team.purse / slots) };
}

function upcoming(game, filter = () => true, limit = 5) {
  return game.s.queue.map((q, i) => ({ pl: PLAYER[q.pid], inLots: i + 1 })).filter(x => filter(x.pl)).slice(0, 40)
    .sort((a, b) => b.pl.rating - a.pl.rating).slice(0, limit);
}

function cr(l) { return fmtAmt(Math.max(0, l)); }

// Verdict for the current lot: { tone: 'go'|'maybe'|'no', verdict, maxBid, lines[] }
function scoutTip(game, teamId) {
  const l = game.lot, team = game.team(teamId);
  if (!l || !team) return null;
  const pl = PLAYER[l.pid];
  const blocked = game.blockReason(team, pl, l.bidder ? game.nextBid() : pl.base);
  const needs = scoutNeeds(game, team).find(n => n.role === pl.role);
  const plan = slotPlan(game, team);
  const avgSlot = team.startPurse / Math.max(1, team.plan);
  const pace = Math.min(1.3, Math.max(0.6, plan.perSlot / avgSlot));
  const needFactor = needs.gap > 0 ? 1.12 : needs.gap > -2 ? 0.85 : 0.6;
  const ceiling = Math.max(pl.base, Math.min(game.maxBid(team), round5(game.value(pl) * needFactor * pace)));
  const lines = [];
  lines.push(needs.gap > 0
    ? `You have ${needs.have} of the ${needs.want} ${ROLES[pl.role].toLowerCase()}s a balanced squad needs.`
    : `You already have ${needs.have} ${ROLES[pl.role].toLowerCase()}s, enough for this role.`);
  lines.push(`${cr(team.purse)} left for about ${plan.slots} more players (${cr(plan.perSlot)} each).`);
  if (isOverseas(pl)) lines.push(`Overseas slots used: ${game.overseasCount(team)} of ${game.cfg.maxOverseas}.`);
  const alt = upcoming(game, x => x.role === pl.role && x.rating >= pl.rating - 4, 2);
  if (alt.length) lines.push(`Similar options still to come: ${alt.map(x => `${x.pl.name} (${x.pl.rating})`).join(', ')}.`);
  if (blocked) return { tone: 'no', verdict: "Can't bid", maxBid: 0, lines: [blocked + '.', ...lines] };
  const now = l.bidder ? game.nextBid() : pl.base;
  if (l.bidder === teamId) return { tone: 'go', verdict: 'You hold the bid', maxBid: ceiling, lines };
  if (now > ceiling) return { tone: 'no', verdict: 'Let this one go', maxBid: ceiling, lines: [`The price has passed your ceiling of ${cr(ceiling)}.`, ...lines] };
  if (pl.rating >= 85 && needs.gap > 0) return { tone: 'go', verdict: 'Must-buy', maxBid: ceiling, lines };
  if (needs.gap > 0 || pl.rating >= 82) return { tone: 'go', verdict: 'Worth a bid', maxBid: ceiling, lines };
  return { tone: 'maybe', verdict: 'Only if cheap', maxBid: Math.min(ceiling, round5(pl.base * 1.5)), lines };
}

function findPlayers(text) {
  const t = ' ' + text.toLowerCase() + ' ';
  const hits = [];
  for (const pl of ALL_PLAYERS) {
    const parts = pl.name.toLowerCase().split(/\s+/);
    const full = pl.name.toLowerCase();
    const last = parts[parts.length - 1];
    const idx = t.indexOf(full) >= 0 ? t.indexOf(full) : (last.length > 3 && new RegExp(`\\b${last.replace(/[^a-z]/g, '.')}\\b`).test(t) ? t.search(new RegExp(`\\b${last.replace(/[^a-z]/g, '.')}\\b`)) : -1);
    if (idx >= 0) hits.push({ pl, idx });
  }
  return hits.sort((a, b) => a.idx - b.idx).map(h => h.pl).filter((pl, i, arr) => arr.indexOf(pl) === i);
}

function playerStatus(game, pid) {
  for (const t of game.s.teams) {
    const x = t.squad.find(y => y.pid === pid);
    if (x) return `bought by ${t.id} for ${cr(x.price)}${x.retained ? ' (retained)' : ''}`;
  }
  if (game.lot && game.lot.pid === pid) return 'on the block right now';
  const qi = game.s.queue.findIndex(q => q.pid === pid);
  if (qi >= 0) return `coming up in ${qi + 1} lot${qi ? 's' : ''}`;
  if (game.s.history.some(h => h.pid === pid && !h.team)) return 'unsold so far';
  return 'not in this auction';
}

function keyStat(pl) {
  const r = pl.stats.IPL || pl.stats.T20I || pl.stats.ODI || pl.stats.Test;
  const fmt = pl.stats.IPL ? 'IPL' : pl.stats.T20I ? 'T20I' : pl.stats.ODI ? 'ODI' : 'Test';
  if (!r) return '';
  const bowler = pl.role === 'FAST' || pl.role === 'SPIN';
  return bowler ? `${r[7]} ${fmt} wickets at economy ${r[9] ?? '—'}` : `${(r[1] ?? 0).toLocaleString('en-IN')} ${fmt} runs, SR ${r[3] ?? '—'}`;
}

function scoutAnswer(game, teamId, raw) {
  const text = String(raw || '').toLowerCase().trim();
  const team = game.team(teamId);
  if (!team) return 'Pick a franchise first and I will scout for it.';
  const role = (ROLE_WORDS.find(([re]) => re.test(text)) || [])[1];
  const wantsBowling = !role && BOWLING_WORDS.test(text);
  const os = /\b(overseas|foreign|international)\b/.test(text) ? true : /\bindian\b/.test(text) ? false : null;
  const named = findPlayers(text);

  if (/\b(rule|rules|rtm|right to match|increment|reserve|accelerated|how does)\b/.test(text)) {
    const c = game.cfg;
    return [`${c.modeName}: purse ${cr(c.purse)}, squad ${c.minSquad}–${c.maxSquad}, up to ${c.maxOverseas} overseas.`,
      'Bids rise by ₹5 L below ₹1 Cr, ₹10 L to ₹2 Cr, ₹20 L to ₹5 Cr and ₹25 L above.',
      `You must keep ₹30 L for every slot still needed to reach ${c.minSquad} players.`,
      c.rtm ? 'Right to Match: a 2025 team can match the winning bid; the buyer then gets one final raise.' : 'There is no Right to Match in this mode.',
      c.accelerated ? 'Unsold players return once in an accelerated round.' : 'Unsold players do not come back.'].join(' ');
  }

  if (named.length >= 2 && /\b(vs|versus|compare|or|better)\b/.test(text)) {
    const [a, b] = named;
    const better = a.rating === b.rating ? 'They are rated level' : `${(a.rating > b.rating ? a : b).name} is rated higher`;
    return `${a.name}: rating ${a.rating}, ${ROLES[a.role]}, ${keyStat(a)}, worth about ${cr(game.value(a))}. ` +
      `${b.name}: rating ${b.rating}, ${ROLES[b.role]}, ${keyStat(b)}, worth about ${cr(game.value(b))}. ${better}.`;
  }

  if (named.length === 1) {
    const pl = named[0];
    const need = scoutNeeds(game, team).find(n => n.role === pl.role);
    const status = playerStatus(game, pl.id);
    const fit = status.startsWith('bought') ? ''
      : need.gap > 0 ? `You still need ${need.gap} more ${ROLES[pl.role].toLowerCase()}${need.gap > 1 ? 's' : ''}, so this player fits.`
      : `You are already covered for ${ROLES[pl.role].toLowerCase()}s.`;
    return `${pl.name} (${ROLES[pl.role]}, ${COUNTRIES[pl.country].name}, rating ${pl.rating}): ${keyStat(pl)}. ` +
      `Fair price about ${cr(game.value(pl))}, base ${cr(pl.base)}. Status: ${status}. ${fit}`.trim();
  }

  if (/\b(squad|team|weak|weakness|need|needs|balance|gaps?|missing|xi)\b/.test(text) && !/\b(who|target|suggest)\b/.test(text)) {
    const needs = scoutNeeds(game, team);
    const gaps = needs.filter(n => n.gap > 0).map(n => `${n.gap} ${ROLES[n.role].toLowerCase()}${n.gap > 1 ? 's' : ''}`);
    const xi = game.bestXI(team);
    return `You have ${team.squad.length} player${team.squad.length === 1 ? '' : 's'} (${needs.map(n => `${n.have} ${ROLES[n.role].toLowerCase()}`).join(', ')}). ` +
      (gaps.length ? `Still needed: ${gaps.join(', ')}. ` : 'Every role is covered. ') +
      `Best XI rating ${game.strength(team)}` + (xi.length ? `, led by ${xi.slice(0, 3).map(pl => pl.name).join(', ')}.` : '.');
  }

  if (/\b(budget|purse|money|spend|afford|cash)\b/.test(text)) {
    const plan = slotPlan(game, team);
    return `You have ${cr(team.purse)} for about ${plan.slots} more players, roughly ${cr(plan.perSlot)} each. ` +
      `Your highest legal bid right now is ${cr(game.maxBid(team))}. Save big money for the roles you are missing.`;
  }

  if (/\b(worth|value|how much|max|ceiling|bid|price)\b/.test(text) && game.lot) {
    const tip = scoutTip(game, teamId);
    return `${PLAYER[game.lot.pid].name}: ${tip.verdict}. ${tip.maxBid ? `Go up to ${cr(tip.maxBid)}. ` : ''}${tip.lines.join(' ')}`;
  }

  if (role || wantsBowling || os !== null || /\b(who|target|suggest|recommend|best|next|buy|options?|available)\b/.test(text)) {
    const needs = scoutNeeds(game, team);
    const roles = role ? [role] : wantsBowling ? ['FAST', 'SPIN'] : needs.filter(n => n.gap > 0).map(n => n.role);
    const pick = upcoming(game, pl => (!roles.length || roles.includes(pl.role)) && (os === null || isOverseas(pl) === os) &&
      (!isOverseas(pl) || game.overseasCount(team) < game.cfg.maxOverseas), 5);
    if (!pick.length) return 'Nobody matching that is left in the queue. Check the unsold list in the player pool for the accelerated round.';
    const what = role ? ROLES[role].toLowerCase() + 's' : wantsBowling ? 'bowlers' : roles.length ? 'players for your gaps' : 'players';
    return `Best ${what} still to come: ` + pick.map(x => `${x.pl.name} (${x.pl.rating}, in ${x.inLots} lot${x.inLots > 1 ? 's' : ''}, about ${cr(game.value(x.pl))})`).join('; ') + '.';
  }

  if (game.lot) {
    const tip = scoutTip(game, teamId);
    return `On the block: ${PLAYER[game.lot.pid].name}. ${tip.verdict}${tip.maxBid ? `, up to ${cr(tip.maxBid)}` : ''}. ` +
      'Ask me things like "who are the best keepers left", "how is my squad", "is Bumrah worth it" or "compare Gill and Jaiswal".';
  }
  return 'Ask me about your squad, your budget, a player by name, or which roles to target next.';
}

// Plain-text briefing for a Claude-powered scout. Kept short so each question stays cheap.
function scoutContext(game, teamId) {
  const team = game.team(teamId), c = game.cfg, l = game.lot;
  const squad = team.squad.map(x => { const pl = PLAYER[x.pid]; return `${pl.name} (${ROLES[pl.role]}, ${pl.country}, rating ${pl.rating}, ${cr(x.price)})`; });
  const needs = scoutNeeds(game, team).map(n => `${ROLES[n.role]} ${n.have}/${n.want}`).join(', ');
  const lines = [
    `Mode: ${c.modeName}. Purse ${cr(c.purse)}, squad ${c.minSquad}-${c.maxSquad}, max ${c.maxOverseas} overseas.`,
    `My franchise: ${TEAM_META[team.id].name}. Purse left ${cr(team.purse)}, max legal bid ${cr(game.maxBid(team))}. Overseas ${game.overseasCount(team)}/${c.maxOverseas}. Best XI rating ${game.strength(team)}.`,
    `Role counts vs target: ${needs}.`,
    `My squad: ${squad.join('; ') || 'empty'}.`,
  ];
  if (l) {
    const pl = PLAYER[l.pid];
    lines.push(`On the block: ${pl.name}, ${ROLES[pl.role]}, ${COUNTRIES[pl.country].name}, rating ${pl.rating}, base ${cr(pl.base)}, ${keyStat(pl)}. ` +
      (l.bidder ? `Current bid ${cr(l.bid)} by ${l.bidder}.` : 'No bids yet.') + ` Scout fair value ${cr(game.value(pl))}.`);
  }
  const next = game.s.queue.slice(0, 15).map((q, i) => { const pl = PLAYER[q.pid]; return `${i + 1}. ${pl.name} (${ROLES[pl.role]}, ${pl.country}, ${pl.rating}, base ${cr(pl.base)})`; });
  lines.push(`Next lots: ${next.join('; ') || 'none'}.`);
  const rivals = game.s.teams.filter(t => t.id !== team.id).map(t => `${t.id} ${cr(t.purse)} left, ${t.squad.length} players`);
  lines.push(`Rivals: ${rivals.join('; ')}.`);
  return lines.join('\n');
}

const SCOUT_BRIEF = 'You are Scout, a sharp IPL auction analyst advising one franchise in a live auction game. ' +
  'Use only the game data provided. Answer in at most 90 words, plain text, no markdown headings. ' +
  'Be concrete: name players and give bid ceilings in ₹ Cr. If asked about something outside the auction, steer back to it briefly.';

if (typeof module === 'object' && module.exports) Object.assign(globalThis, { scoutTip, scoutAnswer, scoutContext, SCOUT_BRIEF });
