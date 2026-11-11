/**
 * 构造 pi 子进程的 spawn env。
 *
 * ⚠️ 不变量 2：同一 sessionId 重建时，env 必须**逐字节稳定**。
 *
 * 任何随调用变化的量（randomBytes / Date.now / 自增计数）进入 env，
 * 都会让「断链重连」变成「杀掉重建」，毁掉会话保活语义。
 *
 * 所以这里所有值都由 sessionId 确定性派生，或者干脆是常量。
 */
import path from "node:path";

export interface BuildPiEnvOptions {
  /** 会话 id，用于派生稳定值 */
  sessionId: string;
  /** pi 的配置目录（绝对路径） */
  agentHome: string;
  /** CompatProxy 的端口 */
  proxyPort: number;
  /** 额外的 env（如 taskShellEnv），也会参与稳定性计算 */
  extra?: Record<string, string>;
  /** 基础 env，默认 process.env */
  baseEnv?: NodeJS.ProcessEnv;
}

/** 占位 key 前缀。真 key 只存在于 proxy 内存，不进这个 env。 */
export const PLACEHOLDER_KEY_PREFIX = "proxy-managed-";

/**
 * 由 sessionId 确定性派生的占位值。
 *
 * 必须是纯函数：同输入必同输出。不要改成 randomBytes。
 */
export function derivePlaceholderKey(sessionId: string): string {
  return `${PLACEHOLDER_KEY_PREFIX}${sessionId.slice(0, 8)}`;
}

/**
 * 构造 env。返回的对象键顺序也固定（按插入顺序），
 * 便于直接做逐字节比较。
 */
export function buildPiEnv(options: BuildPiEnvOptions): Record<string, string> {
  const { sessionId, agentHome, proxyPort, extra, baseEnv } = options;

  // 从基础 env 里挑出需要的，避免把整个 process.env 透传（也避免不稳定）
  const base = baseEnv ?? process.env;
  const picked: Record<string, string> = {};

  // pi 与 node 运行必需
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    const v = base[key];
    if (typeof v === "string" && v.length > 0) picked[key] = v;
  }

  const env: Record<string, string> = {
    ...picked,

    // pi 的配置目录（session 级隔离）
    PI_CODING_AGENT_DIR: path.resolve(agentHome),

    // 占位 key：models.json 里写的是 $RAKKO_PI_API_KEY，
    // 这里放一个无意义的值，proxy 收到请求后换成真 key。
    RAKKO_PI_API_KEY: derivePlaceholderKey(sessionId),

    // proxy 用这个反查该会话该用哪把真 key
    RAKKO_PI_SESSION_ID: sessionId,
    RAKKO_PI_PROXY_PORT: String(proxyPort),

    // 关键：防止全局代理把 loopback 请求劫走
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",

    // 关掉 pi 启动期的联网操作（版本检查、telemetry 之类）
    PI_OFFLINE: "1",
  };

  // 额外 env 最后合并，避免被覆盖
  if (extra) {
    for (const [k, v] of Object.entries(extra)) env[k] = v;
  }

  return env;
}

/**
 * 计算 env 指纹，用于判断两次 spawn 是否等价。
 *
 * 只做「同不同」的判断，不作为安全边界。
 */
export function hashPiEnv(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  return keys.map((k) => `${k}=${env[k]}`).join("\n");
}
