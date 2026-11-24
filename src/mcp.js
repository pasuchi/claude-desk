// Gestor de servidores MCP (Model Context Protocol).
// Soporta servidores locales (stdio: un comando) y remotos (HTTP streamable / SSE).
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { DeskOAuthProvider, clearAuth } = require('./oauth');
const os = require('os');
const { execSync } = require('child_process');

// Las apps GUI de macOS arrancan con un PATH mínimo; añadimos rutas típicas
// para que funcionen `npx`, `uvx`, `node`, `python`, etc.
let fullPath = null;
function shellPath() {
  if (fullPath) return fullPath;
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${os.homedir()}/.local/bin`, `${os.homedir()}/.cargo/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  let fromShell = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    fromShell = execSync(`${shell} -ilc 'printf "%s" "$PATH"'`, { timeout: 4000, encoding: 'utf8' }).trim().split('\n').pop();
  } catch {}
  const parts = [...fromShell.split(':'), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
  fullPath = [...new Set(parts)].join(':');
  return fullPath;
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cleanSchema(schema) {
  if (!schema || schema.type !== 'object') return { type: 'object', properties: {} };
  const { $schema, ...rest } = schema;
  return rest;
}

class McpManager {
  constructor() {
    this.conns = new Map(); // id -> { client, tools, server }
    this.connecting = new Map(); // id -> promesa en curso (evita dos logins a la vez)
  }

  async connect(server) {
    if (this.conns.has(server.id)) return this.conns.get(server.id);
    if (this.connecting.has(server.id)) return this.connecting.get(server.id);
    const p = server.type === 'stdio' ? this._connectStdio(server) : this._connectRemote(server, true);
    this.connecting.set(server.id, p);
    try {
      return await p;
    } finally {
      this.connecting.delete(server.id);
    }
  }

  async _connectStdio(server) {
    const client = new Client({ name: 'claude-desk', version: '1.0.0' });
    const env = { ...process.env, PATH: shellPath(), ...(server.env || {}) };
    const transport = new StdioClientTransport({ command: server.command, args: server.args || [], env, stderr: 'pipe' });
    // Leemos stderr siempre: si no, un servidor que escribe muchos logs se bloquea.
    let stderrTail = '';
    transport.stderr?.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    try {
      await client.connect(transport);
      return await this._finish(server, client);
    } catch (e) {
      try { await client.close(); } catch {}
      const hint = /ENOENT/.test(e.message) ? ` (no se encontró el comando "${server.command}"; ¿está instalado?)` : '';
      throw new Error(`${e.message}${hint}${stderrTail ? `\n${stderrTail.trim().split('\n').slice(-6).join('\n')}` : ''}`);
    }
  }

  async _connectRemote(server, allowLogin) {
    const url = new URL(server.url);
    const headers = server.headers || {};
    const hasStaticAuth = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
    // Sin cabecera Authorization fija, usamos OAuth (login en el navegador, compatible con SSO/SAML).
    const authProvider = hasStaticAuth ? undefined : new DeskOAuthProvider(server);
    const opts = { requestInit: { headers }, authProvider };
    const transport = server.type === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
    const client = new Client({ name: 'claude-desk', version: '1.0.0' });
    try {
      await client.connect(transport);
      return await this._finish(server, client);
    } catch (e) {
      try { await client.close(); } catch {}
      if (e instanceof UnauthorizedError && authProvider && allowLogin) {
        if (!authProvider.pending) throw new Error('El servidor pidió iniciar sesión pero no ofreció una página de login.');
        const code = await authProvider.pending; // el usuario inicia sesión en el navegador (SAML/SSO)
        await transport.finishAuth(code);
        return this._connectRemote(server, false);
      }
      if (e instanceof UnauthorizedError) throw new Error('No autorizado (401). Revisa las cabeceras o pulsa "Cerrar sesión" y vuelve a probar.');
      throw e;
    }
  }

  async _finish(server, client) {
    const { tools } = await client.listTools();
    const conn = { client, tools, server };
    this.conns.set(server.id, conn);
    client.onclose = () => this.conns.get(server.id) === conn && this.conns.delete(server.id);
    return conn;
  }

  async logout(id) {
    await this.disconnect(id);
    clearAuth(id);
  }

  async disconnect(id) {
    const c = this.conns.get(id);
    if (c) {
      this.conns.delete(id);
      try { await c.client.close(); } catch {}
    }
  }

  async disconnectAll() {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }

  async test(server) {
    await this.disconnect(server.id);
    const conn = await this.connect(server);
    return conn.tools.map((t) => ({ name: t.name, description: t.description || '' }));
  }

  // Devuelve definiciones de herramientas para la API de Claude y un mapa
  // nombre -> { serverId, toolName } para enrutar las llamadas.
  async toolsFor(servers) {
    const defs = [];
    const routes = new Map();
    const errors = [];
    for (const server of servers) {
      try {
        const conn = await this.connect(server);
        for (const t of conn.tools) {
          const name = `mcp__${safeName(server.name)}__${safeName(t.name)}`.slice(0, 64);
          routes.set(name, { serverId: server.id, toolName: t.name, serverName: server.name });
          defs.push({
            name,
            description: (t.description || t.name).slice(0, 4000),
            input_schema: cleanSchema(t.inputSchema),
          });
        }
      } catch (e) {
        errors.push(`${server.name}: ${e.message}`);
      }
    }
    return { defs, routes, errors };
  }

  async call(route, input) {
    const conn = this.conns.get(route.serverId);
    if (!conn) throw new Error(`El servidor MCP "${route.serverName}" no está conectado`);
    const res = await conn.client.callTool({ name: route.toolName, arguments: input || {} });
    // Convertimos el contenido MCP a bloques de tool_result de Claude.
    const content = [];
    for (const c of res.content || []) {
      if (c.type === 'text') content.push({ type: 'text', text: c.text });
      else if (c.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
      else if (c.type === 'resource') content.push({ type: 'text', text: c.resource?.text ?? JSON.stringify(c.resource) });
      else content.push({ type: 'text', text: JSON.stringify(c) });
    }
    if (res.structuredContent && !content.length) content.push({ type: 'text', text: JSON.stringify(res.structuredContent) });
    if (!content.length) content.push({ type: 'text', text: '(sin salida)' });
    return { content, isError: !!res.isError };
  }
}

module.exports = { McpManager };
