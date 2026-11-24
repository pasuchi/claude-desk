const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { store } = require('./store');
const { McpManager } = require('./mcp');
const { ChatRunner, MODELS, verifyToken } = require('./chat');
const skills = require('./skills');

let win;
const mcp = new McpManager();
const pendingApprovals = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1f1e1d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Los enlaces se abren en el navegador, no dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

const runner = new ChatRunner({
  store,
  mcp,
  send: (event) => win && !win.isDestroyed() && win.webContents.send('chat:event', event),
  askApproval: ({ chatId, name, input }) =>
    new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      pendingApprovals.set(requestId, resolve);
      win.webContents.send('chat:approval', { requestId, chatId, name, input });
    }),
});

// ---------- IPC ----------
const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));

handle('meta', () => ({ models: MODELS, skillsDir: store.skillsDir(), version: app.getVersion() }));

handle('token:info', () => store.tokenInfo());
handle('token:set', async (token) => {
  token = (token || '').trim();
  if (!token) {
    store.setToken(null);
    return { ok: true, info: store.tokenInfo() };
  }
  try {
    const models = await verifyToken(token);
    store.setToken(token);
    return { ok: true, models, info: store.tokenInfo() };
  } catch (e) {
    return { ok: false, error: e.status ? `${e.status}: ${e.message}` : e.message };
  }
});

handle('agents:list', () => store.listAgents());
handle('agents:save', (a) => store.saveAgent(a));
handle('agents:delete', (id) => store.deleteAgent(id));

handle('mcp:list', () => store.listMcp());
handle('mcp:save', async (s) => {
  await mcp.disconnect(s.id);
  return store.saveMcp(s);
});
handle('mcp:delete', async (id) => {
  await mcp.disconnect(id);
  store.deleteMcp(id);
});
handle('mcp:logout', (id) => mcp.logout(id));
handle('mcp:test', async (s) => {
  try {
    return { ok: true, tools: await mcp.test(s) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

handle('skills:list', () => skills.listSkills(store.skillsDir()));
handle('skills:save', (s) => skills.saveSkill(store.skillsDir(), s));
handle('skills:delete', (folder) => skills.deleteSkill(store.skillsDir(), folder));
handle('skills:openDir', () => shell.openPath(store.skillsDir()));
handle('skills:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message: 'Elige la carpeta de una skill (con SKILL.md)' });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    return { ok: true, folder: skills.importSkill(store.skillsDir(), r.filePaths[0]) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

handle('chats:list', () => store.listChats());
handle('chats:get', (id) => store.getChat(id));
handle('chats:delete', (id) => store.deleteChat(id));

handle('chat:send', async ({ chatId, agentId, text, images }) => {
  const agent = store.listAgents().find((a) => a.id === agentId) || store.listAgents()[0];
  let chat = chatId ? store.getChat(chatId) : null;
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: text.slice(0, 60) || 'Nuevo chat', agentId: agent.id, messages: [] };
  }
  const content = [];
  for (const img of images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  content.push({ type: 'text', text });
  chat.messages.push({ role: 'user', content });
  store.saveChat(chat);
  runner.run(chat, agent); // no se espera: los eventos llegan por 'chat:event'
  return { chatId: chat.id };
});
handle('chat:stop', (chatId) => runner.stop(chatId));
handle('chat:approve', ({ requestId, ok }) => {
  const r = pendingApprovals.get(requestId);
  if (r) {
    pendingApprovals.delete(requestId);
    r(!!ok);
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  );
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => mcp.disconnectAll());
