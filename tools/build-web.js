// Bundles the game into single HTML files for solo play without the game server:
//   dist/ipl-auction-room.html   a complete page to open offline or upload to any static host
//   dist/artifact.html           the same content without the document wrapper, for claude.ai hosting
// Multiplayer rooms need the game server (`npm run server` or the desktop app).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let html = read('web/index.html')
  .replace(/<link rel="stylesheet" href="css\/game\.css">/, () => `<style>\n${read('web/css/game.css')}</style>`)
  .replace(/<script src="((?:shared|js)\/[^"]+)"><\/script>/g, (_, src) => {
    const file = src.startsWith('shared/') ? src : `web/${src}`;
    return `<script>\n${read(file).replace(/<\/script/gi, '<\\/script')}</script>`;
  });

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'ipl-auction-room.html'), html);

const artifact = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
  .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
fs.writeFileSync(path.join(dist, 'artifact.html'), artifact);
console.log(`Wrote dist/ipl-auction-room.html (${(html.length / 1024).toFixed(0)} KB) and dist/artifact.html`);
