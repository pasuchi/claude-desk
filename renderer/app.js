/* global marked, DOMPurify */
const $ = (s) => document.querySelector(s);
const desk = window.api;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));

const state = {
  meta: null,
  agents: [],
  currentChatId: null,
  running: new Set(),
  live: null, // { root, textEl, textRaw, thinkEl, thinkRaw, tools: Map }
  pendingImages: [],
};

// ---------------- Navegación ----------------
function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'agents') renderAgents();
  if (view === 'mcp') renderMcp();
  if (view === 'skills') renderSkills();
  if (view === 'settings') renderToken();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => show(b.dataset.view)));

// ---------------- Modal ----------------
function modal(html, onMount) {
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  onMount && onMount($('#modalBody'));
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalBody').innerHTML = '';
}
function confirmBox(text) {
  return new Promise((res) => {
    modal(`<p>${esc(text)}</p><div class="modal-actions"><button id="cNo">Cancelar</button><button class="primary" id="cYes">Aceptar</button></div>`, (m) => {
      m.querySelector('#cNo').onclick = () => (closeModal(), res(false));
      m.querySelector('#cYes').onclick = () => (closeModal(), res(true));
    });
  });
}

// ---------------- Agentes ----------------
async function loadAgents() {
  state.agents = await desk.agents.list();
  const sel = $('#agentSelect');
  const prev = sel.value;
  sel.innerHTML = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if (state.agents.some((a) => a.id === prev)) sel.value = prev;
}

async function renderAgents() {
  await loadAgents();
  const models = Object.fromEntries(state.meta.models.map((m) => [m.id, m.label]));
  $('#agentsList').innerHTML = state.agents
    .map(
      (a) => `<div class="card">
      <h3>${esc(a.name)}</h3>
      <div class="hint">${esc(a.description || '')}</div>
      <div><span class="tag">${esc(models[a.model] || a.model)}</span><span class="tag">esfuerzo: ${esc(a.effort)}</span>
      ${(a.mcpServers || []).length ? `<span class="tag">${a.mcpServers.length} MCP</span>` : ''}
      ${(a.skills || []).length ? `<span class="tag">${a.skills.length} skills</span>` : ''}
      ${a.webSearch ? '<span class="tag">web</span>' : ''}</div>
      <div class="actions"><button data-edit="${esc(a.id)}">Editar</button><button data-use="${esc(a.id)}">Usar</button>
      ${state.agents.length > 1 ? `<button class="danger" data-del="${esc(a.id)}">Eliminar</button>` : ''}</div></div>`
    )
    .join('');
  $('#agentsList').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editAgent(state.agents.find((a) => a.id === b.dataset.edit))));
  $('#agentsList').querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => { $('#agentSelect').value = b.dataset.use; newChat(); }));
  $('#agentsList').querySelectorAll('[data-del]').forEach(
    (b) => (b.onclick = async () => { if (await confirmBox('¿Eliminar este agente?')) { await desk.agents.delete(b.dataset.del); renderAgents(); } })
  );
}

