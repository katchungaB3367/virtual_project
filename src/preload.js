'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action, payload) => ipcRenderer.invoke('vault:request', action, payload);
contextBridge.exposeInMainWorld('quietvault', {
  state: () => invoke('state'),
  choose: mode => invoke('choose', mode),
  authenticate: data => invoke('authenticate', data),
  list: query => invoke('list', query),
  get: id => invoke('get', id),
  save: data => invoke('save', data),
  remove: id => invoke('delete', id),
  generate: () => invoke('generate'),
  copy: value => invoke('copy', value),
  backup: () => invoke('backup'),
  lock: () => invoke('lock'),
  activity: () => invoke('activity'),
  dirty: value => invoke('dirty', value),
  confirmDiscard: () => invoke('confirmDiscard'),
  confirmGenerate: () => invoke('confirmGenerate'),
  onLocked: callback => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on('vault:locked', listener);
    return () => ipcRenderer.removeListener('vault:locked', listener);
  }
});
