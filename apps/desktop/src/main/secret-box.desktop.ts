/**
 * Electron 的 SecretBox 实现。
 *
 * 用 safeStorage：Windows 走 DPAPI、macOS 走 Keychain、Linux 走 libsecret。
 * 密文落盘，明文只在内存里存在一瞬。
 *
 * safeStorage 在 Linux 上可能不可用（没装 libsecret / 无桌面环境）。
 * 这时我们**不降级成明文** —— 而是明确报错，让用户知道 key 存不了。
 */
import { safeStorage } from "electron";
import type { SecretBox } from "@rakko/core";

export class SafeStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeStorageUnavailableError";
  }
}

export function createElectronSecretBox(): SecretBox {
  return {
    secure: true,
    async seal(plain: string): Promise<string> {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new SafeStorageUnavailableError(
          "系统的安全存储不可用，无法保存 API key。" +
            "Linux 上通常是因为缺少 libsecret 或没有可用的密钥环。",
        );
      }
      const buf = safeStorage.encryptString(plain);
      return `safe:${buf.toString("base64")}`;
    },
    async open(sealed: string): Promise<string> {
      if (!sealed.startsWith("safe:")) {
        throw new SafeStorageUnavailableError("不是 safeStorage 封装的密文");
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new SafeStorageUnavailableError("系统的安全存储不可用，无法解密 API key");
      }
      const buf = Buffer.from(sealed.slice(5), "base64");
      return safeStorage.decryptString(buf);
    },
  };
}