async function editAgent(agent) {
  const a = agent || { name: '', description: '', model: 'claude-opus-5-5', effort: 'medium', systemPrompt: '', mcpServers: [], skills: [], webSearch: false, confirmTools: true };
  const [servers, skills] = await Promise.all([desk.mcp.list(), desk.skills.list()]);
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  modal(
    `<h3>${agent ? 'Editar agente' : 'Nuevo agente'}</h3>
    <label>Nombre</label><input id="aName" value="${esc(a.name)}" />
    <label>Descripción</label><input id="aDesc" value="${esc(a.description)}" />
    <div class="row">
      <div><label>Modelo</label><select id="aModel">${state.meta.models.map((m) => `<option value="${m.id}" ${m.id === a.model ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
      <div><label>Esfuerzo (razonamiento)</label><select id="aEffort">${efforts.map((e) => `<option ${e === a.effort ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
    </div>
    <label>Instrucciones (system prompt)</label><textarea id="aSys" rows="7">${esc(a.systemPrompt)}</textarea>
    <label>Servidores MCP</label>
    <div class="checks">${servers.length ? servers.map((s) => `<label><input type="checkbox" class="aMcp" value="${esc(s.id)}" ${(a.mcpServers || []).includes(s.id) ? 'checked' : ''}/> ${esc(s.name)} <span class="tag">${esc(s.type)}</span></label>`).join('') : '<span class="hint">Aún no hay servidores MCP.</span>'}</div>
    <label>Skills</label>
    <div class="checks">${skills.length ? skills.map((s) => `<label><input type="checkbox" class="aSkill" value="${esc(s.folder)}" ${(a.skills || []).includes(s.folder) ? 'checked' : ''}/> ${esc(s.name)}</label>`).join('') : '<span class="hint">Aún no hay skills.</span>'}</div>
    <label class="inline"><input type="checkbox" id="aWeb" ${a.webSearch ? 'checked' : ''}/> Permitir búsqueda web</label>
    <label class="inline"><input type="checkbox" id="aConfirm" ${a.confirmTools ? 'checked' : ''}/> Pedir confirmación antes de ejecutar herramientas MCP</label>
    <div class="modal-actions"><button id="mCancel">Cancelar</button><button class="primary" id="mSave">Guardar</button></div>`,
    (m) => {
      m.querySelector('#mCancel').onclick = closeModal;
      m.querySelector('#mSave').onclick = async () => {
        const name = m.querySelector('#aName').value.trim();
        if (!name) return m.querySelector('#aName').focus();
        await desk.agents.save({
          ...a,
          name,
          description: m.querySelector('#aDesc').value.trim(),
          model: m.querySelector('#aModel').value,
          effort: m.querySelector('#aEffort').value,
          systemPrompt: m.querySelector('#aSys').value,
          mcpServers: [...m.querySelectorAll('.aMcp:checked')].map((i) => i.value),
          skills: [...m.querySelectorAll('.aSkill:checked')].map((i) => i.value),
          webSearch: m.querySelector('#aWeb').checked,
          confirmTools: m.querySelector('#aConfirm').checked,
        });
        closeModal();
        renderAgents();
      };
    }
  );
}
$('#addAgent').onclick = () => editAgent(null);

// ---------------- MCP ----------------
async function renderMcp() {
  const list = await desk.mcp.list();
  $('#mcpList').innerHTML =
    list
      .map(
        (s) => `<div class="card"><h3>${esc(s.name)}</h3><span class="tag">${esc(s.type)}</span>
      <div class="hint"><code>${esc(s.type === 'stdio' ? [s.command, ...(s.args || [])].join(' ') : s.url)}</code></div>
      <div class="hint" id="t-${esc(s.id)}"></div>
      <div class="actions"><button data-test="${esc(s.id)}">Probar</button><button data-edit="${esc(s.id)}">Editar</button><button class="danger" data-del="${esc(s.id)}">Eliminar</button></div></div>`
      )
      .join('') || '<p class="hint">No hay servidores todavía.</p>';
  const byId = (id) => list.find((s) => s.id === id);
  $('#mcpList').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editMcp(byId(b.dataset.edit))));
  $('#mcpList').querySelectorAll('[data-del]').forEach(
    (b) => (b.onclick = async () => { if (await confirmBox('¿Eliminar este servidor MCP?')) { await desk.mcp.delete(b.dataset.del); renderMcp(); } })
  );
  $('#mcpList').querySelectorAll('[data-test]').forEach(
    (b) =>
      (b.onclick = async () => {
        const out = document.getElementById(`t-${b.dataset.test}`);
        out.textContent = 'Conectando…';
        const r = await desk.mcp.test(byId(b.dataset.test));
        out.innerHTML = r.ok
          ? `<span style="color:var(--ok)">✓ ${r.tools.length} herramientas:</span> ${r.tools.map((t) => `<span class="tag" title="${esc(t.description)}">${esc(t.name)}</span>`).join('')}`
          : `<span class="error">✗ ${esc(r.error)}</span>`;
      })
  );
}

function parseKV(text, sep) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const kvText = (o, sep) => Object.entries(o || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');

// Divide una línea de argumentos respetando comillas.
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function editMcp(server) {
  const s = server || { name: '', type: 'stdio', command: 'npx', args: [], env: {}, url: '', headers: {} };
  modal(
    `<h3>${server ? 'Editar servidor MCP' : 'Nuevo servidor MCP'}</h3>
    <div class="row"><div><label>Nombre</label><input id="sName" value="${esc(s.name)}" placeholder="filesystem" /></div>
    <div><label>Tipo</label><select id="sType">
      <option value="stdio" ${s.type === 'stdio' ? 'selected' : ''}>Local (stdio)</option>
      <option value="http" ${s.type === 'http' ? 'selected' : ''}>Remoto (HTTP)</option>
      <option value="sse" ${s.type === 'sse' ? 'selected' : ''}>Remoto (SSE)</option></select></div></div>
    <div id="stdioF">
      <label>Comando</label><input id="sCmd" value="${esc(s.command)}" placeholder="npx" />
      <label>Argumentos</label><input id="sArgs" value="${esc((s.args || []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '))}" placeholder="-y @modelcontextprotocol/server-filesystem /Users/tu-usuario/Documents" />
      <label>Variables de entorno (una por línea, CLAVE=valor)</label><textarea id="sEnv" rows="3">${esc(kvText(s.env, '='))}</textarea>
    </div>
    <div id="httpF">
      <label>URL</label><input id="sUrl" value="${esc(s.url)}" placeholder="https://ejemplo.com/mcp" />
      <label>Cabeceras (una por línea, Nombre: valor)</label><textarea id="sHead" rows="3" placeholder="Authorization: Bearer …">${esc(kvText(s.headers, ': '))}</textarea>
    </div>
    <div class="modal-actions"><button id="mCancel">Cancelar</button><button class="primary" id="mSave">Guardar</button></div>`,
    (m) => {
      const sync = () => {
        const stdio = m.querySelector('#sType').value === 'stdio';
        m.querySelector('#stdioF').classList.toggle('hidden', !stdio);
        m.querySelector('#httpF').classList.toggle('hidden', stdio);
      };
      m.querySelector('#sType').onchange = sync;
      sync();
      m.querySelector('#mCancel').onclick = closeModal;
      m.querySelector('#mSave').onclick = async () => {
        const name = m.querySelector('#sName').value.trim();
        if (!name) return m.querySelector('#sName').focus();
        await desk.mcp.save({
          id: s.id,
          name,
          type: m.querySelector('#sType').value,
          command: m.querySelector('#sCmd').value.trim(),
          args: splitArgs(m.querySelector('#sArgs').value),
          env: parseKV(m.querySelector('#sEnv').value, '='),
          url: m.querySelector('#sUrl').value.trim(),
          headers: parseKV(m.querySelector('#sHead').value, ':'),
        });
        closeModal();
        renderMcp();
      };
    }
  );
}
$('#addMcp').onclick = () => editMcp(null);

// ---------------- Skills ----------------
async function renderSkills() {
  const list = await desk.skills.list();
  $('#skillsList').innerHTML =
    list
      .map(
        (s) => `<div class="card"><h3>${esc(s.name)}</h3><div class="hint">${esc(s.description)}</div>
      <div>${s.files.map((f) => `<span class="tag">${esc(f)}</span>`).join('')}</div>
      <div class="actions"><button data-edit="${esc(s.folder)}">Editar</button><button class="danger" data-del="${esc(s.folder)}">Eliminar</button></div></div>`
      )
      .join('') || '<p class="hint">No hay skills todavía.</p>';
  $('#skillsList').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editSkill(list.find((s) => s.folder === b.dataset.edit))));
  $('#skillsList').querySelectorAll('[data-del]').forEach(
    (b) => (b.onclick = async () => { if (await confirmBox('¿Eliminar esta skill y su carpeta?')) { await desk.skills.delete(b.dataset.del); renderSkills(); } })
  );
}

