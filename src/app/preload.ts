import { contextBridge, ipcRenderer } from 'electron';
import type { DiffViewerApi } from '../domain/types.ts';
import type * as contract from '../domain/types.ts';

// Restated under their own names: a sandboxed preload can only require 'electron', not the app's own modules. The types
// keep them equal.
const CALL_CHANNEL: typeof contract.CALL_CHANNEL = 'diff-viewer:call';
const VIEW_CHANNEL: typeof contract.VIEW_CHANNEL = 'diff-viewer:requested-view';
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke(CALL_CHANNEL, method, args);

const api: DiffViewerApi = {
  openRepository: () => call('openRepository'),
  repository: (list = null) => call('repository', list),
  commits: skip => call('commits', skip),
  resolveCommit: text => call('resolveCommit', text),
  files: source => call('files', source),
  fileDiff: (source, path, showLarge, oldPath = null) => call('fileDiff', source, path, showLarge, oldPath),
  recent: () => call('recent'),
  openRecent: path => call('openRecent', path),
  requestedView: () => call('requestedView'),
  viewReady: (id, report) => call('viewReady', id, report),
  onRequestedView: callback => {
    ipcRenderer.on(VIEW_CHANNEL, (_event, view) => callback(view));
  },
};

contextBridge.exposeInMainWorld('diffViewer', Object.freeze(api));
