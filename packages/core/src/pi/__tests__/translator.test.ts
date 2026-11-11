import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@rakko/shared";
import { PiTranslator, classifyToolRisk } from "../translator.js";
import type { PiRawEvent } from "../translator.js";

function collect(): { events: AgentEvent[]; t: PiTranslator } {
  const events: AgentEvent[] = [];
  const t = new PiTranslator((e) => events.push(e));
  return { events, t };
}

/** 实测到的真实事件样本（pi 1.4.0） */
const REAL = {
  agentStart: { type: "agent_start" },
  turnStart: { type: "turn_start" },
  textDelta: {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "你好", contentIndex: 0 },
  },
  thinkingDelta: {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "思考中", contentIndex: 0 },
  },
  toolStart: {
    type: "tool_execution_start",
    toolCallId: "call_abc",
    toolName: "ls",
    args: { path: "." },
  },
  toolEnd: {
    type: "tool_execution_end",
    toolCallId: "call_abc",
    toolName: "ls",
    result: { content: [{ type: "text", text: "a.txt\nb.txt" }] },
    isError: false,
    durationMs: 2,
  },
  turnEnd: {
    type: "turn_end",
    message: {
      role: "assistant",
      usage: { input: 10, output: 6, cacheRead: 2, cacheWrite: 1 },
    },
  },
  settled: { type: "agent_settled", aborted: false },
} satisfies Record<string, PiRawEvent>;

describe("translator —— 实测事件映射", () => {
  it("agent_start 产生 turn_start，并生成 turnId", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "turn_start" });
    expect(t.turnId).toBeTruthy();
  });

  it("turn_start 不重复建轮次", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle(REAL.turnStart);
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
  });

  it("text_delta 映射正确", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle(REAL.textDelta);
    const delta = events.find((e) => e.type === "text_delta");
    expect(delta).toMatchObject({ type: "text_delta", text: "你好" });
  });

  it("thinking_delta 映射正确，且不混进正文", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle(REAL.thinkingDelta);
    const thinking = events.find((e) => e.type === "thinking_delta");
    expect(thinking).toMatchObject({ type: "thinking_delta", text: "思考中" });
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
  });

  it("空 delta 不产生事件", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } });
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(0);
  });

  it("工具开始/结束映射，结果压成纯文本", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle(REAL.toolStart);
    t.handle(REAL.toolEnd);

    const start = events.find((e) => e.type === "tool_start");
    expect(start).toMatchObject({
      type: "tool_start",
      tool: { id: "call_abc", name: "ls", risk: "low" },
    });

    const end = events.find((e) => e.type === "tool_end");
    expect(end).toMatchObject({
      type: "tool_end",
      callId: "call_abc",
      result: "a.txt\nb.txt",
      isError: false,
      durationMs: 2,
    });
  });

  it("工具失败时 isError 为 true", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle({ ...REAL.toolEnd, isError: true });
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ isError: true });
  });

  it("turn_end 的 usage 被提取（四字段齐全）", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle(REAL.turnEnd);
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 1 },
    });
  });

  it("agent_settled 收口为 turn_end done", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle(REAL.settled);
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ type: "turn_end", reason: "done" });
    expect(t.turnId).toBeNull();
  });

  it("aborted 的 agent_settled 归为 aborted", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle({ type: "agent_settled", aborted: true });
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ reason: "aborted" });
  });

  it("没有轮次时收到事件不崩、不产生杂音", () => {
    const { events, t } = collect();
    expect(() => t.handle(REAL.textDelta)).not.toThrow();
    expect(() => t.handle(REAL.toolStart)).not.toThrow();
    expect(events).toHaveLength(0);
  });

  it("response 事件不产生 UI 事件", () => {
    const { events, t } = collect();
    t.handle({ type: "response", id: "r1", success: true });
    expect(events).toHaveLength(0);
  });

  it("连续两轮各自独立", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.handle(REAL.settled);
    t.handle(REAL.agentStart);
    t.handle(REAL.settled);

    const turns = events.filter((e) => e.type === "turn_start") as Array<{ turnId: string }>;
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnId).not.toBe(turns[1]!.turnId);
  });

  it("abortTurn 主动收口", () => {
    const { events, t } = collect();
    t.handle(REAL.agentStart);
    t.abortTurn();
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ reason: "aborted" });
    expect(t.turnId).toBeNull();
  });
});

describe("classifyToolRisk —— 拿不准就标 high", () => {
  it("只读工具是 low", () => {
    for (const t of ["read", "ls", "grep", "find", "glob", "READ"]) {
      expect(classifyToolRisk(t)).toBe("low");
    }
  });

  it("写文件是 high", () => {
    for (const t of ["write", "edit", "apply_patch", "patch"]) {
      expect(classifyToolRisk(t)).toBe("high");
    }
  });

  it("执行命令是 high", () => {
    for (const t of ["bash", "shell", "powershell", "exec", "run"]) {
      expect(classifyToolRisk(t)).toBe("high");
    }
  });

  it("未知工具默认 high，不是 low", () => {
    expect(classifyToolRisk("some_unknown_tool")).toBe("high");
    expect(classifyToolRisk("")).toBe("high");
  });
});