function editSkill(skill) {
  const s = skill || { name: '', description: '', body: '# Instrucciones\n\n1. …\n' };
  modal(
    `<h3>${skill ? 'Editar skill' : 'Nueva skill'}</h3>
    <label>Nombre</label><input id="kName" value="${esc(s.name)}" placeholder="informe-semanal" />
    <label>Descripción (cuándo debe usarla Claude)</label><input id="kDesc" value="${esc(s.description)}" placeholder="Úsala cuando el usuario pida un informe semanal…" />
    <label>Instrucciones (Markdown)</label><textarea id="kBody" rows="14">${esc(s.body)}</textarea>
    <div class="modal-actions"><button id="mCancel">Cancelar</button><button class="primary" id="mSave">Guardar</button></div>`,
    (m) => {
      m.querySelector('#mCancel').onclick = closeModal;
      m.querySelector('#mSave').onclick = async () => {
        const name = m.querySelector('#kName').value.trim();
        if (!name) return m.querySelector('#kName').focus();
        await desk.skills.save({ folder: skill?.folder, name, description: m.querySelector('#kDesc').value.trim(), body: m.querySelector('#kBody').value });
        closeModal();
        renderSkills();
      };
    }
  );
}
$('#addSkill').onclick = () => editSkill(null);
$('#openSkills').onclick = () => desk.skills.openDir();
$('#importSkill').onclick = async () => {
  const r = await desk.skills.import();
  if (r && !r.ok) alert(r.error);
  renderSkills();
};

