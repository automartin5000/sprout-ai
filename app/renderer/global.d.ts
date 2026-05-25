import type { ChatStreamEvent, RendererBridge } from '../main/ipc.js';

declare global {
  interface Window {
    sprout: RendererBridge;
  }
}

export type { ChatStreamEvent };
