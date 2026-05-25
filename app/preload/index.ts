import { contextBridge, ipcRenderer } from 'electron';
import { buildRendererBridge } from '../main/ipc.js';

const bridge = buildRendererBridge(ipcRenderer);

contextBridge.exposeInMainWorld('sprout', bridge);

declare global {
  interface Window {
    sprout: typeof bridge;
  }
}
