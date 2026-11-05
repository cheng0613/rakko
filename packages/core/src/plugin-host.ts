/**
 * 插件宿主：负责加载、卸载、热重载工具插件。
 *
 * 热重载的做法很朴素：把上次注册的插件工具全摘掉，重新扫目录再挂上。
 * 内置工具不动 —— 只有插件自己会被替换，运行中的会话下次调工具时拿到的就是新版本。
 */

import { watch, type FSWatcher } from 'node:fs';

import { loadToolPlugins, type ToolPluginError } from './plugins.js';
import type { ToolRegistry, ToolSpec } from './tools.js';

export interface PluginHostInfo {
  directory: string;
  tools: Array<{ name: string; description: string; risk: ToolSpec['risk']; requiresApproval: boolean }>;
  errors: ToolPluginError[];
  /** 最近一次重载的时间，界面用来显示“刚刚更新” */
  reloadedAt: string | null;
}

export interface PluginHostOptions {
  directory: string;
  /** 热重载完成后回调（比如打一行日志） */
  onReload?: (info: PluginHostInfo) => void;
  /** 改动去抖，默认 400ms —— 编辑器保存常常触发多次事件 */
  debounceMs?: number;
}

export class PluginHost {
  private readonly registry: ToolRegistry;
  private readonly options: PluginHostOptions;
  private readonly names = new Set<string>();
  private specs: ToolSpec[] = [];
  private errors: ToolPluginError[] = [];
  private reloadedAt: string | null = null;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(registry: ToolRegistry, options: PluginHostOptions) {
    this.registry = registry;
    this.options = options;
  }

  async reload(): Promise<PluginHostInfo> {
    for (const name of this.names) this.registry.unregister(name);
    this.names.clear();

    const { tools, errors } = await loadToolPlugins(this.options.directory);
    for (const tool of tools) {
      this.registry.register(tool);
      this.names.add(tool.name);
    }

    this.specs = tools;
    this.errors = errors;
    this.reloadedAt = new Date().toISOString();

    const info = this.info();
    this.options.onReload?.(info);
    return info;
  }

  info(): PluginHostInfo {
    return {
      directory: this.options.directory,
      tools: this.specs.map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        requiresApproval: tool.requiresApproval,
      })),
      errors: this.errors,
      reloadedAt: this.reloadedAt,
    };
  }

  /** 目录里任何 .mjs/.js 变动都触发一次重载；目录不存在就安静地不监听 */
  watch(): void {
    if (this.watcher) return;
    const debounceMs = this.options.debounceMs ?? 400;

    try {
      this.watcher = watch(this.options.directory, { persistent: false }, (_event, file) => {
        if (file && !/\.(mjs|js)$/i.test(String(file))) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.reload().catch(() => {
            // 重载失败不要紧，下一轮改动还会再来一次
          });
        }, debounceMs);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // 目录不存在：没有插件可监听
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