// ---------------- Token ----------------
async function renderToken() {
  const info = await desk.token.info();
  $('#tokenState').innerHTML = info.hasToken
    ? `<span style="color:var(--ok)">✓ Token guardado</span> — <code>${esc(info.preview)}</code> <span class="tag">${esc(info.kind)}</span>`
    : '<span class="error">No hay token configurado.</span>';
}
$('#saveToken').onclick = async () => {
  const v = $('#tokenInput').value.trim();
  if (!v) return;
  $('#tokenMsg').textContent = 'Verificando…';
  const r = await desk.token.set(v);
  if (r.ok) {
    $('#tokenInput').value = '';
    $('#tokenMsg').innerHTML = `<span style="color:var(--ok)">Token válido.</span> Modelos disponibles: ${(r.models || []).map(esc).join(', ')}`;
    updateBanner();
  } else {
    $('#tokenMsg').innerHTML = `<span class="error">No se pudo verificar: ${esc(r.error)}</span>`;
  }
  renderToken();
};
$('#clearToken').onclick = async () => {
  if (await confirmBox('¿Borrar el token guardado?')) {
    await desk.token.set('');
    renderToken();
    updateBanner();
  }
};

async function updateBanner() {
  const info = await desk.token.info();
  const b = $('#banner');
  if (info.hasToken) return b.classList.add('hidden');
  b.innerHTML = '🔑 Primero configura tu token de autenticación. <a href="#" id="goToken">Ir a ajustes</a>';
  b.classList.remove('hidden');
  $('#goToken').onclick = (e) => (e.preventDefault(), show('settings'));
}

// ---------------- Chats ----------------
async function renderChatList() {
  const chats = await desk.chats.list();
  $('#chatList').innerHTML = chats
    .map((c) => `<li data-id="${esc(c.id)}" class="${c.id === state.currentChatId ? 'active' : ''}"><span>${esc(c.title)}</span><b class="del" data-del="${esc(c.id)}">✕</b></li>`)
    .join('');
  $('#chatList').querySelectorAll('li').forEach((li) => (li.onclick = () => openChat(li.dataset.id)));
  $('#chatList').querySelectorAll('[data-del]').forEach(
    (b) =>
      (b.onclick = async (e) => {
        e.stopPropagation();
        await desk.chats.delete(b.dataset.del);
        if (state.currentChatId === b.dataset.del) newChat();
        renderChatList();
      })
  );
}

function emptyState() {
  const agent = state.agents.find((a) => a.id === $('#agentSelect').value);
  $('#messages').innerHTML = `<div class="empty"><h1>¿En qué puedo ayudarte?</h1><p>Agente: <b>${esc(agent?.name || '')}</b></p></div>`;
}

function newChat() {
  state.currentChatId = null;
  state.live = null;
  show('chat');
  emptyState();
  setRunning(false);
  renderChatList();
  $('#input').focus();
}
$('#newChat').onclick = newChat;
$('#agentSelect').onchange = () => { if (!state.currentChatId) emptyState(); };

