// Login OAuth para servidores MCP remotos (p. ej. Atlassian / Confluence con SAML).
// Abre el navegador del sistema para iniciar sesión (ahí pasa el SSO/SAML de la empresa)
// y recibe el código en un servidor local 127.0.0.1. Tokens cifrados con safeStorage.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, shell, safeStorage } = require('electron');

const CALLBACK_PORT = 33418;
const CALLBACK_PATH = '/oauth/callback';
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

const authFile = () => path.join(app.getPath('userData'), 'mcp-auth.json');

function loadAll() {
  try {
    const raw = fs.readFileSync(authFile());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function saveAll(data) {
  const text = JSON.stringify(data);
  fs.mkdirSync(path.dirname(authFile()), { recursive: true });
  fs.writeFileSync(authFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text);
}
function update(serverId, patch) {
  const all = loadAll();
  all[serverId] = { ...(all[serverId] || {}), ...patch };
  saveAll(all);
}
function get(serverId) {
  return loadAll()[serverId] || {};
}
function clearAuth(serverId) {
  const all = loadAll();
  delete all[serverId];
  saveAll(all);
}

// Espera el redirect de vuelta del navegador con ?code=…&state=…
function waitForCode(expectedState, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const page = (title, msg) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,sans-serif;padding:48px;text-align:center"><h2>${title}</h2><p>${msg}</p></body>`;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URL);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error_description') || url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (error || !code || (expectedState && state !== expectedState)) {
        res.end(page('No se pudo iniciar sesión', error || 'Respuesta no válida. Vuelve a Claude Desk e inténtalo otra vez.'));
        finish(new Error(error || 'Respuesta de inicio de sesión no válida'));
      } else {
        res.end(page('Sesión iniciada', 'Ya puedes cerrar esta pestaña y volver a Claude Desk.'));
        finish(null, code);
      }
    });
    const timer = setTimeout(() => finish(new Error('Se agotó el tiempo para iniciar sesión (5 minutos)')), timeoutMs);
    function finish(err, code) {
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve(code);
    }
    server.on('error', (e) =>
      finish(new Error(e.code === 'EADDRINUSE' ? `El puerto ${CALLBACK_PORT} está ocupado; cierra otras ventanas de inicio de sesión e inténtalo de nuevo` : e.message))
    );
    server.listen(CALLBACK_PORT, '127.0.0.1');
  });
}

class DeskOAuthProvider {
  constructor(server) {
    this.serverId = server.id;
    this.pending = null; // promesa del código cuando se abre el navegador
    this._state = null;
  }
  get redirectUrl() {
    return REDIRECT_URL;
  }
  get clientMetadata() {
    return {
      client_name: 'Claude Desk',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    this._state = crypto.randomBytes(16).toString('hex');
    return this._state;
  }
  clientInformation() {
    return get(this.serverId).client;
  }
  saveClientInformation(info) {
    update(this.serverId, { client: info });
  }
  tokens() {
    return get(this.serverId).tokens;
  }
  saveTokens(tokens) {
    update(this.serverId, { tokens });
  }
  saveCodeVerifier(v) {
    update(this.serverId, { verifier: v });
  }
  codeVerifier() {
    const v = get(this.serverId).verifier;
    if (!v) throw new Error('Falta el verificador PKCE');
    return v;
  }
  discoveryState() {
    return get(this.serverId).discovery;
  }
  saveDiscoveryState(s) {
    update(this.serverId, { discovery: s });
  }
  invalidateCredentials(scope) {
    const cur = get(this.serverId);
    if (scope === 'all') return clearAuth(this.serverId);
    const key = { client: 'client', tokens: 'tokens', verifier: 'verifier', discovery: 'discovery' }[scope];
    if (key) {
      delete cur[key];
      const all = loadAll();
      all[this.serverId] = cur;
      saveAll(all);
    }
  }
  async redirectToAuthorization(authorizationUrl) {
    // Empezamos a escuchar ANTES de abrir el navegador.
    this.pending = waitForCode(this._state);
    this.pending.catch(() => {}); // se gestiona en connect()
    await shell.openExternal(authorizationUrl.toString());
  }
}

module.exports = { DeskOAuthProvider, clearAuth, hasAuth: (id) => !!get(id).tokens, REDIRECT_URL };
