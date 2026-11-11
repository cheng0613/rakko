/**
 * IPC 路由。
 *
 * 每个 handler 都做参数校验 —— 渲染进程传来的东西一律不可信。
 * 这一层只做转发与校验，真正的业务在 packages/core。
 */
import type { IpcMain } from "electron";
import { app } from "electron";
import { IPC, PRODUCT_NAME } from "@rakko/shared";
import type {
  ProjectInfo,
  SendMessageInput,
  SessionInfo,
  SetPermissionModeInput,
  PermissionResolveInput,
} from "@rakko/shared";

export function registerIpc(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.getAppInfo, () => ({
    name: PRODUCT_NAME,
    version: app.getVersion(),
  }));

  ipcMain.handle(IPC.listProjects, async (): Promise<ProjectInfo[]> => {
    // P0 阶段：还没有项目持久化。先返回空列表，让 UI 能跑起来。
    return [];
  });

  ipcMain.handle(IPC.openProject, async (_e, cwd: unknown): Promise<ProjectInfo> => {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new Error("openProject: cwd 必须是非空字符串");
    }
    // 未实现：见 PLAN P0 后续步骤
    throw new Error("openProject 尚未实现（P0 步骤 10）");
  });

  ipcMain.handle(IPC.listSessions, async (_e, projectId: unknown): Promise<SessionInfo[]> => {
    if (typeof projectId !== "string") throw new Error("listSessions: projectId 必须是字符串");
    return [];
  });

  ipcMain.handle(IPC.createSession, async (_e, projectId: unknown): Promise<SessionInfo> => {
    if (typeof projectId !== "string") throw new Error("createSession: projectId 必须是字符串");
    throw new Error("createSession 尚未实现（P0 步骤 6）");
  });

  ipcMain.handle(IPC.sendMessage, async (_e, input: unknown): Promise<void> => {
    assertShape(input, ["sessionId", "text"], "sendMessage");
    throw new Error("sendMessage 尚未实现（P0 步骤 6）");
  });

  ipcMain.handle(IPC.abort, async (_e, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== "string") throw new Error("abort: sessionId 必须是字符串");
    throw new Error("abort 尚未实现（P0 步骤 6）");
  });

  ipcMain.handle(IPC.resolvePermission, async (_e, input: unknown): Promise<void> => {
    assertShape(input, ["sessionId", "callId", "decision"], "resolvePermission");
    throw new Error("resolvePermission 尚未实现（P0 步骤 11）");
  });

  ipcMain.handle(IPC.setPermissionMode, async (_e, input: unknown): Promise<void> => {
    assertShape(input, ["sessionId", "mode"], "setPermissionMode");
    throw new Error("setPermissionMode 尚未实现（P0 步骤 11）");
  });
}

/**
 * 最小形状校验。
 *
 * 不是完整的 schema 校验 —— P0 先拦住「字段缺失 / 类型完全错」这类明显问题。
 * 等接入 zod 再统一。
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

// 保留类型引用，避免 TS 报未使用
export type _IpcTypes = [
  SendMessageInput,
  SetPermissionModeInput,
  PermissionResolveInput,
];
