import { useState } from "react";
import type { PermissionDecision, PermissionRequest } from "@rakko/shared";

interface Props {
  request: PermissionRequest;
  /** 正在提交（按钮禁用，防重复点） */
  pending: boolean;
  onDecide: (decision: PermissionDecision) => void;
}

const RISK_LABEL: Record<string, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

/**
 * 审批卡。
 *
 * 设计约束：
 * - 必须能看清「要执行什么」—— 命令原文或文件路径，不能只给摘要
 * - 三个按钮，语义要区分：这次 / 这类 / 拒绝
 * - 决定后立即禁用全部按钮，防止重复提交
 * - 控制面写入（改应用配置）要显式警告，这类即使完全访问也该问
 */
export function PermissionCard({ request, pending, onDecide }: Props) {
  const [decided, setDecided] = useState<PermissionDecision | null>(null);
  const disabled = pending || decided !== null;

  const decide = (d: PermissionDecision) => {
    if (disabled) return;
    setDecided(d);
    onDecide(d);
  };

  return (
    <div className={`perm-card ${request.controlPlane ? "control-plane" : ""}`}>
      <div className="perm-head">
        <span className="perm-title">需要你的确认</span>
        <span className={`perm-risk ${request.risk}`}>{RISK_LABEL[request.risk] ?? request.risk}</span>
        {request.controlPlane && <span className="perm-cp">应用配置</span>}
      </div>

      <div className="perm-tool">
        <span className="mono">{request.toolName}</span>
      </div>

      <pre className="perm-body">{request.summary}</pre>

      {request.controlPlane && (
        <p className="perm-note">
          这次写入会改到 Rakko 自己的配置目录。模型若能改这里，就能把请求转发到别处，
          所以即使在完全访问档也要确认。
        </p>
      )}

      <div className="perm-actions">
        <button className="pbtn primary" disabled={disabled} onClick={() => decide("allow-once")}>
          允许这次
        </button>
        <button className="pbtn" disabled={disabled} onClick={() => decide("allow-type")}>
          允许这类
        </button>
        <button className="pbtn danger" disabled={disabled} onClick={() => decide("deny")}>
          拒绝
        </button>
        {decided && <span className="perm-done">已{decided === "deny" ? "拒绝" : "允许"}</span>}
      </div>
    </div>
  );
}
