/**
 * 批量解析给引擎用的 provider + key。
 *
 * 对应 apps/desktop/src/main/provider/service.ts 的 resolveForSession()：
 * 渲染进程保存的 provider 必须能被引擎读到，这是设置页能否生效的关键。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelDescriptor } from "@rakko/shared";
import { ProviderStore, createPlaintextSecretBox } from "../store.js";

function model(id: string): ModelDescriptor {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxOutput: 8_192,
    capabilities: { supportsTools: true, supportsImage: false, supportsThinking: false },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

let dir: string;
let store: ProviderStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-resolve-"));
  store = new ProviderStore(ProviderStore.defaultPath(dir), createPlaintextSecretBox());
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 与 service.resolveForSession 相同的循环逻辑 */
async function resolveAll(s: ProviderStore) {
  const views = await s.list();
  const providers = [];
  let apiKey = "";
  for (const v of views) {
    const r = await s.resolveForRuntime(v.id);
    providers.push(r.config);
    if (!apiKey && r.apiKey) apiKey = r.apiKey;
  }
  return { providers, apiKey };
}

describe("批量解析", () => {
  it("空仓库返回空列表与空 key", async () => {
    const { providers, apiKey } = await resolveAll(store);
    expect(providers).toEqual([]);
    expect(apiKey).toBe("");
  });

  it("保存后能解析出完整配置（含模型）", async () => {
    await store.create({
      id: "gw1",
      name: "我的网关",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      models: [model("m1"), model("m2")],
      apiKey: "sk-abc123",
    });

    const { providers, apiKey } = await resolveAll(store);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.baseUrl).toBe("https://example.com/v1");
    expect(providers[0]?.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(apiKey).toBe("sk-abc123");
  });

  it("多个 provider 时取第一个有 key 的，不混用", async () => {
    await store.create({
      id: "nokey",
      name: "没 key 的",
      api: "openai-completions",
      baseUrl: "https://a.example.com/v1",
      models: [model("a")],
      // 不传 apiKey
    });
    await store.create({
      id: "withkey",
      name: "有 key 的",
      api: "openai-completions",
      baseUrl: "https://b.example.com/v1",
      models: [model("b")],
      apiKey: "sk-second",
    });

    const { providers, apiKey } = await resolveAll(store);
    expect(providers).toHaveLength(2);
    // 没有 key 的 provider 仍返回配置，但不会被当成 key 来源
    expect(providers.map((p) => p.id).sort()).toEqual(["nokey", "withkey"]);
    expect(apiKey).toBe("sk-second");
  });

  it("更新模型后再次解析反映最新状态", async () => {
    await store.create({
      id: "gw",
      name: "网关",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      models: [model("m1"), model("m2")],
      apiKey: "sk-x",
    });
    await store.update("gw", { models: [model("m1")] });

    const { providers } = await resolveAll(store);
    expect(providers[0]?.models.map((m) => m.id)).toEqual(["m1"]);
  });
});
