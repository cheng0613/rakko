import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  AgentLoop,
  ApprovalGate,
  createBuiltinTools,
  FakeProvider,
  ProviderGateway,
  ToolRegistry,
  type AgentHooks,
  type ChatMessage,
  type EmbeddingProvider,
  type ModelProvider,
  type ModelTier,
  type PluginHost,
} from '@rakko/core';
import {
  approvalDecisionSchema,
  createRunInput,
  continueRunInput,
  createAutomationInput,
  createMemoryInput,
  createSkillInput,
  createThreadInput,
  messagesQuery,
  updateAutomationInput,
  updateMemoryInput,
  updateSkillInput,
  TERMINAL_STATES,
  updateSettingsInput,
  updateThreadInput,
  type Message,
  type Run,
  type RunEvent,
  type RunState,
} from '@rakko/protocol';

import { describeCron, selectDue, validateCron } from './automation.js';
import { extractMemories } from './memory-extract.js';
import { MemoryStore, type PendingCall, type RunStore } from './store.js';

const invalid = (issues: unknown[]) => ({ error: 'invalid_request', message: '请求体不合法', issues });

export const FAKE_MODELS: Record<ModelTier, string> = { standard: 'fake-standard', fast: 'fake-fast' };

/** 消息分页默认每页条数 */
const DEFAULT_MESSAGE_PAGE = 30;

export interface AppOptions {
  store?: RunStore;
  gateway?: ProviderGateway;
  /** 没给 gateway 时的便捷入口，默认假 provider */
  provider?: ModelProvider;
  /** 不传就用工作区的内置工具（读、列、写、跑命令） */
  tools?: ToolRegistry;
  workspace?: string;
  approvalTimeoutMs?: number;
  maxSteps?: number;
  /** 自动化巡检间隔，测试里调小 */
  automationIntervalMs?: number;
  /** 工具插件宿主；不存在时 /v1/plugins 返回空 */
  plugins?: PluginHost;
  /** 语义检索；没有就退回关键词 */
  embeddings?: EmbeddingProvider;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = options.store ?? new MemoryStore();
  const gateway =
    options.gateway ??
    new ProviderGateway({
      provider: options.provider ?? new FakeProvider(),
      models: FAKE_MODELS,
      firstChunkTimeoutMs: 5_000,
    });

  const workspace = options.workspace ?? process.cwd();
  const tools = options.tools ?? new ToolRegistry({ workspace });
  if (!options.tools) {
    for (const tool of createBuiltinTools({ workspace })) tools.register(tool);
  }

  const gate = new ApprovalGate({ timeoutMs: options.approvalTimeoutMs ?? 10 * 60_000 });
  /** 用户点过「允许这类」的工具；启动时从设置里读回来 */
  const grants = new Set<string>();
  const loop = new AgentLoop(gateway, tools, { maxSteps: options.maxSteps ?? 12 });

  const timers = new Set<ReturnType<typeof setInterval>>();
  let automationTimer: ReturnType<typeof setInterval> | null = null;
  const controllers = new Map<string, AbortController>();
  const canceled = new Set<string>();

  app.get('/health', async () => {
    const policy = await resolveToolPolicy();

    return {
    ok: true,
    service: 'rakko-api',
    version: '0.2.0',
    provider: gateway.providerId,
    models: gateway.models,
    breakers: { standard: gateway.breakerState('standard'), fast: gateway.breakerState('fast') },
    store: store.kind,
    workspace,
    tools: tools.list().map((tool) => ({ name: tool.name, risk: tool.risk, approval: tool.requiresApproval })),
    ...(policy.restricted ? { restrictedTools: policy.restricted } : {}),
      pendingApprovals: gate.size,
    };
  });

  /**
   * 界面是自包含单文件，由服务端直接吐出，同源就没有跨域问题。
   * 不缓存：改完 HTML 刷新就能看到，不用重启（M0 阶段这比省一次读盘重要）。
   */
  // 打包后界面不在 ../web，用 RAKKO_WEB_DIR 指过去
  const webFile = process.env.RAKKO_WEB_DIR
    ? path.join(process.env.RAKKO_WEB_DIR, 'index.html')
    : new URL('../../web/index.html', import.meta.url);
  app.get('/', async (_request, reply) => {
    try {
      const html = await readFile(webFile, 'utf8');
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
    } catch {
      return reply.code(404).send({ error: 'web_missing', message: '界面文件 apps/web/index.html 不在' });
    }
  });

  /* ---------------- 技能 ---------------- */

