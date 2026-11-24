// Persistencia local: configuración, agentes, servidores MCP y chats.
// El token se cifra con safeStorage (en macOS usa el Llavero / Keychain).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = () => app.getPath('userData');
const file = (name) => path.join(dataDir(), name);

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(name, value) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

const DEFAULT_AGENT = {
  id: 'default',
  name: 'Claude',
  description: 'Asistente general',
  model: 'claude-opus-5-5',
  effort: 'medium',
  systemPrompt: 'Eres Claude, un asistente útil. Responde en el idioma del usuario.',
  mcpServers: [],
  skills: [],
  webSearch: false,
  confirmTools: true,
};

const ATLASSIAN_SERVER = {
  id: 'atlassian',
  name: 'atlassian',
  type: 'http',
  url: 'https://mcp.atlassian.com/v1/mcp',
  headers: {},
  command: '',
  args: [],
  env: {},
};

const CONFLUENCE_AGENT = {
  id: 'confluence',
  name: 'Confluence',
  description: 'Busca, lee y crea páginas en tu Confluence (y Jira)',
  model: 'claude-opus-5-5',
  effort: 'medium',
  systemPrompt:
    'Eres un asistente conectado al Confluence y Jira de la empresa del usuario mediante las herramientas de Atlassian. ' +
    'Cuando la pregunta pueda responderse con información de Confluence, búscala primero con las herramientas y cita el título y el enlace de las páginas que uses. ' +
    'Antes de crear o modificar páginas o incidencias, muestra al usuario qué vas a cambiar. Responde en el idioma del usuario.',
  mcpServers: ['atlassian'],
  skills: [],
  webSearch: false,
  confirmTools: true,
};

const store = {
  // Crea una sola vez (al primer arranque de esta versión) la conexión de Atlassian y el agente Confluence.
  seedDefaults() {
    const s = readJSON('settings.json', {});
    if (s.seededAtlassian) return;
    const servers = this.listMcp();
    if (!servers.some((x) => x.id === ATLASSIAN_SERVER.id || /mcp\.atlassian\.com/.test(x.url || ''))) this.saveMcp({ ...ATLASSIAN_SERVER });
    const atl = this.listMcp().find((x) => x.id === ATLASSIAN_SERVER.id || /mcp\.atlassian\.com/.test(x.url || ''));
    const agents = this.listAgents();
    if (!agents.some((a) => a.id === CONFLUENCE_AGENT.id)) this.saveAgent({ ...CONFLUENCE_AGENT, mcpServers: [atl.id] });
    writeJSON('settings.json', { ...readJSON('settings.json', {}), seededAtlassian: true });
  },

  skillsDir() {
    const dir = path.join(dataDir(), 'skills');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },

  // ---------- Token ----------
  getToken() {
    const s = readJSON('settings.json', {});
    if (!s.tokenEnc) return null;
    try {
      const buf = Buffer.from(s.tokenEnc, 'base64');
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch {
      return null;
    }
  },
  setToken(token) {
    const s = readJSON('settings.json', {});
    if (!token) {
      delete s.tokenEnc;
    } else {
      const enc = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(token)
        : Buffer.from(token, 'utf8');
      s.tokenEnc = enc.toString('base64');
    }
    writeJSON('settings.json', s);
  },
  tokenInfo() {
    const t = this.getToken();
    if (!t) return { hasToken: false };
    return { hasToken: true, preview: t.slice(0, 10) + '…' + t.slice(-4), kind: tokenKind(t) };
  },

  // ---------- Agentes ----------
  listAgents() {
    const agents = readJSON('agents.json', null);
    if (!agents || !agents.length) return [DEFAULT_AGENT];
    return agents;
  },
  saveAgent(agent) {
    const agents = this.listAgents();
    if (!agent.id) agent.id = crypto.randomUUID();
    const i = agents.findIndex((a) => a.id === agent.id);
    if (i >= 0) agents[i] = agent;
    else agents.push(agent);
    writeJSON('agents.json', agents);
    return agent;
  },
  deleteAgent(id) {
    writeJSON('agents.json', this.listAgents().filter((a) => a.id !== id));
  },

  // ---------- Servidores MCP ----------
  listMcp() {
    return readJSON('mcp.json', []);
  },
  saveMcp(server) {
    const list = this.listMcp();
    if (!server.id) server.id = crypto.randomUUID();
    const i = list.findIndex((s) => s.id === server.id);
    if (i >= 0) list[i] = server;
    else list.push(server);
    writeJSON('mcp.json', list);
    return server;
  },
  deleteMcp(id) {
    writeJSON('mcp.json', this.listMcp().filter((s) => s.id !== id));
  },

  // ---------- Chats ----------
  listChats() {
    return readJSON('chats.json', []).map(({ id, title, agentId, updatedAt }) => ({ id, title, agentId, updatedAt }));
  },
  getChat(id) {
    return readJSON('chats.json', []).find((c) => c.id === id) || null;
  },
  saveChat(chat) {
    const chats = readJSON('chats.json', []);
    chat.updatedAt = Date.now();
    const i = chats.findIndex((c) => c.id === chat.id);
    if (i >= 0) chats[i] = chat;
    else chats.unshift(chat);
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    writeJSON('chats.json', chats);
  },
  deleteChat(id) {
    writeJSON('chats.json', readJSON('chats.json', []).filter((c) => c.id !== id));
  },
};

function tokenKind(t) {
  if (t.startsWith('sk-ant-api')) return 'API key';
  return 'Auth token (Bearer)';
}

module.exports = { store, tokenKind, DEFAULT_AGENT };
