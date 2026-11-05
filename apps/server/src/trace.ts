import type { Run, RunEvent } from '@rakko/protocol';

/**
 * 一次运行的「体检报告」。
 *
 * 排查失败时人想知道的是：跑了多久、第一步多久出字、调了哪些工具、
 * 哪个工具挂了、有没有降级、审批被拒过几次、报了什么错。
 * 这些都在 run_events 里，但那是流水账；这里把它们折成几行能一眼看完的数字。
 */

export interface TraceToolStat {
  name: string;
  calls: number;
  failures: number;
  /** 从发起到拿到结果的总耗时（含审批等待） */
  ms: number;
}

export interface TraceSummary {
  state: Run['state'];
  model: string;
  durationMs: number;
  /** 从开始跑到第一个字吐出来（回答正文）；没有输出就是 null */
  firstTokenMs: number | null;
  /** 第一个「有动静」的时刻：思考或正文，先到哪个算哪个 */
  firstOutputMs: number | null;
  toolCalls: number;
  toolFailures: number;
  fallbacks: number;
  approvals: number;
  denials: number;
  errors: string[];
  tools: TraceToolStat[];
}

const ms = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from));

export function summarizeTrace(run: Run, events: RunEvent[]): TraceSummary {
  const startedAt = events[0]?.at ?? run.createdAt;
  const endedAt = events.at(-1)?.at ?? run.finishedAt ?? startedAt;

  const tools = new Map<string, TraceToolStat>();
  const pending = new Map<string, { name: string; at: string }>();
  let firstTokenMs: number | null = null;
  let firstOutputMs: number | null = null;
  let fallbacks = 0;
  let approvals = 0;
  let denials = 0;
  const errors: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'run.delta': {
        if (firstTokenMs === null && event.text) firstTokenMs = ms(startedAt, event.at);
        if (firstOutputMs === null) firstOutputMs = ms(startedAt, event.at);
        break;
      }
      case 'run.reasoning': {
        if (firstOutputMs === null) firstOutputMs = ms(startedAt, event.at);
        break;
      }
      case 'run.fallback': {
        fallbacks += 1;
        break;
      }
      case 'run.tool_call': {
        pending.set(event.callId, { name: event.name, at: event.at });
        const stat = tools.get(event.name) ?? { name: event.name, calls: 0, failures: 0, ms: 0 };
        stat.calls += 1;
        tools.set(event.name, stat);
        break;
      }
      case 'run.tool_result': {
        const call = pending.get(event.callId);
        if (!call) break;
        pending.delete(event.callId);
        const stat = tools.get(call.name);
        if (!stat) break;
        stat.ms += ms(call.at, event.at);
        if (!event.ok) stat.failures += 1;
        break;
      }
      case 'run.approval_requested': {
        approvals += 1;
        break;
      }
      case 'run.approval_decided': {
        if (event.decision === 'deny') denials += 1;
        break;
      }
      case 'run.error': {
        errors.push(event.message);
        break;
      }
      default:
        break;
    }
  }

  // 悬着的工具调用（进程死在半路）也算一次失败，否则统计会好看得可疑
  for (const call of pending.values()) {
    const stat = tools.get(call.name);
    if (!stat) continue;
    stat.failures += 1;
    stat.ms += ms(call.at, endedAt);
  }

  const toolStats = [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const toolCalls = toolStats.reduce((sum, stat) => sum + stat.calls, 0);
  const toolFailures = toolStats.reduce((sum, stat) => sum + stat.failures, 0);

  if (run.error && !errors.includes(run.error)) errors.push(run.error);

  return {
    state: run.state,
    model: run.model,
    durationMs: ms(startedAt, endedAt),
    firstTokenMs,
    firstOutputMs,
    toolCalls,
    toolFailures,
    fallbacks,
    approvals,
    denials,
    errors,
    tools: toolStats,
  };
}
