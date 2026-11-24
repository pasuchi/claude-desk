// Bucle de conversación con Claude: streaming + herramientas (MCP, skills, web search).
const Anthropic = require('@anthropic-ai/sdk');
const { skillTooling } = require('./skills');

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];

// Modelos con reintento automático en el servidor si el modelo rechaza la petición.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5']);

function makeClient(token) {
  if (!token) throw new Error('No hay token configurado. Ve a Ajustes y pega tu token.');
  // API keys de la Console (sk-ant-api…) van en x-api-key; cualquier otro token
  // se envía como Authorization: Bearer.
  if (token.startsWith('sk-ant-api')) return new Anthropic({ apiKey: token, authToken: null });
  return new Anthropic({ apiKey: null, authToken: token });
}

async function verifyToken(token) {
  const client = makeClient(token);
  const page = await client.models.list({ limit: 5 });
  return page.data.map((m) => m.id);
}

class ChatRunner {
  constructor({ store, mcp, send, askApproval }) {
    this.store = store;
    this.mcp = mcp;
    this.send = send; // (event) => void, enviado al renderer
    this.askApproval = askApproval; // async ({chatId,name,input}) => boolean
    this.active = new Map(); // chatId -> { stream, aborted }
  }

  stop(chatId) {
    const a = this.active.get(chatId);
    if (a) {
      a.aborted = true;
      try { a.stream?.abort(); } catch {}
    }
  }

  async run(chat, agent) {
    const chatId = chat.id;
    const state = { stream: null, aborted: false };
    this.active.set(chatId, state);
    const emit = (type, data = {}) => this.send({ chatId, type, ...data });

    try {
      const client = makeClient(this.store.getToken());

      // Herramientas: MCP del agente + skills del agente + web search opcional.
      const servers = this.store.listMcp().filter((s) => (agent.mcpServers || []).includes(s.id));
      const { defs: mcpTools, routes, errors } = await this.mcp.toolsFor(servers);
      for (const e of errors) emit('notice', { text: `No se pudo conectar el MCP ${e}` });

      const skills = skillTooling(this.store.skillsDir(), agent.skills || []);
      const tools = [...skills.tools, ...mcpTools];
      if (agent.webSearch) tools.push({ type: 'web_search_20260209', name: 'web_search' });

      const system = (agent.systemPrompt || '') + skills.prompt;
      const useFallback = FALLBACK_MODELS.has(agent.model);

      while (!state.aborted) {
        const params = {
          model: agent.model,
          max_tokens: 64000,
          system: system || undefined,
          messages: chat.messages,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: agent.effort || 'medium' },
          cache_control: { type: 'ephemeral' },
        };
        if (tools.length) params.tools = tools;
        if (useFallback) {
          params.betas = ['server-side-fallback-2026-07-01'];
          params.fallbacks = 'default';
        }

        emit('turn_start');
        const stream = useFallback ? client.beta.messages.stream(params) : client.messages.stream(params);
        state.stream = stream;

        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start') {
            const b = ev.content_block;
            if (b.type === 'thinking') emit('block_start', { kind: 'thinking' });
            else if (b.type === 'text') emit('block_start', { kind: 'text' });
            else if (b.type === 'server_tool_use') emit('server_tool', { name: b.name });
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'text_delta') emit('text', { text: ev.delta.text });
            else if (ev.delta.type === 'thinking_delta') emit('thinking', { text: ev.delta.thinking });
          }
        });

        let message;
        try {
          message = await stream.finalMessage();
        } catch (err) {
          if (state.aborted) break;
          throw err;
        }

        chat.messages.push({ role: 'assistant', content: message.content });
        for (const b of message.content) {
          if (b.type === 'fallback') emit('notice', { text: `${b.from?.model} declinó; continuó ${b.to?.model}` });
        }
        emit('usage', { usage: message.usage, model: message.model });

        if (message.stop_reason === 'pause_turn') continue;
        if (message.stop_reason === 'refusal') {
          emit('notice', { text: `Claude rechazó la petición${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.` });
          break;
        }

        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        if (message.stop_reason !== 'tool_use' || !toolUses.length) {
          if (message.stop_reason === 'max_tokens') {
            emit('notice', { text: 'Respuesta cortada: se alcanzó el límite de tokens.' });
            if (toolUses.length) {
              chat.messages.push({
                role: 'user',
                content: toolUses.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: 'Llamada cortada por límite de tokens; no se ejecutó.', is_error: true })),
              });
            }
          }
          break;
        }

        // Ejecutar herramientas (en paralelo) y devolver todos los resultados juntos.
        const results = await Promise.all(
          toolUses.map(async (tu) => {
            emit('tool_use', { id: tu.id, name: tu.name, input: tu.input });
            let text, content, isError = false;
            try {
              if (tu.name === 'use_skill' || tu.name === 'read_skill_file') {
                const r = skills.handle(tu.name, tu.input);
                text = r.text;
                isError = !!r.isError;
                content = text;
              } else if (routes.has(tu.name)) {
                const ok = !agent.confirmTools || (await this.askApproval({ chatId, name: tu.name, input: tu.input }));
                if (!ok) {
                  content = text = 'El usuario rechazó ejecutar esta herramienta.';
                  isError = true;
                } else {
                  const r = await this.mcp.call(routes.get(tu.name), tu.input);
                  content = r.content;
                  isError = r.isError;
                  text = r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
                }
              } else {
                content = text = `Herramienta desconocida: ${tu.name}`;
                isError = true;
              }
            } catch (e) {
              content = text = `Error: ${e.message}`;
              isError = true;
            }
            emit('tool_result', { id: tu.id, text: String(text).slice(0, 4000), isError });
            return { type: 'tool_result', tool_use_id: tu.id, content, is_error: isError };
          })
        );
        chat.messages.push({ role: 'user', content: results });
        this.store.saveChat(chat);
      }
    } catch (err) {
      let msg = err.message;
      if (err instanceof Anthropic.AuthenticationError) msg = 'Token inválido o caducado (401). Revísalo en Ajustes.';
      else if (err instanceof Anthropic.PermissionDeniedError) msg = 'El token no tiene permiso para esta operación (403).';
      else if (err instanceof Anthropic.RateLimitError) msg = 'Límite de uso alcanzado (429). Espera un momento.';
      else if (err instanceof Anthropic.APIError) msg = `Error de la API ${err.status ?? ''}: ${err.message}`;
      emit('error', { text: msg });
    } finally {
      this.active.delete(chatId);
      this.store.saveChat(chat);
      emit('done');
    }
  }
}

module.exports = { ChatRunner, MODELS, verifyToken };
