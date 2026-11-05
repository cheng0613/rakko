/**
 * 自动化的定时判断。
 *
 * 只支持标准五段 cron：分 时 日 月 周。
 * 每段可以是 `*`、`a`、`a-b`、`* /n`、`a,b`（含组合）。够用了 ——
 * 真的上生产该换成成熟的 cron 库，这里先把手感做对。
 */

export interface CronFields {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const RANGES: Record<number, [number, number]> = {
  0: [0, 59],
  1: [0, 23],
  2: [1, 31],
  3: [1, 12],
  4: [0, 6],
};

/** 单段匹配；支持 `*`、`* /n`、`a-b`、`a-b/n`、`a` 和逗号组合 */
function matchField(expression: string, value: number, index: number): boolean {
  const [min, max] = RANGES[index] ?? [0, 0];

  return expression.split(',').some((piece) => {
    const [rangeRaw, stepRaw] = piece.includes('/') ? piece.split('/') : [piece, '1'];
    const range = rangeRaw ?? '';
    const step = Number(stepRaw ?? '1');
    if (!Number.isFinite(step) || step <= 0) return false;

    if (range === '*' || range === '?') {
      return (value - min) % step === 0;
    }

    if (range.includes('-')) {
      const [fromText, toText] = range.split('-');
      const from = Number(fromText ?? '');
      const to = Number(toText ?? '');
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
      return value >= from && value <= to && (value - from) % step === 0;
    }

    const exact = Number(range);
    return Number.isFinite(exact) && value === exact;
  });
}

export function cronMatches(expression: string, at: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const fields: CronFields = {
    minute: at.getMinutes(),
    hour: at.getHours(),
    day: at.getDate(),
    month: at.getMonth() + 1,
    weekday: at.getDay(),
  };

  return (
    matchField(parts[0] ?? '', fields.minute, 0) &&
    matchField(parts[1] ?? '', fields.hour, 1) &&
    matchField(parts[2] ?? '', fields.day, 2) &&
    matchField(parts[3] ?? '', fields.month, 3) &&
    matchField(parts[4] ?? '', fields.weekday, 4)
  );
}

/** 把常见表达式翻译成人话，界面直接用 */
export function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];

  const pad = (value: string): string => (value.length === 1 ? `0${value}` : value);
  const isTime = /^\d+$/.test(minute) && /^\d+$/.test(hour);
  const time = `${pad(hour)}:${pad(minute)}`;

  if (/^\*\/\d+$/.test(minute) && hour === '*') {
    return `每 ${minute.slice(2)} 分钟`;
  }
  if (/^\d+$/.test(minute) && /^\*\/\d+$/.test(hour)) {
    return `每 ${hour.slice(2)} 小时的第 ${minute} 分`;
  }
  if (isTime && day === '*' && month === '*' && weekday === '*') return `每天 ${time}`;
  if (isTime && weekday !== '*') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const index = Number(weekday);
    return `每${names[index] ?? weekday} ${time}`;
  }
  if (isTime && day !== '*' && weekday === '*') return `每月 ${day} 日 ${time}`;
  return expression;
}

export interface DueAutomation {
  id: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
}

/**
 * 挑出这一分钟该跑的：启用、表达式命中、且这一分钟还没跑过。
 * 55 秒窗口是为了容忍 tick 抖动，又不会同一分钟内重复触发。
 */
export function selectDue<T extends DueAutomation>(automations: T[], now: Date): T[] {
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;

  return automations.filter((automation) => {
    if (!automation.enabled) return false;
    if (!cronMatches(automation.schedule, now)) return false;
    if (!automation.lastRunAt) return true;
    const last = new Date(automation.lastRunAt).getTime();
    return !Number.isFinite(last) || last < minuteStart - 5_000;
  });
}

/** 校验表达式本身（不看具体时间）：五段、每段形状对、数值在范围内 */
export function validateCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  return parts.every((field, index) => {
    const [min, max] = RANGES[index] ?? [0, 0];
    return field.split(',').every((piece) => {
      const [rangeRaw, stepRaw] = piece.includes('/') ? piece.split('/') : [piece, '1'];
      const range = rangeRaw ?? '';
      const step = Number(stepRaw ?? '1');
      if (!Number.isFinite(step) || step <= 0) return false;
      if (range === '*' || range === '?') return true;

      if (range.includes('-')) {
        const [fromText, toText] = range.split('-');
        const from = Number(fromText ?? '');
        const to = Number(toText ?? '');
        return Number.isInteger(from) && Number.isInteger(to) && from >= min && to <= max && from <= to;
      }

      const exact = Number(range);
      return Number.isInteger(exact) && exact >= min && exact <= max;
    });
  });
}
