/**
 * 交互层：状态、动作、插值、筛选。
 *
 * 生成式 UI 最容易失控的地方就是「模型想来一段脚本」。这里的边界很硬：
 * 控件只能做两件事 —— 发一条消息给 agent，或改一份本地状态；没有任何执行能力。
 * 状态也只是一层扁平的表，插值只能是 {{key}}，不做表达式求值。
 */

import type { GenNode } from './index.js';

export type Scalar = string | number | boolean;
export type UiState = Record<string, Scalar>;

/** 按钮/表单的动作：要么发消息，要么改状态，两样都可以有 */
export interface UiAction {
  /** 发一条用户消息（支持 {{key}} 插值） */
  send?: string;
  /** 改本地状态，不花配额 */
  set?: UiState;
}

export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  placeholder?: string;
  options?: string[];
}

/** 表格筛选：按 state[key] 过滤，等于某一行字段 */
export interface RowFilter {
  key: string;
  field: string;
}

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** 校验动作结构；返回 null 表示合法 */
export function checkAction(value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${path}: action 必须是对象`;
  }
  const action = value as Record<string, unknown>;
  const hasSend = action.send !== undefined;
  const hasSet = action.set !== undefined;
  if (!hasSend && !hasSet) return `${path}: action 至少要有一个 send 或 set`;

  if (hasSend && (typeof action.send !== 'string' || action.send.trim() === '')) {
    return `${path}.send: 必须是非空字符串`;
  }
  if (hasSet) {
    const set = action.set;
    if (typeof set !== 'object' || set === null || Array.isArray(set)) return `${path}.set: 必须是对象`;
    const entries = Object.entries(set as Record<string, unknown>);
    if (entries.length === 0) return `${path}.set: 不能是空对象`;
    for (const [key, item] of entries) {
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) return `${path}.set.${key}: 状态名只能是小写字母数字下划线`;
      if (!isScalar(item)) return `${path}.set.${key}: 只能是字符串/数字/布尔`;
    }
  }
  for (const key of Object.keys(action)) {
    if (key !== 'send' && key !== 'set') return `${path}.${key}: action 里不认识的字段`;
  }
  return null;
}

/** 校验表单字段 */
export function checkFields(value: unknown, path: string): string | null {
  if (!Array.isArray(value) || value.length === 0) return `${path}: fields 必须是非空数组`;
  if (value.length > 8) return `${path}: 字段最多 8 个`;
  for (const [index, item] of value.entries()) {
    const at = `${path}[${index}]`;
    if (typeof item !== 'object' || item === null) return `${at}: 字段必须是对象`;
    const field = item as Record<string, unknown>;
    if (typeof field.key !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(field.key)) {
      return `${at}.key: 只能是小写字母数字下划线`;
    }
    if (typeof field.label !== 'string' || field.label.trim() === '') return `${at}.label: 必须是非空字符串`;
    if (field.type !== 'text' && field.type !== 'number' && field.type !== 'select') {
      return `${at}.type: 只能是 text / number / select`;
    }
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0) return `${at}.options: select 要有选项`;
      if (!field.options.every((option) => typeof option === 'string')) return `${at}.options: 选项必须是字符串`;
    } else if (field.options !== undefined) {
      return `${at}.options: 只有 select 能带选项`;
    }
    if (field.placeholder !== undefined && typeof field.placeholder !== 'string') {
      return `${at}.placeholder: 必须是字符串`;
    }
  }
  return null;
}

/** 校验筛选条件 */
export function checkFilter(value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: filterBy 必须是对象`;
  const filter = value as Record<string, unknown>;
  if (typeof filter.key !== 'string') return `${path}.key: 必须是字符串`;
  if (typeof filter.field !== 'string') return `${path}.field: 必须是字符串`;
  for (const key of Object.keys(filter)) {
    if (key !== 'key' && key !== 'field') return `${path}.${key}: filterBy 里不认识的字段`;
  }
  return null;
}

/** 把 {{key}} 换成状态里的值；找不到就留空，不要留一堆花括号给用户看 */
export function interpolate(text: string, state: UiState): string {
  return text.replace(/\{\{\s*([a-z][a-z0-9_]{0,23})\s*\}\}/gi, (_, key: string) => {
    const value = state[key];
    return value === undefined ? '' : String(value);
  });
}

/** 解析动作：把插值做掉，得到真正要发的话 / 要改的状态 */
export function resolveAction(action: UiAction, state: UiState): { send?: string; set?: UiState } {
  const resolved: { send?: string; set?: UiState } = {};
  if (action.send !== undefined) resolved.send = interpolate(action.send, state).trim();
  if (action.set !== undefined) resolved.set = { ...action.set };
  return resolved;
}

/**
 * 表格行筛选：state[filterBy.key] 与 row[列序号] 相等才留下。
 * 用列名找列序号，所以调用方改列顺序也不会错位。
 */
export function filterRows(
  columns: string[],
  rows: unknown[][],
  filterBy: RowFilter | undefined,
  state: UiState,
): unknown[][] {
  if (!filterBy) return rows;
  const wanted = state[filterBy.key];
  if (wanted === undefined || wanted === '') return rows;
  const index = columns.indexOf(filterBy.field);
  if (index === -1) return rows;
  return rows.filter((row) => String((row as unknown[])[index]) === String(wanted));
}

/** 表单提交：把字段值拼成一句人话（agent 那边看得到字段名） */
export function formMessage(fields: FormField[], state: UiState, template?: string): string {
  if (template && template.trim() !== '') return interpolate(template, state).trim();
  const parts = fields
    .filter((field) => state[field.key] !== undefined && state[field.key] !== '')
    .map((field) => `${field.label}：${String(state[field.key])}`);
  return parts.join('\n');
}

/** 树里所有被引用的状态键（给前端做默认值初始化用） */
export function collectStateKeys(node: GenNode, into: Set<string> = new Set()): Set<string> {
  if (node.bind) into.add(node.bind);
  const action = node.props.action as UiAction | undefined;
  if (action?.set) for (const key of Object.keys(action.set)) into.add(key);
  const filter = node.props.filterBy as RowFilter | undefined;
  if (filter?.key) into.add(filter.key);
  const fields = node.props.fields as FormField[] | undefined;
  if (Array.isArray(fields)) for (const field of fields) into.add(field.key);
  for (const child of node.children ?? []) collectStateKeys(child, into);
  return into;
}
