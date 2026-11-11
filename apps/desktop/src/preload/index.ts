/**
 * preload：唯一的桥。
 *
 * 只暴露白名单 API，不暴露 ipcRenderer 本身 —— 否则渲染进程可以调任意通道。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@rakko/shared";
import type { AgentEvent, RakkoApi, Unsubscribe } from "@rakko/shared";

const api: RakkoApi = {
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  openProject: (cwd) => ipcRenderer.invoke(IPC.openProject, cwd),
  listSessions: (projectId) => ipcRenderer.invoke(IPC.listSessions, projectId),
  createSession: (projectId) => ipcRenderer.invoke(IPC.createSession, projectId),
  startSession: (input) => ipcRenderer.invoke(IPC.startSession, input),
  stopSession: (sessionId) => ipcRenderer.invoke(IPC.stopSession, sessionId),
  sendMessage: (input) => ipcRenderer.invoke(IPC.sendMessage, input),
  abort: (sessionId) => ipcRenderer.invoke(IPC.abort, sessionId),
  resolvePermission: (input) => ipcRenderer.invoke(IPC.resolvePermission, input),
  setPermissionMode: (input) => ipcRenderer.invoke(IPC.setPermissionMode, input),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  listModels: () => ipcRenderer.invoke(IPC.listModels),

  listProviders: () => ipcRenderer.invoke(IPC.listProviders),
  createProvider: (input) => ipcRenderer.invoke(IPC.createProvider, input),
  updateProvider: (id, patch) => ipcRenderer.invoke(IPC.updateProvider, { id, patch }),
  deleteProvider: (id) => ipcRenderer.invoke(IPC.deleteProvider, id),
  listRemoteModels: (input) => ipcRenderer.invoke(IPC.listRemoteModels, input),
  testProvider: (input) => ipcRenderer.invoke(IPC.testProvider, input),

  onAgentEvent: (sessionId: string, handler: (event: AgentEvent) => void): Unsubscribe => {
    const listener = (_e: unknown, payload: { sessionId: string; event: AgentEvent }) => {
      if (payload.sessionId !== sessionId) return;
      handler(payload.event);
    };
    ipcRenderer.on(IPC.agentEvent, listener);
    return () => {
      ipcRenderer.off(IPC.agentEvent, listener);
    };
  },
};

contextBridge.exposeInMainWorld("rakko", api);
