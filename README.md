# IPL Auction Room

A multiplayer IPL auction game. Create a room, send friends the link or the 5-letter room code, pick a franchise each, and bid for real cricketers against each other and the computer. A personal AI scout tells every player who to chase and how much to pay.

## Auction modes

| Mode | Pool | Purse | Squad | Twist |
| --- | --- | --- | --- | --- |
| Mega Auction | All 176 current players | ₹120 Cr | 15–25, max 8 overseas | Right to Match cards, accelerated round |
| Mini Auction | Current players not retained | ₹120 Cr minus retentions | 15–25 | Every team keeps up to 8 of its 2025 players first |
| Legends Auction | 78 retired greats (Sachin, Lara, Warne, Wasim…) | ₹120 Cr | 11–14, no overseas cap | Build an all-time XI, 6 teams by default |
| Blitz Auction | Top 70 current players | ₹80 Cr | 9–12, max 4 overseas | 6-second hammer, no second round |

The host can change the number of franchises (2–10), the hammer timer and how hard the computer bids. Before the match every player reads the full rules in a popup and taps "I'm ready"; the host can only start once everyone is ready.

## Play

**Solo:** open the game and choose *Play solo*. Works offline; the auction saves as you play.

**With friends on the same Wi-Fi:** run the desktop app (unzip `dist/IPL Auction Room-win32-x64.zip`, run `IPL Auction Room.exe`), create a room and press *Copy invite link*. Friends open that link in any browser, or type the room code. Windows may ask to allow the app through the firewall the first time: allow it on private networks.

**With friends anywhere:** host the game server online. The repo includes `render.yaml`, so on [Render](https://render.com) you can create a free Web Service from this folder (build `npm install --omit=dev`, start `node server/server.js`). Share `https://<your-app>.onrender.com/#ROOMCODE` links. Any Node 20+ host works the same way.

**From source:**

```bash
npm install
```

```bash
npm run server
```

Then open http://localhost:7777. `npm start` opens the desktop app instead.

Controls: **Space** (or B) bids, **P** passes. *Autopilot* lets the computer bid for you; when every player is on autopilot the auction fast-forwards to the results.

## AI scout

Every player has a scout in the *Scout AI* tab and a verdict card under the bid button: a call on the current player (must-buy, worth a bid, only if cheap, let it go), a maximum bid, and why. You can ask it things like "who are the best keepers left", "how is my squad", "is Bumrah worth it" or "compare Gill and Jaiswal".

The scout always works offline using the game's own data. For Claude-written answers, give the server an Anthropic API key:

- Server: set `ANTHROPIC_API_KEY` before `npm run server` (or as an environment variable on Render).
- Desktop app: create `%APPDATA%\IPL Auction Room\config.json` containing `{"anthropicApiKey": "sk-ant-..."}`.

On claude.ai the published page asks Claude through your own claude.ai account instead, after you allow it.

## Rules in brief

- Bidding opens at the base price (₹30 L to ₹2 Cr) and rises by +₹5 L below ₹1 Cr, +₹10 L to ₹2 Cr, +₹20 L to ₹5 Cr and +₹25 L above.
- The hammer resets after each bid: going once at half time, going twice at a quarter, then sold.
- Teams must keep ₹30 L for each slot still needed to reach the minimum squad.
- Right to Match (Mega): the player's 2025 team may match the winning bid; the buyer gets one final raise, which the old team must match too.
- Unsold players return once in an accelerated round (not in Blitz).
- Teams are ranked on their best XI rating. Short squads and (in Mega) spending under 75% of the purse are flagged.
- If a player disconnects, the computer bids for their team until they reopen the link.

## Project layout

```
shared/   game code used by both server and browser
  data.js, legends.js   teams and players with stats
  modes.js              Mega / Mini / Legends / Blitz presets
  engine.js             auction rules, computer bidding, Right to Match, scoring
  scout.js              the AI scout
  room.js               rooms: lobby, ready checks, chat, scout questions
server/   Node server: serves the game and runs rooms over WebSockets
web/      the game interface
desktop/  Electron app that starts the server and opens the game
tools/    single-file web build and Windows packaging
```

Rebuild with `npm run build:web` (single-file solo version in `dist/`) and `npm run package:win` (Windows app in `dist/`).

Stats are approximate career figures through the 2025 season, rounded for gameplay. Fan-made; not affiliated with the IPL, BCCI or any franchise.
