import { describe, expect, it } from "vitest";
import type { ModelDescriptor, ProviderConfig } from "@rakko/shared";
import { ModelsJsonError, buildModelsJson } from "../models-json.js";

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: "test-model",
    name: "Test Model",
    contextWindow: 128000,
    maxOutput: 4096,
    capabilities: { supportsTools: true, supportsImage: false, supportsThinking: false },
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "probe",
    name: "Probe",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    models: [model()],
    ...overrides,
  };
}

const BASE = {
  proxyBaseUrl: "http://127.0.0.1:52847/v1",
  providers: [provider()],
};

describe("buildModelsJson —— cost 四字段防护（不变量 9）", () => {
  it("四字段齐全时通过", () => {
    const out = buildModelsJson(BASE);
    expect(out.providers.probe?.models[0]?.cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  it.each(["input", "output", "cacheRead", "cacheWrite"])(
    "缺少 cost.%s 时必须抛错，而不是生成会让 pi 拒绝整个文件的内容",
    (field) => {
      const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
      delete (cost as Record<string, number>)[field];

      expect(() =>
        buildModelsJson({
          ...BASE,
          providers: [provider({ models: [model({ cost: cost as ModelDescriptor["cost"] })] })],
        }),
      ).toThrow(ModelsJsonError);
    },
  );

  it("错误信息必须指明是哪个 provider 的哪个模型缺了哪个字段", () => {
    try {
      buildModelsJson({
        ...BASE,
        providers: [
          provider({
            id: "myprovider",
            models: [model({ id: "mymodel", cost: { input: 1, output: 2 } as ModelDescriptor["cost"] })],
          }),
        ],
      });
      expect.unreachable("应该抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelsJsonError);
      const err = e as ModelsJsonError;
      expect(err.details.join("\n")).toContain("providers.myprovider.models.mymodel.cost.cacheRead");
      expect(err.details.join("\n")).toContain("providers.myprovider.models.mymodel.cost.cacheWrite");
    }
  });

  it("负数 cost 必须拒绝", () => {
    expect(() =>
      buildModelsJson({
        ...BASE,
        providers: [
          provider({ models: [model({ cost: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 } })] }),
        ],
      }),
    ).toThrow(ModelsJsonError);
  });

  it("NaN cost 必须拒绝", () => {
    expect(() =>
      buildModelsJson({
        ...BASE,
        providers: [
          provider({
            models: [model({ cost: { input: NaN, output: 2, cacheRead: 0, cacheWrite: 0 } })],
          }),
        ],
      }),
    ).toThrow(ModelsJsonError);
  });
});

describe("buildModelsJson —— key 与 baseUrl 的写法（方案 A）", () => {
  it("baseUrl 一律指向 proxy，而不是 provider 自己的上游", () => {
    const out = buildModelsJson(BASE);
    expect(out.providers.probe?.baseUrl).toBe("http://127.0.0.1:52847/v1");
    expect(out.providers.probe?.baseUrl).not.toBe("https://api.example.com/v1");
  });

  it("apiKey 写环境变量插值，不写真 key", () => {
    const out = buildModelsJson(BASE);
    expect(out.providers.probe?.apiKey).toBe("$RAKKO_PI_API_KEY");
  });

  it("可以自定义环境变量名", () => {
    const out = buildModelsJson({ ...BASE, apiKeyEnvVar: "MY_KEY" });
    expect(out.providers.probe?.apiKey).toBe("$MY_KEY");
  });

  it("生成的内容里不得出现任何看起来像真 key 的字符串", () => {
    const json = JSON.stringify(buildModelsJson(BASE));
    expect(json).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});

describe("buildModelsJson —— 结构校验", () => {
  it("没有 provider 时抛错", () => {
    expect(() => buildModelsJson({ proxyBaseUrl: BASE.proxyBaseUrl, providers: [] })).toThrow(
      ModelsJsonError,
    );
  });

  it("provider 没有模型时抛错", () => {
    expect(() =>
      buildModelsJson({ ...BASE, providers: [provider({ models: [] })] }),
    ).toThrow(ModelsJsonError);
  });

  it("模型 id 重复时抛错", () => {
    expect(() =>
      buildModelsJson({
        ...BASE,
        providers: [provider({ models: [model(), model()] })],
      }),
    ).toThrow(ModelsJsonError);
  });

  it("contextWindow 或 maxOutput 非正数时抛错", () => {
    expect(() =>
      buildModelsJson({
        ...BASE,
        providers: [provider({ models: [model({ contextWindow: 0 })] })],
      }),
    ).toThrow(ModelsJsonError);
    expect(() =>
      buildModelsJson({
        ...BASE,
        providers: [provider({ models: [model({ maxOutput: -1 })] })],
      }),
    ).toThrow(ModelsJsonError);
  });

  it("proxyBaseUrl 为空时抛错", () => {
    expect(() => buildModelsJson({ ...BASE, proxyBaseUrl: "" })).toThrow(ModelsJsonError);
  });
});
