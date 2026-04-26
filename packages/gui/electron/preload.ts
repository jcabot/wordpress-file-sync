import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

interface BridgeEvent {
  type: 'start' | 'item' | 'conflict' | 'done' | 'log';
  payload: unknown;
}

const api = {
  lastRootDir: () => ipcRenderer.invoke('wpsync:lastRootDir'),
  checkConfig: (rootDir: string | null) => ipcRenderer.invoke('wpsync:checkConfig', rootDir),
  pickFolder: () => ipcRenderer.invoke('wpsync:pickFolder'),
  testWpJson: (siteUrl: string) => ipcRenderer.invoke('wpsync:testWpJson', siteUrl),
  testAuth: (args: { siteUrl: string; username: string; password: string }) =>
    ipcRenderer.invoke('wpsync:testAuth', args),
  init: (args: { rootDir: string; siteUrl: string; username: string; password: string }) =>
    ipcRenderer.invoke('wpsync:init', args),
  adopt: (rootDir: string) => ipcRenderer.invoke('wpsync:adopt', rootDir),
  status: () => ipcRenderer.invoke('wpsync:status'),
  pull: (args: { full?: boolean; forcePull?: boolean; resolutions?: Record<string, string> } = {}) =>
    ipcRenderer.invoke('wpsync:pull', args),
  push: (args: { forcePush?: boolean; resolutions?: Record<string, string> } = {}) =>
    ipcRenderer.invoke('wpsync:push', args),
  openConfigFile: () => ipcRenderer.invoke('wpsync:openConfigFile'),
  onEvent: (cb: (event: BridgeEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, evt: BridgeEvent): void => cb(evt);
    ipcRenderer.on('wpsync:event', listener);
    return () => {
      ipcRenderer.off('wpsync:event', listener);
    };
  },
};

contextBridge.exposeInMainWorld('wpsync', api);

export type WpsyncBridge = typeof api;
