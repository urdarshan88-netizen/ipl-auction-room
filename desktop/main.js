// Electron shell: starts the game server in-process (so this computer can host rooms for friends
// on the same network) and opens the game in a desktop window.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

// Optional Claude-powered scout: put {"anthropicApiKey": "sk-ant-..."} in config.json in the app's
// user-data folder (shown in the README), or set ANTHROPIC_API_KEY before launching.
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    if (cfg.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
    if (cfg.scoutModel) process.env.SCOUT_MODEL = cfg.scoutModel;
  } catch { /* no config: built-in scout */ }
}

async function startGameServer() {
  const { startServer } = require('../server/server.js');
  try {
    return await startServer({ port: 7777 });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    return startServer({ port: 0 }); // 7777 is busy: take any free port
  }
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0a0918',
    title: 'IPL Auction Room',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(`http://localhost:${port}/`);
  // Links open in the system browser, never inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // F11 toggles full screen, F5 reloads.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
    if (input.key === 'F5') { win.reload(); event.preventDefault(); }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  loadConfig();
  let server;
  try {
    server = await startGameServer();
  } catch (err) {
    dialog.showErrorBox('IPL Auction Room', `The game server could not start: ${err.message}`);
    return app.quit();
  }
  createWindow(server.port);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(server.port); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
