/**
 * IPC 路由。
 *
 * 每个 handler 都做参数校验 —— 渲染进程传来的东西一律不可信。
 * 这一层只做转发与校验，业务在 packages/core。
 */
import type { IpcMain } from "electron";
import { app } from "electron";
import { IPC, PRODUCT_NAME } from "@rakko/shared";
import type {
  PermissionResolveInput,
  ProjectInfo,
  SendMessageInput,
  SessionInfo,
  SetPermissionModeInput,
  StartSessionInput,
} from "@rakko/shared";
import type { SessionManager } from "../session/manager.js";
import type { ProviderService } from "../provider/service.js";
import type { PersistenceService } from "../persistence/service.js";
import { readBootstrapProviders, toModelSummaries } from "../bootstrap-config.js";

export function registerIpc(
  ipcMain: IpcMain,
  sessions: SessionManager,
  providers: ProviderService,
  persistence: PersistenceService,
): void {
  ipcMain.handle(IPC.getAppInfo, () => ({
    name: PRODUCT_NAME,
    version: app.getVersion(),
  }));

  // 只返回展示信息，key 与 baseUrl 不出主进程
  ipcMain.handle(IPC.listModels, () => {
    const { providers } = readBootstrapProviders();
    return toModelSummaries(providers);
  });

  // ── 运营商配置 ──
  ipcMain.handle(IPC.listProviders, async () => providers.list());

  ipcMain.handle(IPC.createProvider, async (_e, input: unknown) => {
    assertShape(input, ["id", "name", "api", "baseUrl", "models"], "createProvider");
    return providers.create(input as Parameters<ProviderService["create"]>[0]);
  });

  ipcMain.handle(IPC.updateProvider, async (_e, payload: unknown) => {
    assertShape(payload, ["id", "patch"], "updateProvider");
    const { id, patch } = payload as { id: string; patch: Record<string, unknown> };
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("updateProvider: id 必须是非空字符串");
    }
    if (typeof patch !== "object" || patch === null) {
      throw new Error("updateProvider: patch 必须是对象");
    }
    return providers.update(id, patch as Parameters<ProviderService["update"]>[1]);
  });

  ipcMain.handle(IPC.deleteProvider, async (_e, id: unknown) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("deleteProvider: id 必须是非空字符串");
    }
    await providers.remove(id);
  });

  ipcMain.handle(IPC.listRemoteModels, async (_e, input: unknown) => {
    assertShape(input, ["baseUrl", "apiKey"], "listRemoteModels");
    return providers.listRemote(input as Parameters<ProviderService["listRemote"]>[0]);
  });

  ipcMain.handle(IPC.testProvider, async (_e, input: unknown) => {
    assertShape(input, ["baseUrl", "apiKey", "model"], "testProvider");
    return providers.test(input as Parameters<ProviderService["test"]>[0]);
  });

  // ── 项目与会话（持久化）──
  ipcMain.handle(IPC.listProjects, async (): Promise<ProjectInfo[]> => persistence.listProjects());

  ipcMain.handle(IPC.openProject, async (_e, cwd: unknown): Promise<ProjectInfo> => {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new Error("openProject: cwd 必须是非空字符串");
    }
    return persistence.openProject(cwd);
  });

  ipcMain.handle(IPC.listSessions, async (_e, projectId: unknown): Promise<SessionInfo[]> => {
    if (typeof projectId !== "string") throw new Error("listSessions: projectId 必须是字符串");
    return persistence.listSessions(projectId);
  });

  ipcMain.handle(IPC.listRecentSessions, async (_e, limit: unknown) => {
    const n = typeof limit === "number" && Number.isFinite(limit) ? limit : 20;
    return persistence.listRecentSessions(n);
  });

  ipcMain.handle(IPC.listMessages, async (_e, payload: unknown) => {
    assertShape(payload, ["sessionId"], "listMessages");
    const { sessionId, options } = payload as {
      sessionId: string;
      options?: { limit?: number; beforeId?: number };
    };
    if (typeof sessionId !== "string") throw new Error("listMessages: sessionId 必须是字符串");
    return persistence.listMessages(sessionId, options ?? {});
  });

  ipcMain.handle(IPC.renameSession, async (_e, payload: unknown) => {
    assertShape(payload, ["sessionId", "title"], "renameSession");
    const { sessionId, title } = payload as { sessionId: string; title: string };
    if (typeof sessionId !== "string" || typeof title !== "string") {
      throw new Error("renameSession: sessionId 与 title 必须是字符串");
    }
    if (title.trim().length === 0) throw new Error("renameSession: 标题不能为空");
    persistence.renameSession(sessionId, title.trim());
  });

  ipcMain.handle(IPC.deleteSession, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string") throw new Error("deleteSession: sessionId 必须是字符串");
    await sessions.stop(sessionId);
    persistence.deleteSession(sessionId);
  });

  ipcMain.handle(IPC.createSession, async (_e, projectId: unknown): Promise<SessionInfo> => {
    if (typeof projectId !== "string") throw new Error("createSession: projectId 必须是字符串");
    return persistence.createSession(projectId);
  });

  // ── 会话运行时 ──
  ipcMain.handle(IPC.startSession, async (_e, input: unknown) => {
    const parsed = input as StartSessionInput;
    assertShape(parsed, ["sessionId", "cwd", "promptSections", "tools"], "startSession");
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) {
      throw new Error("startSession: sessionId 必须是非空字符串");
    }
    if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) {
      throw new Error("startSession: cwd 必须是非空字符串");
    }

    // provider 与 key 由主进程从环境变量读，不信任渲染进程传入
    const boot = readBootstrapProviders();
    if (boot.providers.length === 0) {
      throw new Error(`缺少模型配置：${boot.missing.join(" / ")} 未设置`);
    }

    return sessions.start({
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      providers: boot.providers,
      apiKey: boot.apiKey,
      promptSections: Array.isArray(parsed.promptSections) ? parsed.promptSections : [],
      tools: parsed.tools ?? "all",
    });
  });

  ipcMain.handle(IPC.stopSession, async (_e, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== "string") throw new Error("stopSession: sessionId 必须是字符串");
    await sessions.stop(sessionId);
  });

  ipcMain.handle(IPC.sendMessage, async (_e, input: unknown): Promise<void> => {
    const parsed = input as SendMessageInput;
    assertShape(parsed, ["sessionId", "text"], "sendMessage");
    if (typeof parsed.sessionId !== "string" || typeof parsed.text !== "string") {
      throw new Error("sendMessage: sessionId 与 text 必须是字符串");
    }
    await sessions.send(parsed.sessionId, parsed.text);
  });

  ipcMain.handle(IPC.abort, async (_e, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== "string") throw new Error("abort: sessionId 必须是字符串");
    await sessions.abort(sessionId);
  });

  ipcMain.handle(IPC.resolvePermission, async (_e, input: unknown): Promise<void> => {
    const parsed = input as PermissionResolveInput;
    assertShape(parsed, ["sessionId", "callId", "decision"], "resolvePermission");
    if (typeof parsed.sessionId !== "string" || typeof parsed.callId !== "string") {
      throw new Error("resolvePermission: sessionId 与 callId 必须是字符串");
    }
    if (!["allow-once", "allow-type", "deny"].includes(parsed.decision)) {
      throw new Error(`resolvePermission: 非法的 decision ${String(parsed.decision)}`);
    }
    await sessions.respondPermission(parsed.sessionId, parsed.callId, parsed.decision);
  });

  ipcMain.handle(IPC.setPermissionMode, async (_e, input: unknown): Promise<void> => {
    const parsed = input as SetPermissionModeInput;
    assertShape(parsed, ["sessionId", "mode"], "setPermissionMode");
    if (typeof parsed.sessionId !== "string") {
      throw new Error("setPermissionMode: sessionId 必须是字符串");
    }
    await sessions.setPermissionMode(parsed.sessionId, parsed.mode);
  });
}

/**
 * 最小形状校验。拦住「字段缺失 / 类型完全错」这类明显问题。
 */
function assertShape(input: unknown, required: string[], where: string): void {
  if (typeof input !== "object" || input === null) {
    throw new Error(`${where}: 参数必须是对象`);
  }
  for (const key of required) {
    if (!(key in input)) {
      throw new Error(`${where}: 缺少必填字段 ${key}`);
    }
  }
}
