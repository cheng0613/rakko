import { describe, expect, it } from "vitest";
import { formatRelative } from "../use-home-data.js";

/** 固定基准时间，避免测试依赖真实时钟 */
const NOW = new Date("2026-11-11T12:00:00Z").getTime();

function ago(ms: number): number {
  return NOW - ms;
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelative", () => {
  it("不到 1 分钟显示「刚刚」", () => {
    expect(formatRelative(ago(0), NOW)).toBe("刚刚");
    expect(formatRelative(ago(30 * SEC), NOW)).toBe("刚刚");
    expect(formatRelative(ago(59 * SEC), NOW)).toBe("刚刚");
  });

  it("分钟级", () => {
    expect(formatRelative(ago(1 * MIN), NOW)).toBe("1 分钟前");
    expect(formatRelative(ago(23 * MIN), NOW)).toBe("23 分钟前");
    expect(formatRelative(ago(59 * MIN), NOW)).toBe("59 分钟前");
  });

  it("小时级", () => {
    expect(formatRelative(ago(1 * HOUR), NOW)).toBe("1 小时前");
    expect(formatRelative(ago(23 * HOUR), NOW)).toBe("23 小时前");
  });

  it("1 天显示「昨天」", () => {
    expect(formatRelative(ago(24 * HOUR), NOW)).toBe("昨天");
    expect(formatRelative(ago(47 * HOUR), NOW)).toBe("昨天");
  });

  it("多天显示「N 天前」", () => {
    expect(formatRelative(ago(2 * DAY), NOW)).toBe("2 天前");
    expect(formatRelative(ago(29 * DAY), NOW)).toBe("29 天前");
  });

  it("超过 30 天显示日期", () => {
    const r = formatRelative(ago(40 * DAY), NOW);
    // 只验证长得像日期，不卡具体格式（依赖 locale）
    expect(r).toMatch(/\d/);
    expect(r).not.toContain("天前");
  });

  it("未来时间不会显示负数", () => {
    // 时钟偏移时可能出现，不能让界面显示「-5 分钟前」
    expect(formatRelative(NOW + 10 * MIN, NOW)).toBe("刚刚");
    expect(formatRelative(NOW + 5 * DAY, NOW)).not.toContain("-");
  });
});
