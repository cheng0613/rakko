/**
 * 生成式 UI 的白名单与校验。
 *
 * 模型只能吐这 12 个组件，其余一律拒绝 —— 这是「生成式」不等于「任意 HTML」的边界。
 * 校验发生在服务端，客户端二次校验；两边共用这一份 spec。
 */

import type { Parsed } from '@rakko/protocol';

export type PropType = 'string' | 'number' | 'boolean' | 'json' | 'string[]';

export interface ComponentSpec {
  /** 允许的属性；出现未声明的属性即判为不合法 */
  props: Record<string, PropType>;
  required: string[];
  /** 是否允许子节点 */
  children: boolean;
}

/** 12 个组件：够表达绝大多数回答，也小到能穷举测完。 */
export const COMPONENTS = [
  'text',
  'markdown',
  'stack',
  'row',
  'card',
  'list',
  'table',
  'chart',
  'form',
  'button',
  'code',
  'callout',
] as const;

export type ComponentName = (typeof COMPONENTS)[number];

export const SPECS: Record<ComponentName, ComponentSpec> = {
  text: { props: { text: 'string' }, required: ['text'], children: false },
  markdown: { props: { text: 'string' }, required: ['text'], children: false },
  stack: { props: { gap: 'number', align: 'string' }, required: [], children: true },
  row: { props: { gap: 'number', wrap: 'boolean' }, required: [], children: true },
  card: { props: { title: 'string', tone: 'string' }, required: [], children: true },
  list: { props: { ordered: 'boolean' }, required: [], children: true },
  table: { props: { columns: 'string[]', rows: 'json', caption: 'string' }, required: ['columns', 'rows'], children: false },
  chart: { props: { variant: 'string', data: 'json', label: 'string' }, required: ['variant', 'data'], children: false },
  form: { props: { submitLabel: 'string', action: 'string' }, required: ['action'], children: true },
  button: { props: { label: 'string', action: 'string' }, required: ['label', 'action'], children: false },
  code: { props: { text: 'string', language: 'string' }, required: ['text'], children: false },
  callout: { props: { tone: 'string', text: 'string' }, required: ['tone', 'text'], children: false },
};

export interface GenNode {
  component: ComponentName;
  props: Record<string, unknown>;
  children?: GenNode[];
}

/** 树的两条硬上限：深 = 排版崩，宽 = 喂给模型自己都会看漏。 */
export const MAX_DEPTH = 8;
export const MAX_NODES = 512;

const isComponentName = (value: string): value is ComponentName =>
  (COMPONENTS as readonly string[]).includes(value);

function checkPropType(type: PropType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'json':
      return value !== undefined && value !== null;
    default:
      return false;
  }
}

interface Cursor {
  nodes: number;
}

function walk(input: unknown, depth: number, path: string, cursor: Cursor): Parsed<GenNode> {
  cursor.nodes += 1;
  if (cursor.nodes > MAX_NODES) return { ok: false, reason: `${path}: 节点数超过上限 ${MAX_NODES}` };
  if (depth > MAX_DEPTH) return { ok: false, reason: `${path}: 嵌套超过 ${MAX_DEPTH} 层` };

  if (typeof input !== 'object' || input === null) return { ok: false, reason: `${path}: 节点必须是对象` };
  const node = input as { component?: unknown; props?: unknown; children?: unknown };

  if (typeof node.component !== 'string') return { ok: false, reason: `${path}: 缺少 component` };
  if (!isComponentName(node.component)) {
    return { ok: false, reason: `${path}: 组件 ${node.component} 不在白名单内` };
  }

  const spec = SPECS[node.component];
  const rawProps = node.props ?? {};
  if (typeof rawProps !== 'object' || rawProps === null || Array.isArray(rawProps)) {
    return { ok: false, reason: `${path}: props 必须是对象` };
  }

  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawProps as Record<string, unknown>)) {
    const declared = spec.props[key];
    if (declared === undefined) return { ok: false, reason: `${path}.${key}: 未声明的属性` };
    if (!checkPropType(declared, value)) return { ok: false, reason: `${path}.${key}: 应为 ${declared}` };
    props[key] = value;
  }

  for (const key of spec.required) {
    if (!(key in props)) return { ok: false, reason: `${path}: 缺少必填属性 ${key}` };
  }

  const rawChildren = node.children;
  if (rawChildren !== undefined) {
    if (!spec.children) return { ok: false, reason: `${path}: ${node.component} 不能有子节点` };
    if (!Array.isArray(rawChildren)) return { ok: false, reason: `${path}: children 必须是数组` };
    const children: GenNode[] = [];
    for (const [index, child] of rawChildren.entries()) {
      const parsed = walk(child, depth + 1, `${path}[${node.component}].${index}`, cursor);
      if (!parsed.ok) return parsed;
      children.push(parsed.value);
    }
    return { ok: true, value: { component: node.component, props, children } };
  }

  return { ok: true, value: { component: node.component, props } };
}

export function validateTree(input: unknown): Parsed<GenNode> {
  return walk(input, 0, '$', { nodes: 0 });
}

/** 无障碍与降级用：结构再花，读者也得能读到内容。 */
export function toPlainText(node: GenNode): string {
  switch (node.component) {
    case 'text':
    case 'markdown':
    case 'code':
      return String(node.props.text ?? '');
    case 'callout':
      return String(node.props.text ?? '');
    case 'button':
      return `[${String(node.props.label ?? '')}]`;
    case 'table': {
      const columns = Array.isArray(node.props.columns) ? (node.props.columns as string[]) : [];
      const rows = Array.isArray(node.props.rows) ? (node.props.rows as unknown[][]) : [];
      const lines = [columns.join(' | ')];
      for (const row of rows) lines.push((Array.isArray(row) ? row : []).map((cell) => String(cell)).join(' | '));
      return lines.join('\n');
    }
    case 'chart':
      return `[图表 ${String(node.props.variant ?? '')}] ${String(node.props.label ?? '')}`.trim();
    default: {
      const children = node.children ?? [];
      return children.map((child) => toPlainText(child)).filter(Boolean).join('\n');
    }
  }
}
