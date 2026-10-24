'use strict';
/* Auction modes. Each mode is a preset of pool, purse and squad rules; the room host can still
   change the number of franchises, the hammer timer and how hard the computer bids.
   Money is in lakhs (100 L = ₹1 Cr). */

const MODES = {
  mega: {
    id: 'mega', name: 'Mega Auction', short: 'Mega',
    tagline: 'The full IPL experience: every franchise starts from scratch.',
    pool: 'current', purse: 12000, teams: 10, minSquad: 15, maxSquad: 25, maxOverseas: 8,
    rtm: 2, timer: 10, retain: 0, accelerated: true, minSpend: 0.75, xiOverseas: 4,
    targetSquad: 18, capShare: 0.22, valueScale: 1, setSize: 8,
  },
  mini: {
    id: 'mini', name: 'Mini Auction', short: 'Mini',
    tagline: 'Teams keep their 2025 core and fight over the gaps with a small purse.',
    pool: 'current', purse: 12000, teams: 10, minSquad: 15, maxSquad: 25, maxOverseas: 8,
    rtm: 0, timer: 10, retain: 8, retainOverseas: 3, retainFloor: 1500, accelerated: true, minSpend: 0, xiOverseas: 4,
    targetSquad: 19, capShare: 0.5, valueScale: 1.1, setSize: 8,
  },
  legends: {
    id: 'legends', name: 'Legends Auction', short: 'Legends',
    tagline: 'Retired greats from every era. Build an all-time XI.',
    pool: 'legends', purse: 12000, teams: 6, minSquad: 11, maxSquad: 14, maxOverseas: 14,
    rtm: 0, timer: 10, retain: 0, accelerated: true, minSpend: 0, xiOverseas: 11,
    targetSquad: 12, capShare: 0.3, valueScale: 0.85, setSize: 7,
  },
  blitz: {
    id: 'blitz', name: 'Blitz Auction', short: 'Blitz',
    tagline: 'The 70 best current players, a 6-second hammer and no second chances.',
    pool: 'blitz', poolSize: 70, purse: 8000, teams: 6, minSquad: 9, maxSquad: 12, maxOverseas: 4,
    rtm: 0, timer: 6, retain: 0, accelerated: false, minSpend: 0, xiOverseas: 4,
    targetSquad: 10, capShare: 0.2, valueScale: 0.7, setSize: 10,
  },
};
const MODE_ORDER = ['mega', 'mini', 'legends', 'blitz'];
const AI_LEVELS = { 0.85: 'Cautious', 1: 'Balanced', 1.15: 'Aggressive', 1.3: 'Bidding war' };

// Player ids that a mode puts up for auction (before mini-auction retentions are removed).
function modePool(mode) {
  if (mode.pool === 'legends') return LEGENDS.map(pl => pl.id);
  if (mode.pool === 'blitz') return [...PLAYERS].sort((a, b) => b.rating - a.rating).slice(0, mode.poolSize).map(pl => pl.id);
  return PLAYERS.map(pl => pl.id);
}

// The rules actually in force once the host has picked the number of franchises:
// squad limits shrink when the pool cannot fill every franchise to the mode's minimum.
function effectiveRules(modeId, settings = {}) {
  const m = MODES[modeId] || MODES.mega;
  const teams = Math.max(2, Math.min(10, settings.teams || m.teams));
  const poolSize = modePool(m).length;
  const minSquad = Math.max(5, Math.min(m.minSquad, Math.floor(poolSize * 0.9 / teams)));
  const maxSquad = Math.max(minSquad + 2, m.maxSquad);
  return {
    mode: m.id, modeName: m.name, teams, poolSize,
    purse: m.purse, timer: settings.timer || m.timer, rtm: m.rtm, aggression: settings.aggression || 1,
    minSquad, maxSquad, maxOverseas: Math.min(m.maxOverseas, maxSquad),
    targetSquad: Math.max(minSquad, Math.min(m.targetSquad, maxSquad)),
    retain: m.retain, retainOverseas: m.retainOverseas || 0, retainFloor: m.retainFloor || 0,
    accelerated: m.accelerated, minSpend: m.minSpend, xiOverseas: m.xiOverseas,
    capShare: m.capShare, valueScale: m.valueScale, setSize: m.setSize,
  };
}

if (typeof module === 'object' && module.exports) Object.assign(globalThis, { MODES, MODE_ORDER, AI_LEVELS, modePool, effectiveRules });
