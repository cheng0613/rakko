import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelDescriptor } from "@rakko/shared";
import {
  PROVIDERS_FILENAME,
  ProviderStore,
  ProviderStoreError,
  createPlaintextSecretBox,
  maskKey,
  validateProviderConfig,
} from "../store.js";

let dir: string;
let store: ProviderStore;

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: "m1",
    name: "M1",
    contextWindow: 128_000,
    maxOutput: 8_192,
    capabilities: { supportsTools: true, supportsImage: false, supportsThinking: false },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

const BASE_INPUT = {
  id: "mine",
  name: "我的网关",
  api: "openai-completions" as const,
  baseUrl: "https://example.com/v1",
  models: [model()],
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-providers-"));
  store = new ProviderStore(ProviderStore.defaultPath(dir), createPlaintextSecretBox());
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("key 不进返回值（不变量 13）", () => {
  it("create 返回的对象里没有 key 字段", async () => {
    const created = await store.create({ ...BASE_INPUT, apiKey: "sk-secret-value-1234" });
    const json = JSON.stringify(created);
    expect(json).not.toContain("sk-secret-value-1234");
    expect(json).not.toContain("sealedKey");
  });

  it("list 里只有掩码", async () => {
    await store.create({ ...BASE_INPUT, apiKey: "sk-secret-value-1234" });
    const all = await store.list();
    expect(all[0]?.hasKey).toBe(true);
    expect(all[0]?.keyMask).toContain("sk-");
    expect(JSON.stringify(all)).not.toContain("sk-secret-value-1234");
  });

  it("resolveForRuntime 才给出真 key", async () => {
    await store.create({ ...BASE_INPUT, apiKey: "sk-secret-value-1234" });
    const resolved = await store.resolveForRuntime("mine");
    expect(resolved.apiKey).toBe("sk-secret-value-1234");
    expect(resolved.config.baseUrl).toBe("https://example.com/v1");
    expect(resolved.config.models).toHaveLength(1);
  });

  it("磁盘上的文件不含明文 key", async () => {
    await store.create({ ...BASE_INPUT, apiKey: "sk-secret-value-1234" });
    const raw = await fs.readFile(path.join(dir, PROVIDERS_FILENAME), "utf8");
    expect(raw).not.toContain("sk-secret-value-1234");
  });
});

describe("掩码", () => {
  it("露出前 3 与后 4", () => {
    const mask = maskKey("sk-abcdefghijklmn");
    expect(mask.startsWith("sk-")).toBe(true);
    expect(mask.endsWith("klmn")).toBe(true);
    expect(mask).toContain("•");
  });

  it("短 key 全掩", () => {
    expect(maskKey("short")).toBe("•••••");
  });

  it("空 key 返回空串", () => {
    expect(maskKey("")).toBe("");
  });
});

describe("增删改查", () => {
  it("新建后能查到", async () => {
    await store.create(BASE_INPUT);
    const got = await store.get("mine");
    expect(got?.name).toBe("我的网关");
  });

  it("id 重复时拒绝", async () => {
    await store.create(BASE_INPUT);
    await expect(store.create(BASE_INPUT)).rejects.toMatchObject({ code: "DUPLICATE_ID" });
  });

  it("删除后查不到", async () => {
    await store.create(BASE_INPUT);
    await store.remove("mine");
    expect(await store.get("mine")).toBeNull();
  });

  it("删除不存在的报 NOT_FOUND", async () => {
    await expect(store.remove("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("更新 baseUrl 不动 key", async () => {
    await store.create({ ...BASE_INPUT, apiKey: "k1" });
    await store.update("mine", { baseUrl: "https://other.com/v1" });
    const resolved = await store.resolveForRuntime("mine");
    expect(resolved.config.baseUrl).toBe("https://other.com/v1");
    expect(resolved.apiKey).toBe("k1");
  });

  it("apiKey 三态：undefined 保持、空串清空、非空替换", async () => {
    await store.create({ ...BASE_INPUT, apiKey: "k1" });

    await store.update("mine", { name: "改名" });
    expect((await store.resolveForRuntime("mine")).apiKey).toBe("k1");

    await store.update("mine", { apiKey: "k2" });
    expect((await store.resolveForRuntime("mine")).apiKey).toBe("k2");

    await store.update("mine", { apiKey: "" });
    expect((await store.resolveForRuntime("mine")).apiKey).toBe("");
  });
});

describe("配置校验（与 models.json 同口径）", () => {
  it("合法配置没问题", () => {
    expect(validateProviderConfig(BASE_INPUT)).toEqual([]);
  });

  it("id 非法时报错", () => {
    expect(validateProviderConfig({ ...BASE_INPUT, id: "有空格 的" }).length).toBeGreaterThan(0);
    expect(validateProviderConfig({ ...BASE_INPUT, id: "a".repeat(65) }).length).toBeGreaterThan(0);
  });

  it("baseUrl 非法时报错", () => {
    expect(validateProviderConfig({ ...BASE_INPUT, baseUrl: "not-a-url" }).length).toBeGreaterThan(0);
    expect(validateProviderConfig({ ...BASE_INPUT, baseUrl: "ftp://x" }).length).toBeGreaterThan(0);
  });

  it("没有模型时报错", () => {
    expect(validateProviderConfig({ ...BASE_INPUT, models: [] }).length).toBeGreaterThan(0);
  });

  it("cost 缺字段时报错 —— 缺字段会让 pi 拒绝整个 models.json", () => {
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      delete (cost as Record<string, number>)[field];
      const problems = validateProviderConfig({
        ...BASE_INPUT,
        models: [model({ cost: cost as ModelDescriptor["cost"] })],
      });
      expect(problems.join("\n")).toContain(`cost.${field}`);
    }
  });

  it("contextWindow / maxOutput 非正数时报错", () => {
    expect(
      validateProviderConfig({ ...BASE_INPUT, models: [model({ contextWindow: 0 })] }).length,
    ).toBeGreaterThan(0);
    expect(
      validateProviderConfig({ ...BASE_INPUT, models: [model({ maxOutput: -1 })] }).length,
    ).toBeGreaterThan(0);
  });

  it("模型 id 重复时报错", () => {
    expect(
      validateProviderConfig({ ...BASE_INPUT, models: [model(), model()] }).length,
    ).toBeGreaterThan(0);
  });

  it("非法配置在 create 时就被拒绝，不写盘", async () => {
    await expect(
      store.create({ ...BASE_INPUT, baseUrl: "bad" }),
    ).rejects.toBeInstanceOf(ProviderStoreError);
    expect(await store.list()).toHaveLength(0);
  });
});

describe("坏文件处理", () => {
  it("文件不存在时返回空列表（不是报错）", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("文件是坏 JSON 时报 CORRUPT_FILE", async () => {
    await fs.writeFile(path.join(dir, PROVIDERS_FILENAME), "{not json", "utf8");
    const fresh = new ProviderStore(ProviderStore.defaultPath(dir), createPlaintextSecretBox());
    await expect(fresh.list()).rejects.toMatchObject({ code: "CORRUPT_FILE" });
  });

  it("version 不对时报错", async () => {
    await fs.writeFile(
      path.join(dir, PROVIDERS_FILENAME),
      JSON.stringify({ version: 2, providers: [] }),
      "utf8",
    );
    const fresh = new ProviderStore(ProviderStore.defaultPath(dir), createPlaintextSecretBox());
    await expect(fresh.list()).rejects.toMatchObject({ code: "CORRUPT_FILE" });
  });
});

describe("原子写", () => {
  it("不留下临时文件", async () => {
    await store.create(BASE_INPUT);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([PROVIDERS_FILENAME]);
  });
});