async function openChat(id) {
  const chat = await desk.chats.get(id);
  if (!chat) return;
  state.currentChatId = id;
  state.live = null;
  show('chat');
  if (state.agents.some((a) => a.id === chat.agentId)) $('#agentSelect').value = chat.agentId;
  renderMessages(chat.messages);
  setRunning(state.running.has(id));
  renderChatList();
}

function renderMessages(messages) {
  const box = $('#messages');
  box.innerHTML = '';
  let current = null;
  const tools = new Map();
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (m.role === 'user') {
      const results = blocks.filter((b) => b.type === 'tool_result');
      for (const r of results) {
        const el = tools.get(r.tool_use_id);
        if (el) fillToolResult(el, typeof r.content === 'string' ? r.content : (r.content || []).map((c) => c.text || `[${c.type}]`).join('\n'), r.is_error);
      }
      if (results.length === blocks.length) continue;
      current = null;
      const div = document.createElement('div');
      div.className = 'msg user';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      for (const b of blocks) {
        if (b.type === 'image') bubble.insertAdjacentHTML('beforeend', `<img src="data:${esc(b.source.media_type)};base64,${b.source.data}" />`);
        if (b.type === 'text') bubble.append(document.createTextNode(b.text));
      }
      div.append(bubble);
      box.append(div);
    } else {
      if (!current) {
        current = document.createElement('div');
        current.className = 'msg assistant';
        box.append(current);
      }
      for (const b of blocks) {
        if (b.type === 'thinking' && b.thinking) current.insertAdjacentHTML('beforeend', `<div class="thinking">${esc(b.thinking)}</div>`);
        else if (b.type === 'text') current.insertAdjacentHTML('beforeend', `<div class="md">${md(b.text)}</div>`);
        else if (b.type === 'tool_use') tools.set(b.id, appendTool(current, b.name, b.input));
        else if (b.type === 'server_tool_use') current.insertAdjacentHTML('beforeend', `<div class="notice">🔎 ${esc(b.name)}: ${esc(JSON.stringify(b.input))}</div>`);
      }
    }
  }
  box.scrollTop = box.scrollHeight;
}

function appendTool(parent, name, input) {
  const d = document.createElement('details');
  d.className = 'tool';
  d.innerHTML = `<summary>🔧 ${esc(name)} <span class="hint res">…</span></summary><pre>${esc(JSON.stringify(input, null, 2))}</pre>`;
  parent.append(d);
  return d;
}
function fillToolResult(el, text, isError) {
  el.classList.toggle('err', !!isError);
  el.querySelector('.res').textContent = isError ? '✗ error' : '✓';
  el.insertAdjacentHTML('beforeend', `<pre>${esc(text)}</pre>`);
}

// ---------------- Envío y streaming ----------------
function setRunning(on) {
  $('#stopBtn').classList.toggle('hidden', !on);
  $('#sendBtn').disabled = on;
  $('#status').textContent = on ? 'Claude está trabajando…' : '';
}

const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 260) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#fileInput').onchange = async (e) => {
  for (const f of e.target.files) {
    const data = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.readAsDataURL(f);
    });
    state.pendingImages.push({ mediaType: f.type, data });
  }
  e.target.value = '';
  renderAttachments();
};
function renderAttachments() {
  $('#attachments').innerHTML = state.pendingImages.map((im, i) => `<img data-i="${i}" title="Quitar" src="data:${esc(im.mediaType)};base64,${im.data}" />`).join('');
  $('#attachments').querySelectorAll('img').forEach((img) => (img.onclick = () => { state.pendingImages.splice(+img.dataset.i, 1); renderAttachments(); }));
}

