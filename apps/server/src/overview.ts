import type { RunState } from '@rakko/protocol';

/**
 * 运行概览：跨运行看，而不是一次一次点开。
 *
 * 单次运行看的是「这次为什么失败」；概览看的是「最近总在哪儿失败」——
 * 成功率、耗时分位、哪个工具最容易挂。
 */

export interface RunOverviewRow {
  id: string;
  threadId: string;
  threadTitle: string;
  source: 'chat' | 'automation' | 'continue';
  state: RunState;
  model: string;
  prompt: string;
  createdAt: string;
  /** 还没结束的运行算到「现在」 */
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  fallbacks: number;
  approvals: number;
  error: string | null;
}

export interface ToolTally {
  name: string;
  calls: number;
  failures: number;
}

export interface RunsOverview {
  items: RunOverviewRow[];
  stats: {
    total: number;
    succeeded: number;
    failed: number;
    canceled: number;
    /** 0–100 的整数百分比；没有已结束的运行就是 null */
    successRate: number | null;
    /** 已结束运行的耗时分位；样本不足就给 null */
    p50Ms: number | null;
    p90Ms: number | null;
    topTools: ToolTally[];
  };
}

const TERMINAL = new Set<RunState>(['succeeded', 'failed', 'canceled']);

/** 分位数：线性插值，样本少也不会算出离谱值 */
export function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const from = sorted[lower] ?? 0;
  const to = sorted[upper] ?? from;
  return Math.round(from + (to - from) * (position - lower));
}

export function buildOverview(items: RunOverviewRow[], topTools: ToolTally[]): RunsOverview {
  const finished = items.filter((row) => TERMINAL.has(row.state));
  const succeeded = finished.filter((row) => row.state === 'succeeded').length;
  const failed = finished.filter((row) => row.state === 'failed').length;
  const canceled = finished.filter((row) => row.state === 'canceled').length;
  const durations = finished.map((row) => row.durationMs);

  return {
    items,
    stats: {
      total: items.length,
      succeeded,
      failed,
      canceled,
      successRate: finished.length === 0 ? null : Math.round((succeeded / finished.length) * 100),
      p50Ms: percentile(durations, 0.5),
      p90Ms: percentile(durations, 0.9),
      topTools,
    },
  };
}
