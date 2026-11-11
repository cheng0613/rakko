/**
 * 主进程侧的运营商服务。
 *
 * 把 ProviderStore（持久化）与 probe（连通性）包在一起，
 * 并保证 key 只在主进程内流转。
 */
import { app } from "electron";
import path from "node:path";
import {
  ProviderStore,
  ProviderStoreError,
  listRemoteModels,
  testConnection,
  type SecretBox,
} from "@rakko/core";
import type {
  ListRemoteModelsInput,
  ListRemoteModelsResult,
  ProviderView,
  TestProviderInput,
  TestProviderResult,
  UpsertProviderInput,
} from "@rakko/shared";
import { createElectronSecretBox } from "../secret-box.desktop.js";

export class ProviderService {
  private store: ProviderStore | null = null;

  private getStore(): ProviderStore {
    if (this.store) return this.store;
    const baseDir = path.join(app.getPath("userData"), "config");
    const box: SecretBox = createElectronSecretBox();
    this.store = new ProviderStore(ProviderStore.defaultPath(baseDir), box);
    return this.store;
  }

  async list(): Promise<ProviderView[]> {
    return this.getStore().list();
  }

  async create(input: UpsertProviderInput): Promise<ProviderView> {
    return this.getStore().create({
      id: input.id,
      name: input.name,
      api: input.api,
      baseUrl: input.baseUrl,
      models: input.models,
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    });
  }

  async update(id: string, patch: Partial<UpsertProviderInput>): Promise<ProviderView> {
    if (patch.id !== undefined && patch.id !== id) {
      throw new ProviderStoreError("不允许修改 provider 的 id", "INVALID");
    }
    return this.getStore().update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.api !== undefined ? { api: patch.api } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
      ...(patch.models !== undefined ? { models: patch.models } : {}),
      ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
    });
  }

  async remove(id: string): Promise<void> {
    return this.getStore().remove(id);
  }

  /**
   * 拉远端模型列表。
   *
   * 用调用方传来的临时 key（比如用户刚填还没保存的），不读存储、不落盘。
   * 这样「填了 key 点刷新」不需要先保存。
   */
  async listRemote(input: ListRemoteModelsInput): Promise<ListRemoteModelsResult> {
    if (!input.baseUrl || !input.apiKey) {
      return { ok: false, models: [], status: 0, error: "baseUrl 与 apiKey 都必须提供" };
    }
    return listRemoteModels({ baseUrl: input.baseUrl, apiKey: input.apiKey });
  }

  /** 测试连通性 */
  async test(input: TestProviderInput): Promise<TestProviderResult> {
    if (!input.baseUrl || !input.apiKey || !input.model) {
      return {
        ok: false,
        latencyMs: 0,
        status: 0,
        error: "baseUrl、apiKey、model 都必须提供",
      };
    }
    return testConnection({ baseUrl: input.baseUrl, apiKey: input.apiKey, model: input.model });
  }

  /**
   * 取出启动会话需要的配置与真 key。
   * **只在主进程内部调用，结果不经过 IPC。**
   */
  async resolveForRuntime(id: string): Promise<{ config: import("@rakko/shared").ProviderConfig; apiKey: string }> {
    return this.getStore().resolveForRuntime(id);
  }
}
