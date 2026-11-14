'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  onState(cb) {
    ipcRenderer.on('state:update', (_e, s) => cb(s));
  },
  onToast(cb) {
    ipcRenderer.on('toast', (_e, t) => cb(t));
  },
  ready() {
    ipcRenderer.send('renderer:ready');
  },
  hide() {
    ipcRenderer.send('widget:hide');
  },
  resize(height) {
    ipcRenderer.send('widget:resize', height);
  },
});