$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || (state.currentChatId && state.running.has(state.currentChatId))) return;
  const info = await desk.token.info();
  if (!info.hasToken) return show('settings');

  if (!state.currentChatId) $('#messages').innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="bubble">${state.pendingImages.map((im) => `<img src="data:${esc(im.mediaType)};base64,${im.data}" />`).join('')}${esc(text)}</div>`;
  $('#messages').append(div);

  const images = state.pendingImages;
  state.pendingImages = [];
  renderAttachments();
  input.value = '';
  input.style.height = 'auto';

  const { chatId } = await desk.chat.send({ chatId: state.currentChatId, agentId: $('#agentSelect').value, text, images });
  state.currentChatId = chatId;
  state.running.add(chatId);
  setRunning(true);
  renderChatList();
};
$('#stopBtn').onclick = () => state.currentChatId && desk.chat.stop(state.currentChatId);

let renderTimer = null;
function flushRender() {
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = null;
  const L = state.live;
  if (!L) return;
  if (L.textEl) L.textEl.innerHTML = md(L.textRaw);
  if (L.thinkEl) L.thinkEl.textContent = L.thinkRaw;
  const box = $('#messages');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 200) box.scrollTop = box.scrollHeight;
}
function scheduleRender() {
  if (!renderTimer) renderTimer = requestAnimationFrame(flushRender);
}

function liveRoot() {
  if (!state.live) {
    const root = document.createElement('div');
    root.className = 'msg assistant';
    $('#messages').append(root);
    state.live = { root, textEl: null, textRaw: '', thinkEl: null, thinkRaw: '', tools: new Map() };
  }
  return state.live;
}

desk.chat.onEvent((ev) => {
  if (ev.type === 'done') {
    state.running.delete(ev.chatId);
    if (ev.chatId === state.currentChatId) {
      flushRender();
      setRunning(false);
      state.live = null;
    }
    renderChatList();
    return;
  }
  if (ev.chatId !== state.currentChatId) return;
  const L = liveRoot();
  if (ev.type === 'block_start' || ev.type === 'tool_use') flushRender();
  switch (ev.type) {
    case 'block_start':
      if (ev.kind === 'text') {
        L.textEl = document.createElement('div');
        L.textEl.className = 'md';
        L.textRaw = '';
        L.root.append(L.textEl);
      } else {
        L.thinkEl = document.createElement('div');
        L.thinkEl.className = 'thinking';
        L.thinkRaw = '';
        L.root.append(L.thinkEl);
      }
      break;
    case 'text':
      if (!L.textEl) { L.textEl = document.createElement('div'); L.textEl.className = 'md'; L.root.append(L.textEl); }
      L.textRaw += ev.text;
      scheduleRender();
      break;
    case 'thinking':
      if (L.thinkEl) { L.thinkRaw += ev.text; scheduleRender(); }
      break;
    case 'server_tool':
      L.root.insertAdjacentHTML('beforeend', `<div class="notice">🔎 ${esc(ev.name)}…</div>`);
      break;
    case 'tool_use':
      L.tools.set(ev.id, appendTool(L.root, ev.name, ev.input));
      L.textEl = null;
      break;
    case 'tool_result': {
      const el = L.tools.get(ev.id);
      if (el) fillToolResult(el, ev.text, ev.isError);
      break;
    }
    case 'usage':
      $('#status').textContent = `Claude está trabajando… (${ev.model} · ${ev.usage?.output_tokens ?? 0} tokens de salida)`;
      break;
    case 'notice':
      L.root.insertAdjacentHTML('beforeend', `<div class="notice">${esc(ev.text)}</div>`);
      break;
    case 'error':
      L.root.insertAdjacentHTML('beforeend', `<div class="error">⚠️ ${esc(ev.text)}</div>`);
      break;
  }
});

desk.chat.onApproval((req) => {
  modal(
    `<h3>¿Permitir herramienta?</h3><p>Claude quiere ejecutar <code>${esc(req.name)}</code> con:</p><pre>${esc(JSON.stringify(req.input, null, 2))}</pre>
    <div class="modal-actions"><button id="apNo">Rechazar</button><button class="primary" id="apYes">Permitir</button></div>`,
    (m) => {
      m.querySelector('#apNo').onclick = () => { closeModal(); desk.chat.approve({ requestId: req.requestId, ok: false }); };
      m.querySelector('#apYes').onclick = () => { closeModal(); desk.chat.approve({ requestId: req.requestId, ok: true }); };
    }
  );
});

// ---------------- Inicio ----------------
(async function init() {
  state.meta = await desk.meta();
  await loadAgents();
  await renderChatList();
  newChat();
  updateBanner();
})();
