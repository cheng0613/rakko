// 运营商配置后端验证：存储 → 拉模型 → 测试连通
// 运行：RAKKO_API_KEY=xxx npx tsx scripts/e2e-provider.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProviderStore,
  createPlaintextSecretBox,
  joinUrl,
  listRemoteModels,
  modelFromRemoteId,
  testConnection,
} from "@rakko/core";

const BASE = process.env["RAKKO_BASE_URL"] ?? "https://d-openai.juneyaoair.com/llm/v1";
const KEY = process.env["RAKKO_API_KEY"] ?? "";
const MODEL = process.env["RAKKO_MODEL"] ?? "deepseek-v4-flash";

if (!KEY) {
  console.error("缺少 RAKKO_API_KEY");
  process.exit(1);
}

function line(s = ""): void {
  console.log(s);
}

async function main(): Promise<void> {
  line("=== 0. URL 拼接 ===");
  for (const [b, s] of [
    ["https://api.openai.com/v1", "/models"],
    ["https://d-openai.juneyaoair.com/llm/v1", "/models"],
    ["https://h", "/v1/models"],
  ] as const) {
    line(`  ${b} + ${s} → ${joinUrl(b, s)}`);
  }

  line("\n=== 1. 拉取远端模型列表 ===");
  const listed = await listRemoteModels({ baseUrl: BASE, apiKey: KEY });
  line(`  ok=${listed.ok} status=${listed.status} 数量=${listed.models.length}`);
  if (!listed.ok) {
    line(`  错误: ${listed.error}`);
  } else {
    line(`  前 6 个: ${listed.models.slice(0, 6).map((m) => m.id).join(", ")}`);
  }

  line("\n=== 2. 测试连通性 ===");
  const tested = await testConnection({ baseUrl: BASE, apiKey: KEY, model: MODEL });
  line(`  ok=${tested.ok} status=${tested.status} 延迟=${tested.latencyMs}ms`);
  if (tested.reply) line(`  回复: ${JSON.stringify(tested.reply.slice(0, 40))}`);
  if (tested.error) line(`  错误: ${tested.error}`);

  line("\n=== 3. 保存 provider（平文 box，仅验证逻辑）===");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rakko-prov-"));
  const file = ProviderStore.defaultPath(dir);
  const store = new ProviderStore(file, createPlaintextSecretBox());

  const created = await store.create({
    id: "juneyao",
    name: "均瑶内网网关",
    api: "openai-completions",
    baseUrl: BASE,
    models: [modelFromRemoteId(MODEL)],
    apiKey: KEY,
  });
  line(`  创建成功: id=${created.id} name=${created.name}`);
  line(`  hasKey=${created.hasKey} keyMask=${created.keyMask}`);
  line(`  返回值里含真 key: ${JSON.stringify(created).includes(KEY)}`);

  line("\n=== 4. 磁盘文件检查 ===");
  const disk = fs.readFileSync(file, "utf8");
  line(`  磁盘含明文 key: ${disk.includes(KEY)}`);
  const parsed = JSON.parse(disk) as { providers: Array<{ sealedKey: string }> };
  line(`  落盘的是: ${parsed.providers[0]!.sealedKey.slice(0, 24)}…`);

  line("\n=== 5. resolveForRuntime ===");
  const resolved = await store.resolveForRuntime("juneyao");
  line(`  解出真 key 正确: ${resolved.apiKey === KEY}`);
  line(`  配置 baseUrl: ${resolved.config.baseUrl}`);

  line("\n=== 6. 列表与掩码 ===");
  const all = await store.list();
  line(`  列表长度: ${all.length}`);
  line(`  列表里含真 key: ${JSON.stringify(all).includes(KEY)}`);

  line("\n=== 7. 校验拦截坏配置 ===");
  try {
    await store.create({
      id: "bad",
      name: "坏配置",
      api: "openai-completions",
      baseUrl: "not-a-url",
      models: [],
    });
    line("  ✗ 坏配置竟然通过了");
  } catch (e) {
    line(`  ✓ 已拦下: ${(e as Error).message.slice(0, 80)}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  const allOk =
    listed.ok &&
    tested.ok &&
    !JSON.stringify(created).includes(KEY) &&
    !disk.includes(KEY) &&
    resolved.apiKey === KEY;

  line(`\n=== 总判定: ${allOk ? "全部通过" : "有失败项"} ===`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("ERR:", e);
  process.exit(1);
});
