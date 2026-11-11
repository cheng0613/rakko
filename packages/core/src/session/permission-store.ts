/**
 * 权限档的持久化。
 *
 * bridge 扩展每次 tool_call 都从文件现读，所以这里写文件就是「热切换」。
 * 不需要重启 pi 进程。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PERMISSION_MODES, coercePermissionMode, type PermissionMode } from "@rakko/shared";

export const PERMISSION_FILENAME = "perm.json";

export interface PermissionFileShape {
  mode: PermissionMode;
  updatedAt: number;
}

/**
 * 写权限档。
 *
 * 原子写：先写临时文件再 rename，避免 bridge 读到半个文件
 * （读到半个文件会解析失败 → fail-closed 到 ask，虽然不是安全事故，但会莫名多问）。
 */
export async function writePermissionMode(
  runtimeDir: string,
  mode: PermissionMode,
): Promise<string> {
  const target = path.join(runtimeDir, PERMISSION_FILENAME);
  const tmp = `${target}.${process.pid}.tmp`;

  const payload: PermissionFileShape = {
    mode: coercePermissionMode(mode),
    updatedAt: Date.now(),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;

  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(tmp, text, "utf8");

  const readBack = await fs.readFile(tmp, "utf8");
  if (readBack !== text) {
    await fs.rm(tmp, { force: true });
    throw new Error("perm.json 写入后回读不一致");
  }

  await fs.rename(tmp, target);
  return target;
}

/**
 * 读权限档。读不到或非法一律返回最严档 —— 与 bridge 的 fail-closed 保持一致。
 */
export async function readPermissionMode(runtimeDir: string): Promise<PermissionMode> {
  try {
    const raw = await fs.readFile(path.join(runtimeDir, PERMISSION_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<PermissionFileShape>;
    return coercePermissionMode(parsed.mode);
  } catch {
    return PERMISSION_MODES[0]!;
  }
}
