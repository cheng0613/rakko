/*
 * 应用运行时：平台给应用的三样东西 —— 取数、存状态、跟 agent 说话。
 * 只有这三样，没有别的。写得越窄，生成的代码越不容易闯祸。
 */
(() => {
  'use strict';

  /** 应用名：从 /app/<slug>/ 里取，用来定位自己的键值 */
  const slug = (() => {
    const match = location.pathname.match(/^\/app\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  })();

  const stateKey = (key) => 'rakko:' + slug + ':' + key;

  /** 读取平台数据；白名单路径，别的一律拒绝 */
  const ALLOWED = [/^\/runs(\?|$)/, /^\/automations(\?|$)/, /^\/memories(\?|$)/, /^\/apps(\?|$)/, /^\/me(\?|$)/];

  const api = async (path, options) => {
    if (!ALLOWED.some((rule) => rule.test(path))) {
      throw new Error('这个数据接口不在白名单里：' + path);
    }
    const response = await fetch('/app-api' + path, options);
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.json()).message || '';
      } catch {
        detail = '';
      }
      throw new Error(detail || '取数据失败（' + response.status + '）');
    }
    return response.json();
  };

  /** 状态：先落 localStorage（立刻有反应），再写回平台（换设备也在） */
  const state = {
    async get(key, fallback = null) {
      try {
        const local = localStorage.getItem(stateKey(key));
        if (local !== null) return JSON.parse(local);
      } catch {
        /* 忽略 */
      }
      try {
        const body = await api('/kv/' + encodeURIComponent(slug) + '/' + encodeURIComponent(key));
        if (body.value !== null && body.value !== undefined) {
          localStorage.setItem(stateKey(key), JSON.stringify(body.value));
          return body.value;
        }
      } catch {
        /* 忽略 */
      }
      return fallback;
    },
    async set(key, value) {
      try {
        localStorage.setItem(stateKey(key), JSON.stringify(value));
      } catch {
        /* 忽略 */
      }
      try {
        await fetch('/app-api/kv/' + encodeURIComponent(slug) + '/' + encodeURIComponent(key), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        });
      } catch {
        /* 存不上就只在本地，别让界面卡住 */
      }
    },
  };

  /** 跟 agent 说话：往这个应用的线程里发一句（不改代码，只是对话） */
  const agent = {
    async send(text) {
      const threads = await fetch('/v1/apps/' + encodeURIComponent(slug));
      if (!threads.ok) throw new Error('找不到这个应用');
      // 交给外层窗口处理（应用本身没有聊天界面）
      parent.postMessage({ type: 'rakko:agent', slug, text }, location.origin);
      return { ok: true };
    },
  };

  /** 出错别白屏：报给外层窗口，并显示一行可读的提示 */
  const report = (message) => {
    try {
      parent.postMessage({ type: 'rakko:error', slug, message }, location.origin);
    } catch {
      /* 忽略 */
    }
    let bar = document.getElementById('rakko-error');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'rakko-error';
      bar.style.cssText =
        'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;padding:10px 13px;border-radius:12px;' +
        'background:#ff3b30;color:#fff;font:12px/1.5 -apple-system,system-ui,sans-serif;white-space:pre-wrap;box-shadow:0 8px 24px -12px rgba(0,0,0,.5)';
      document.body.append(bar);
    }
    bar.textContent = '出错了：' + message;
  };

  window.addEventListener('error', (event) => report(event.message || '脚本出错'));
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    report(reason && reason.message ? reason.message : String(reason));
  });

  window.RakkoApp = { api, state, agent, slug, report };
})();