  const skillsWithState = async () => {
    const [items, settings] = await Promise.all([store.listSkills(), store.getSettings()]);
    const enabled = new Set(settings.enabledSkills);
    return items.map((item) => ({ ...item, enabled: enabled.has(item.slug) }));
  };

  app.get('/v1/skills', async () => ({ items: await skillsWithState() }));

  app.post('/v1/skills', async (request, reply) => {
    const parsed = createSkillInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    const skill = await store.createSkill(parsed.data);
    return reply.code(201).send({ ...skill, enabled: false });
  });

  app.patch('/v1/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    // 挂载状态存在用户设置里（按 slug），改内容才动技能本身
    if (typeof body.enabled === 'boolean') {
      const skills = await store.listSkills();
      const skill = skills.find((item) => item.id === id);
      if (!skill) return reply.code(404).send({ error: 'skill_not_found', message: '技能不存在' });

      const settings = await store.getSettings();
      const next = new Set(settings.enabledSkills);
      if (body.enabled) next.add(skill.slug);
      else next.delete(skill.slug);
      await store.updateSettings({ enabledSkills: [...next] });
      return { ...skill, enabled: body.enabled };
    }

    const parsed = updateSkillInput.safeParse(body);
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    const skill = await store.updateSkill(id, parsed.data);
    if (!skill) return reply.code(404).send({ error: 'skill_not_found', message: '技能不存在' });
    return { ...skill, enabled: false };
  });

  app.delete('/v1/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await store.deleteSkill(id))) {
      return reply
        .code(409)
        .send({ error: 'skill_not_deletable', message: '内置技能不能删，可以关掉它' });
    }
    return { ok: true };
  });

  /* ---------------- 记忆 ---------------- */

  /** 算一条记忆的向量；失败返回 null（检索会退回关键词） */
  async function embedFor(title: string, body: string): Promise<number[] | null> {
    if (!options.embeddings) return null;
    try {
      const [vector] = await options.embeddings.embed([`${title}\n${body}`.slice(0, 2000)]);
      return vector ?? null;
    } catch {
      return null;
    }
  }


  app.get('/v1/memories', async () => ({ items: await store.listMemories() }));

  app.get('/v1/graph', async () => store.listGraph());

  app.post('/v1/memories', async (request, reply) => {
    const parsed = createMemoryInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    return reply.code(201).send(
      await store.createMemory({ ...parsed.data, embedding: await embedFor(parsed.data.title, parsed.data.body) }),
    );
  });

  app.patch('/v1/memories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateMemoryInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    const memory = await store.updateMemory(id, parsed.data);
    if (!memory) return reply.code(404).send({ error: 'memory_not_found', message: '这条记忆不存在' });
    return memory;
  });

  app.delete('/v1/memories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await store.deleteMemory(id))) {
      return reply.code(404).send({ error: 'memory_not_found', message: '这条记忆不存在' });
    }
    return { ok: true };
  });

  /* ---------------- 自动化 ---------------- */

  /** 跑一次自动化：开一个会话、起一个运行，和手动发一句没有区别 */
  async function runAutomation(automation: { id: string; name: string; prompt: string }) {
    const decision = await store.quotaDecision();
    if (decision.kind === 'block') return null;

    const tier: ModelTier = decision.kind === 'degrade' ? 'fast' : 'standard';
    const day = new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    const thread = await store.createThread(`${automation.name} · ${day}`);
    const run = await store.createRun({
      threadId: thread.id,
      prompt: automation.prompt,
      model: gateway.models[tier],
    });
    await store.appendMessage({ threadId: thread.id, role: 'user', text: automation.prompt, runId: run.id });
    await store.markAutomationRun(automation.id, new Date().toISOString());
    void drive(run, tier, decision.kind === 'degrade' ? decision.reason : null);
    return { thread, run, tier };
  }

  app.get('/v1/automations', async () => {
    const items = await store.listAutomations();
    return {
      items: items.map((item) => ({ ...item, human: describeCron(item.schedule) })),
    };
  });

  app.post('/v1/automations', async (request, reply) => {
    const parsed = createAutomationInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    if (!validateCron(parsed.data.schedule)) {
      return reply.code(400).send({ error: 'invalid_schedule', message: '定时表达式要是五段 cron：分 时 日 月 周' });
    }
    const automation = await store.createAutomation(parsed.data);
    return reply.code(201).send({ ...automation, human: describeCron(automation.schedule) });
  });

  app.patch('/v1/automations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateAutomationInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    if (parsed.data.schedule && !validateCron(parsed.data.schedule)) {
      return reply.code(400).send({ error: 'invalid_schedule', message: '定时表达式要是五段 cron：分 时 日 月 周' });
    }
    const automation = await store.updateAutomation(id, parsed.data);
    if (!automation) return reply.code(404).send({ error: 'automation_not_found', message: '自动化不存在' });
    return { ...automation, human: describeCron(automation.schedule) };
  });

  app.delete('/v1/automations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await store.deleteAutomation(id))) {
      return reply.code(404).send({ error: 'automation_not_found', message: '自动化不存在' });
    }
    return { ok: true };
  });

  /** 立即跑一次，不等 cron */
  app.post('/v1/automations/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    const automation = (await store.listAutomations()).find((item) => item.id === id);
    if (!automation) return reply.code(404).send({ error: 'automation_not_found', message: '自动化不存在' });

    const started = await runAutomation(automation);
    if (!started) return reply.code(429).send({ error: 'quota_exceeded', message: '本周次数已用完，这次自动化没有启动' });
    return reply.code(202).send({ threadId: started.thread.id, runId: started.run.id });
  });

  app.get('/v1/plugins', async () =>
    options.plugins
      ? options.plugins.info()
      : { directory: null, tools: [], errors: [], reloadedAt: null },
  );

  app.post('/v1/plugins/reload', async (_request, reply) => {
    if (!options.plugins) {
      return reply.code(400).send({ error: 'plugins_unavailable', message: '这个实例没有启用插件目录' });
    }
    return options.plugins.reload();
  });

  app.get('/v1/usage', async () => store.usage());

  app.get('/v1/settings', async () => store.getSettings());

  app.patch('/v1/settings', async (request, reply) => {
    const parsed = updateSettingsInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'invalid_request', message: '没有要改的设置项' });
    }
    return store.updateSettings(parsed.data);
  });

  app.get('/v1/threads', async () => ({ items: await store.listThreads() }));

  app.post('/v1/threads', async (request, reply) => {
    const parsed = createThreadInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    return reply.code(201).send(await store.createThread(parsed.data.title));
  });

  app.patch('/v1/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateThreadInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));

    const thread = await store.renameThread(id, parsed.data.title.trim());
    if (!thread) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });
    return thread;
  });

  app.delete('/v1/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = await store.deleteThread(id);
    if (!removed) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });
    gate.cancelRun(id, '会话已删除');
    return { ok: true };
  });

  app.get('/v1/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const thread = await store.getThread(id);
    if (!thread) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });
    const latestRun = (await store.latestRunForThread(id)) ?? null;
    return { thread, latestRun, pendingApprovals: latestRun ? gate.list(latestRun.id) : [] };
  });

  app.get('/v1/threads/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await store.getThread(id))) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });

    const parsed = messagesQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', message: 'limit / before 不合法' });

    const limit = parsed.data.limit ?? DEFAULT_MESSAGE_PAGE;
    const page = await store.pageMessages(id, { limit, beforeSeq: parsed.data.before });
    return { items: page.items, hasMore: page.hasMore };
  });

  /**
   * 接着一个已经停下的运行继续做：不重打提示词，直接在当前会话历史上再跑一轮。
   * 失败、取消、到步数上限都走这里。
   */
  app.post('/v1/runs/:id/continue', async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = await store.getRun(id);
    if (!source) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });

    if (!(TERMINAL_STATES as readonly RunState[]).includes(source.state)) {
      return reply.code(409).send({ error: 'run_active', message: '这次运行还没结束，先等它停下或取消' });
    }

    const parsed = continueRunInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));

    const decision = await store.quotaDecision();
    if (decision.kind === 'block') return reply.code(429).send({ error: 'quota_exceeded', message: decision.reason });

    const tier: ModelTier = decision.kind === 'degrade' ? 'fast' : 'standard';
    const instruction =
      parsed.data.instruction?.trim() ||
      (source.state === 'failed' ? '接着刚才的做，不要从头开始。' : '继续。');

    const run = await store.createRun({
      threadId: source.threadId,
      prompt: instruction,
      model: gateway.models[tier],
    });
    await store.appendMessage({ threadId: source.threadId, role: 'user', text: instruction, runId: run.id });
    void drive(run, tier, decision.kind === 'degrade' ? decision.reason : null);

    return reply.code(202).send({ ...run, tier, degraded: tier === 'fast', continuedFrom: source.id });
  });

  app.get('/v1/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });
    return { ...run, pendingApprovals: gate.list(id) };
  });

  app.post('/v1/runs', async (request, reply) => {
    const parsed = createRunInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));

    const thread = await store.getThread(parsed.data.threadId);
    if (!thread) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });

    const decision = await store.quotaDecision();
    if (decision.kind === 'block') {
      return reply.code(429).send({ error: 'quota_exceeded', message: decision.reason });
    }

    // 配额层面已经超了，就直接从快模型起跑，别先撞一次主模型
    const tier: ModelTier = decision.kind === 'degrade' ? 'fast' : 'standard';
    const run = await store.createRun({ threadId: thread.id, prompt: parsed.data.prompt, model: gateway.models[tier] });
    await store.appendMessage({ threadId: thread.id, role: 'user', text: parsed.data.prompt, runId: run.id });

    // 新会话用第一句话当标题，别让侧栏一堆「新对话」
    if (thread.title === '新对话') {
      const firstLine = parsed.data.prompt.split('\n').find((line) => line.trim())?.trim() ?? '新对话';
      const title = firstLine.length > 24 ? firstLine.slice(0, 24) + '…' : firstLine;
      await store.renameThread(thread.id, title);
    }

    void drive(run, tier, decision.kind === 'degrade' ? decision.reason : null);

    return reply.code(202).send({ ...run, tier, degraded: tier === 'fast' });
  });

  /** 人在界面上点「允许 / 拒绝」。只能二选一，不允许改参数。 */
  app.post('/v1/runs/:id/approvals/:callId', async (request, reply) => {
    const { id, callId } = request.params as { id: string; callId: string };
    const parsed = approvalDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));

    const decided = gate.decide(id, callId, {
      decision: parsed.data.decision,
      ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    });
    if (!decided) {
      return reply.code(409).send({
        error: 'approval_gone',
        message: '这条审批已经不在了 —— 可能已超时、已处理，或运行已结束',
      });
    }
    return { ok: true, callId, decision: parsed.data.decision };
  });

  app.post('/v1/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });
    if (['succeeded', 'failed', 'canceled'].includes(run.state)) {
      return reply.code(409).send({ error: 'already_finished', message: '这次运行已经结束了' });
    }

    canceled.add(id);
    const waiting = gate.cancelRun(id, '运行已取消，审批作废');
    controllers.get(id)?.abort();
    return { ok: true, releasedApprovals: waiting };
  });

  app.get('/v1/runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await store.getRun(id))) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // 事件 id = 该运行的第几条事件（从 1 起），断线重连靠 Last-Event-ID 只补没看过的
    const lastSeen = Number(request.headers['last-event-id'] ?? 0) || 0;
    const write = (event: RunEvent, seq: number): void => {
      reply.raw.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    reply.raw.write('retry: 3000\n\n');
    const replay = await store.eventsOf(id);
    for (const [index, event] of replay.entries()) {
      if (index + 1 > lastSeen) write(event, index + 1);
    }

    let seq = replay.length;
    const unsubscribe = store.subscribe(id, (event) => {
      seq += 1;
      write(event, seq);
    });

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    timers.add(heartbeat);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      timers.delete(heartbeat);
      unsubscribe();
    });

    return reply;
  });


  /** 系统提示：把环境事实与干活纪律一次说清，别让模型拿 Linux 路径套 Windows */
  function buildSystemPrompt(): string {
    const platformHint =
      process.platform === 'win32'
        ? 'Windows（shell 走 cmd；路径写盘符路径或相对路径，不要用 /home/xxx 这种）'
        : process.platform === 'darwin'
          ? 'macOS（shell 走 /bin/sh）'
          : 'Linux（shell 走 /bin/sh）';

    return [
      '你是 Rakko，跑在用户自己电脑上的个人 agent。用户给的是任务，不是闲聊。',
      '',
      '## 运行环境',
      `- 系统：${platformHint}`,
      `- 工作区：${workspace}`,
      '- 文件工具的路径都相对工作区，越界会被拒。',
      '- shell 的工作目录就是工作区，命令直接跑，不要再 cd 到别处。',
      '',
      '## 工具',
      '- read_file / list_dir / grep：只读，直接执行。改文件前先读一遍。',
      '- apply_patch：old 必须在文件里唯一命中，0 次或多次都会失败；失败后补上下文再试。',
      '- write_file：整文件覆盖，仅在新建文件时用。',
      '- shell：跑测试、构建、看命令输出。',
      '- http：发请求，默认不许打内网。',
      '高风险工具会停下来等用户审批；用户点过「允许这类」后不再问。',
      '',
      '## 干活纪律',
      '1. 先看清现状再动手：读文件、grep 确认位置，再改。',
      '2. 改完必须验证：跑相关测试或命令；失败就读输出找原因再改，不要靠猜。',
      '3. 没验证就不要说「完成了」。做不到就直说卡在哪一步。',
      '4. 不要假装执行过工具：只有工具结果里出现的东西才算做过。',
      '5. 探索要克制：一次 grep + 一两次 read 就该动手；连续三个只读步骤还没改动，说明该改了。',
      '',
      '## 回答',
      '- 用中文，简洁，先说结论。代码、命令、路径、标识符保持原样。',
    ].join('\n');
  }

  /** 把落库的消息还原成模型能读的历史（tool 消息必须带 toolCallId） */
  function buildHistory(items: Message[]): ChatMessage[] {
    const history: ChatMessage[] = [];
    for (const item of items) {
      const payload = item.payload ?? {};
      if (item.kind === 'text' && item.role === 'user') {
        history.push({ role: 'user', content: item.text });
      } else if (item.kind === 'text' && item.role === 'assistant') {
        history.push({ role: 'assistant', content: item.text });
      } else if (item.kind === 'tool_call') {
        const call = {
          id: String(payload.callId ?? ''),
          name: String(payload.name ?? ''),
          args: (payload.args as Record<string, unknown>) ?? {},
        };
        const last = history.at(-1);
        if (last && last.role === 'assistant' && last.toolCalls) last.toolCalls.push(call);
        else history.push({ role: 'assistant', content: '', toolCalls: [call] });
      } else if (item.kind === 'tool_result') {
        history.push({
          role: 'tool',
          toolCallId: String(payload.callId ?? ''),
          name: String(payload.name ?? ''),
          content: JSON.stringify({ ok: payload.ok, output: payload.output }),
        });
      }
      // approval / approval_decision / notice 不是模型上下文
    }
    return history;
  }

  /**
   * 一次运行的实际执行：流、工具、审批、落库都在这里。
   * drive() 从一句新指令开始；resumeRun() 从库里的历史 + 一个还挂着的审批继续。
   */
  async function executeRun(
    run: Run,
    tier: ModelTier,
    messages: ChatMessage[],
    pending: PendingCall | null,
    notice: string | null,
  ): Promise<void> {
    const at = (): string => new Date().toISOString();
    const emit = (event: RunEvent): Promise<void> => store.publish(event);
    const controller = new AbortController();
    controllers.set(run.id, controller);

    // 挂载的技能可以收窄工具集：声明了 tools 的技能取交集
    const policy = await resolveToolPolicy();
    const allowTool = policy.allowTool;
    if (policy.restricted) {
      const note = ['', '## 本次可用的工具', `只允许：${policy.restricted.join('、')}（由挂载的技能限制）`].join('\n');
      const first = messages[0];
      if (first && first.role === 'system') messages[0] = { ...first, content: first.content + note };
    }

    const finish = async (state: RunState, error?: string): Promise<void> => {
      await flushSegment();
      // 成功/取消都要把 error 清空：否则中途被误标过错的运行会一直挂着旧错误
      await store.patchRun(run.id, { state, finishedAt: at(), error: error ?? null });
      await emit({ type: 'run.state', runId: run.id, at: at(), state });
      await emit({ type: 'run.done', runId: run.id, at: at(), state });
    };

    /**
     * 助手文字是分成「段」落库的：遇到工具卡、审批、提示就封口。
     * 这样重开会话时，卡片还能待在该待的位置；失败时也不会丢掉已经说出口的话。
     */
    let segment = '';
    const flushSegment = async (): Promise<void> => {
      const text = segment;
      segment = '';
      if (!text.trim()) return;
      await store.appendMessage({ threadId: run.threadId, role: 'assistant', kind: 'text', text, runId: run.id });
    };
    const record = async (
      kind: 'tool_call' | 'tool_result' | 'approval' | 'approval_decision' | 'notice',
      role: 'assistant' | 'tool' | 'system',
      payload: Record<string, unknown>,
      text = '',
    ): Promise<void> => {
      await store.appendMessage({ threadId: run.threadId, role, kind, text, payload, runId: run.id });
    };

    const hooks: AgentHooks = {
      onChunk: async (chunk) => {
        if (chunk.kind === 'delta') {
          segment += chunk.text;
          await emit({ type: 'run.delta', runId: run.id, at: at(), text: chunk.text });
        } else if (chunk.kind === 'reasoning') {
          await emit({ type: 'run.reasoning', runId: run.id, at: at(), text: chunk.text });
        } else if (chunk.kind === 'fallback') {
          await store.patchRun(run.id, { model: gateway.models[chunk.to] });
          await flushSegment();
          await record(
            'notice',
            'system',
            { reason: 'fallback', detail: chunk.reason, from: chunk.from, to: chunk.to },
            chunk.reason,
          );
          await emit({
            type: 'run.fallback',
            runId: run.id,
            at: at(),
            from: chunk.from,
            to: chunk.to,
            reason: chunk.reason,
          });
        }
      },

      onToolCall: async (call) => {
        await flushSegment();
        await record('tool_call', 'assistant', { callId: call.id, name: call.name, args: call.args });
        await emit({
          type: 'run.tool_call',
          runId: run.id,
          at: at(),
          callId: call.id,
          name: call.name,
          args: call.args,
        });
      },

      onToolResult: async (call, result) => {
        await record('tool_result', 'tool', {
          callId: call.id,
          name: call.name,
          ok: result.ok,
          output: result.output,
          durationMs: result.durationMs,
        });
        await emit({
          type: 'run.tool_result',
          runId: run.id,
          at: at(),
          callId: call.id,
          ok: result.ok,
          output: result.output,
        });
      },

      isGranted: (toolName: string): boolean => grants.has(toolName),

      approve: async (call, tool) => {
        await flushSegment();
        await store.patchRun(run.id, { state: 'waiting_approval' });
        await record('approval', 'system', {
          callId: call.id,
          name: call.name,
          risk: tool.risk,
          args: call.args,
        });
        await emit({
          type: 'run.approval_requested',
          runId: run.id,
          at: at(),
          callId: call.id,
          name: call.name,
          risk: tool.risk,
          args: call.args,
        });

        const decision = await gate.request({
          runId: run.id,
          callId: call.id,
          name: call.name,
          risk: tool.risk,
          args: call.args,
        });

        await record('approval_decision', 'system', {
          callId: call.id,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
        await emit({
          type: 'run.approval_decided',
          runId: run.id,
          at: at(),
          callId: call.id,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });

        // 「允许这类」：记进设置，之后这个工具不再问
        if (decision.decision === 'allow' && decision.scope === 'always') {
          grants.add(call.name);
          await store.updateSettings({ approvedTools: [...grants] });
          await record('notice', 'system', { reason: 'grant', tool: call.name }, `已允许「${call.name}」这类调用，之后不再询问`);
        }

        if (!canceled.has(run.id)) await store.patchRun(run.id, { state: 'running' });
        return { decision: decision.decision, ...(decision.scope ? { scope: decision.scope } : {}) };
      },
    };

    try {
      if (notice) {
        await record('notice', 'system', { reason: 'quota', detail: notice, from: 'standard', to: 'fast' }, notice);
        await emit({ type: 'run.fallback', runId: run.id, at: at(), from: 'standard', to: 'fast', reason: notice });
      }

      if (pending) {
        // 重启后接着等同一个审批：不重新发 approval_requested，历史里已经有了
        const decision = await gate.request({
          runId: run.id,
          callId: pending.callId,
          name: pending.name,
          risk: pending.risk,
          args: pending.args,
        });
        await record('approval_decision', 'system', {
          callId: pending.callId,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
        await emit({
          type: 'run.approval_decided',
          runId: run.id,
          at: at(),
          callId: pending.callId,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });

        const tool = tools.get(pending.name);
        await store.patchRun(run.id, { state: 'running' });
        if (decision.decision === 'allow' && decision.scope === 'always') {
          grants.add(pending.name);
          await store.updateSettings({ approvedTools: [...grants] });
        }

        const result = tool
          ? await tools.execute(
              { id: pending.callId, name: pending.name, args: pending.args },
              {
                approve: async () => ({ decision: decision.decision, ...(decision.scope ? { scope: decision.scope } : {}) }),
                isGranted: (toolName: string) => grants.has(toolName),
              },
            )
          : { ok: false, output: `没有名为 ${pending.name} 的工具`, durationMs: 0 };

        await record('tool_result', 'tool', {
          callId: pending.callId,
          name: pending.name,
          ok: result.ok,
          output: result.output,
          durationMs: result.durationMs,
        });
        await emit({
          type: 'run.tool_result',
          runId: run.id,
          at: at(),
          callId: pending.callId,
          ok: result.ok,
          output: result.output,
        });

        messages.push({
          role: 'tool',
          toolCallId: pending.callId,
          name: pending.name,
          content: JSON.stringify(result),
        });
      }

      const outcome = await loop.run(
        { runId: run.id, tier, messages, signal: controller.signal, ...(allowTool ? { allowTool } : {}) },
        hooks,
      );

      if (canceled.has(run.id)) {
        await finish('canceled');
        return;
      }
      if (outcome.stopped === 'max_steps') {
        const reason = `到步数上限（${outcome.steps} 轮）先停一下，任务没做完`;
        await emit({ type: 'run.delta', runId: run.id, at: at(), text: `（${reason}）\n` });
        await store.chargeRun(run);
        await finish('failed', reason);
        return;
      }

      await store.chargeRun(run);
      await finish('succeeded');

      // 记忆自动提取：失败静默，绝不回写运行状态
      void suggestMemories(run).catch(() => {});
    } catch (error) {
      if (canceled.has(run.id) || controller.signal.aborted) {
        await finish('canceled');
        return;
      }
      const message = error instanceof Error ? error.message : '未知错误';
      await emit({ type: 'run.error', runId: run.id, at: at(), message });
      await finish('failed', message);
    } finally {
      controllers.delete(run.id);
      canceled.delete(run.id);
    }
  }

  async function drive(run: Run, tier: ModelTier, notice: string | null): Promise<void> {
    const at = (): string => new Date().toISOString();
    await store.patchRun(run.id, { state: 'running' });
    await store.publish({ type: 'run.started', runId: run.id, at: at() });
    await store.publish({ type: 'run.state', runId: run.id, at: at(), state: 'running' });

    // 会话历史只取最近一段（trimHistory 还要再收一次）；长会话不必整条读进内存
    const recent = await store.pageMessages(run.threadId, { limit: 200 });
    const history = trimHistory(buildHistory(recent.items));
    const systemPrompt = buildSystemPrompt() + (await buildSkillSection()) + (await buildMemorySection(run.prompt));
    await executeRun(run, tier, [{ role: 'system', content: systemPrompt }, ...history], null, notice);
  }

  /** 运行成功后挑几条记忆候选，写进 pending 等用户确认 */
  const extracting = new Set<string>();
  async function suggestMemories(run: Run): Promise<void> {
    if (extracting.has(run.id)) return;
    const settings = await store.getSettings();
    if (settings.autoExtractMemory === false) return;

    extracting.add(run.id);
    try {
      const items = (await store.pageMessages(run.threadId, { limit: 40 })).items;
      const messages = buildHistory(items);
      const existing = await store.listMemories();
      const candidates = await extractMemories({
        gateway,
        messages,
        existingTitles: existing.map((memory) => memory.title),
        model: gateway.models.fast,
      });

      for (const candidate of candidates) {
        const memory = await store.createMemory({
          kind: candidate.kind,
          title: candidate.title,
          description: candidate.description ?? '',
          body: candidate.body,
          status: 'pending',
          embedding: await embedFor(candidate.title, candidate.body),
        });

        const triples = (candidate.relations ?? [])
          .filter((relation) => relation.from && relation.to)
          .map((relation) => ({
            from: relation.from,
            to: relation.to,
            relation: relation.relation,
            fromKind: candidate.entities?.find((entity) => entity.name === relation.from)?.kind ?? 'concept',
            toKind: candidate.entities?.find((entity) => entity.name === relation.to)?.kind ?? 'concept',
          }));
        if (triples.length > 0) await store.saveTriples(memory.id, triples);
      }
      if (candidates.length > 0) console.log(`记忆候选：${candidates.length} 条待确认`);
    } finally {
      extracting.delete(run.id);
    }
  }

  /** 挂载的技能若声明了 tools，就取交集；restricted 为 null 表示不限制 */
  async function resolveToolPolicy(): Promise<{ allowTool?: (name: string) => boolean; restricted: string[] | null }> {
    const [allSkills, settings] = await Promise.all([store.listSkills(), store.getSettings()]);
    const restricting = allSkills
      .filter((skill) => settings.enabledSkills.includes(skill.slug) && skill.tools.length > 0)
      .map((skill) => new Set(skill.tools));
    if (restricting.length === 0) return { restricted: null };

    const allowed = new Set(restricting[0]);
    for (const set of restricting.slice(1)) {
      for (const name of [...allowed]) if (!set.has(name)) allowed.delete(name);
    }
    return { allowTool: (name: string) => allowed.has(name), restricted: [...allowed] };
  }

  /** 把挂载中的技能拼成系统提示的一段：最多 3 个、每个 1500 字 */
  async function buildSkillSection(): Promise<string> {
    const [items, settings] = await Promise.all([store.listSkills(), store.getSettings()]);
    const enabled = new Set(settings.enabledSkills);
    const active = items.filter((item) => enabled.has(item.slug)).slice(0, 3);
    if (active.length === 0) return '';

    const blocks = active.map((skill) => {
      const body = skill.body.length > 1500 ? `${skill.body.slice(0, 1500)}…` : skill.body;
      return `### ${skill.name}\n${body}`;
    });

    return ['', '## 已挂载的技能（按它们做事）', ...blocks].join('\n');
  }

  /** 把与本次任务最相关的记忆拼进系统提示：优先语义检索，拿不到向量就退回关键词 */
  async function buildMemorySection(query: string): Promise<string> {
    let embedding: number[] | null = null;
    if (options.embeddings) {
      try {
        const [vector] = await options.embeddings.embed([query.slice(0, 2000)]);
        embedding = vector ?? null;
      } catch {
        embedding = null; // 检索失败就退回关键词，不影响运行
      }
    }

    const minScore = Number(process.env.RAKKO_MEMORY_MIN_SCORE ?? 0.25);
    const direct = await store.searchMemories({ query, embedding, limit: 8, minScore: Number.isFinite(minScore) ? minScore : 0.25 });
    if (direct.length === 0) return '';

    // 图谱扩展：沿实体关系再捞一跳，补上语义没召回但相关的记忆
    const directIds = new Set(direct.map((memory) => memory.id));
    const related = await store.expandFromMemories([...directIds], 4).catch(() => []);
    const items = [...direct, ...related.filter((memory) => !directIds.has(memory.id))];

    const lines = items.slice(0, 20).map((memory) => {
      const body = memory.body.replace(/\s+/g, ' ').slice(0, 200);
      const note = memory.description ? `（${memory.description}）` : '';
      const linked = directIds.has(memory.id) ? '' : '（关联记忆）';
      return `- [${memory.kind}]${linked} ${memory.title}${note}：${body}`;
    });

    return ['', '## 用户的记忆（跨会话）', ...lines, '这些是长期有效的偏好与背景，默认按它们行事；和当前指令冲突时以当前指令为准。'].join('\n');
  }

  /**
   * 历史不能无限长：留最近 40 条 / 8 万字符。
   * 从后往前留；开头如果剩下孤儿 tool 结果就丢掉（它引用的 tool_call 已经被裁掉了）。
   */
  function trimHistory(history: ChatMessage[], maxItems = 40, maxChars = 80_000): ChatMessage[] {
    let items = history.length > maxItems ? history.slice(-maxItems) : history;

    let chars = 0;
    const kept: ChatMessage[] = [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item) continue;
      chars += item.content.length;
      if (chars > maxChars && kept.length > 0) break;
      kept.unshift(item);
    }

    while (kept[0]?.role === 'tool') kept.shift();
    return kept;
  }

  /** 恢复运行时拿不到 run.prompt 的上下文，用历史里最后一条用户消息当检索词 */
  const lastUserText = (items: Message[]): string =>
    [...items].reverse().find((item) => item.role === 'user' && item.kind === 'text')?.text ?? '';

  /** 重启后恢复：拿库里的历史 + 还挂着的审批，接着跑 */
  async function resumeRun(run: Run, pending: PendingCall | null): Promise<void> {
    const items = (await store.pageMessages(run.threadId, { limit: 200 })).items;
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          buildSystemPrompt() +
          (await buildSkillSection()) +
          (await buildMemorySection(lastUserText(items))),
      },
      ...buildHistory(items),
    ];
    const tier: ModelTier = run.model === gateway.models.fast ? 'fast' : 'standard';
    await executeRun(run, tier, messages, pending, null);
  }

  app.addHook('onReady', async () => {
    // 每 30 秒看一眼有没有该跑的；selectDue 保证同一分钟只触发一次
    const interval = setInterval(() => {
      void (async () => {
        try {
          const due = selectDue(await store.listAutomations(), new Date());
          for (const automation of due) await runAutomation(automation);
        } catch (error) {
          console.error('自动化触发失败：', error);
        }
      })();
    }, options.automationIntervalMs ?? 30_000);
    interval.unref?.();
    automationTimer = interval;

    const settings = await store.getSettings();
    for (const name of settings.approvedTools) grants.add(name);

    const resumable = await store.resumableRuns();
    for (const item of resumable) {
      void resumeRun(item.run, item.pending).catch((error: unknown) => {
        console.error('恢复运行失败：', error);
      });
    }
    if (resumable.length > 0) console.log(`恢复 ${resumable.length} 个等待审批的运行`);
  });

  app.addHook('onClose', async () => {
    if (automationTimer) clearInterval(automationTimer);
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    gate.cancelAll();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });

  return app;
}
