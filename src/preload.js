const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  meta: invoke('meta'),
  token: { info: invoke('token:info'), set: invoke('token:set') },
  agents: { list: invoke('agents:list'), save: invoke('agents:save'), delete: invoke('agents:delete') },
  mcp: { list: invoke('mcp:list'), save: invoke('mcp:save'), delete: invoke('mcp:delete'), test: invoke('mcp:test') },
  skills: {
    list: invoke('skills:list'),
    save: invoke('skills:save'),
    delete: invoke('skills:delete'),
    openDir: invoke('skills:openDir'),
    import: invoke('skills:import'),
  },
  chats: { list: invoke('chats:list'), get: invoke('chats:get'), delete: invoke('chats:delete') },
  chat: {
    send: invoke('chat:send'),
    stop: invoke('chat:stop'),
    approve: invoke('chat:approve'),
    onEvent: (cb) => ipcRenderer.on('chat:event', (_e, ev) => cb(ev)),
    onApproval: (cb) => ipcRenderer.on('chat:approval', (_e, ev) => cb(ev)),
  },
});
