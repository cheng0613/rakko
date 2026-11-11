/**
 * 写 system prompt 的追加文件。
 *
 * ⚠️ 这是本项目最容易出事的地方。实测（pi 1.4.0）：
 *
 *   pi --append-system-prompt "does-not-exist.md"
 *   → 不报错、退出码 0，system prompt 里出现的是字面文本 "does-not-exist.md"
 *
 * 用户看到的现象是「伙伴不按人设说话」，而真实原因是路径写错了。
 * pi 不会告诉我们，所以我们必须在写之前、写之后都自己校验。
 *
 * 另：内联文本在约 7,700 字符处会报「命令行太长」（Windows CreateProcess 限制），
 * 所以只要超过 2,000 字符一律走文件，不赌运气。
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** 超过这个字符数就必须走文件路径，不能内联到命令行。实测上限约 7,700，取保守值。 */
export const INLINE_LIMIT = 2000;

export const APPEND_PROMPT_FILENAME = "append-system-prompt.md";

export class AppendPromptError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EMPTY"
      | "VERIFY_FAILED"
      | "BYTE_MISMATCH"
      | "NOT_ABSOLUTE"
      | "STAT_FAILED",
  ) {
    super(message);
    this.name = "AppendPromptError";
  }
}

export interface WriteAppendPromptResult {
  /** 绝对路径，可直接传给 --append-system-prompt */
  absolutePath: string;
  /** 实际写入的字节数 */
  bytes: number;
  /** 内容 sha256 前 16 位，写进日志便于排查「提示词到底加载了没」 */
  hash: string;
}

/**
 * 把多段文本拼成追加提示词并落盘。
 *
 * @param configHome 该会话的独立配置目录（绝对路径）
 * @param sections  按顺序拼接的段落；空段自动跳过
 */
export async function writeAppendPrompt(
  configHome: string,
  sections: string[],
): Promise<WriteAppendPromptResult> {
  const text = sections
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");

  if (text.length === 0) {
    throw new AppendPromptError(
      "追加提示词为空。若确实不需要追加内容，就不要传 --append-system-prompt 参数，" +
        "而不是传一个空文件（pi 会把空内容当无事发生）。",
      "EMPTY",
    );
  }

  const target = path.join(configHome, APPEND_PROMPT_FILENAME);
  const tmp = `${target}.${process.pid}.tmp`;

  await fs.mkdir(configHome, { recursive: true });
  await fs.writeFile(tmp, text, "utf8");

  // ── 回读校验（不变量 8 的核心）──
  const readBack = await fs.readFile(tmp, "utf8");
  if (readBack !== text) {
    await fs.rm(tmp, { force: true });
    throw new AppendPromptError(
      "追加提示词写入后回读不一致。磁盘可能已满或被截断。",
      "VERIFY_FAILED",
    );
  }

  const expectedBytes = Buffer.byteLength(text, "utf8");
  const actualBytes = Buffer.byteLength(readBack, "utf8");
  if (expectedBytes !== actualBytes) {
    await fs.rm(tmp, { force: true });
    throw new AppendPromptError(
      `追加提示词字节数不一致：期望 ${expectedBytes}，实际 ${actualBytes}（编码问题？）`,
      "BYTE_MISMATCH",
    );
  }

  await fs.rename(tmp, target);

  // ── 落盘后再次确认文件真的在那里且非空 ──
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (e) {
    throw new AppendPromptError(
      `追加提示词落盘后 stat 失败：${(e as Error).message}`,
      "STAT_FAILED",
    );
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new AppendPromptError(
      `追加提示词落盘后不是有效文件（isFile=${stat.isFile()}, size=${stat.size}）`,
      "STAT_FAILED",
    );
  }

  // ── 必须是绝对路径：相对路径会受 pi 子进程 cwd 影响，可能解析到别处 ──
  if (!path.isAbsolute(target)) {
    throw new AppendPromptError(
      `追加提示词路径必须是绝对路径，实际是 ${target}`,
      "NOT_ABSOLUTE",
    );
  }

  return {
    absolutePath: target,
    bytes: expectedBytes,
    hash: sha256Prefix(text),
  };
}

/**
 * spawn 之前的最后一道检查。
 *
 * pi 对不存在的文件静默降级 —— 我们宁可不启动，也不要带着缺失的提示词跑起来。
 */
export async function assertAppendPromptUsable(
  absolutePath: string,
  expectedBytes?: number,
): Promise<void> {
  if (!path.isAbsolute(absolutePath)) {
    throw new AppendPromptError(
      `spawn 前的路径检查失败：${absolutePath} 不是绝对路径`,
      "NOT_ABSOLUTE",
    );
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    throw new AppendPromptError(
      `spawn 前检查失败：${absolutePath} 不存在。` +
        `pi 会把不存在的路径当字面文本塞进 system prompt，不报错 —— 所以这里必须先拦下。`,
      "STAT_FAILED",
    );
  }

  if (!stat.isFile()) {
    throw new AppendPromptError(`spawn 前检查失败：${absolutePath} 不是文件`, "STAT_FAILED");
  }
  if (stat.size === 0) {
    throw new AppendPromptError(`spawn 前检查失败：${absolutePath} 是空文件`, "EMPTY");
  }
  if (expectedBytes !== undefined && stat.size !== expectedBytes) {
    throw new AppendPromptError(
      `spawn 前检查失败：${absolutePath} 大小 ${stat.size} 与预期 ${expectedBytes} 不符（文件被改动过？）`,
      "BYTE_MISMATCH",
    );
  }
}

function sha256Prefix(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
