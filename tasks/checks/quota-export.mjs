#!/usr/bin/env node
/**
 * 验收脚本：describeQuota 必须从包的公开入口拿得到。
 *
 * 这是任务卡里的「独立判断」，不依赖 agent 自己写的测试 ——
 * 它可以从内部路径 import 骗过自己的测试，但骗不过这里。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const failures = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
  if (!ok) failures.push(name);
};

let describeQuota;
try {
  // 从包的入口拿，而不是从内部文件拿
  ({ describeQuota } = await import('@rakko/core'));
} catch (error) {
  console.log(`✗ 无法从 @rakko/core 导入：${error.message}`);
  process.exit(1);
}

check('导出了 describeQuota', typeof describeQuota, 'function');

if (typeof describeQuota === 'function') {
  check('剩余次数文案', describeQuota({ limit: 120, used: 62, degradeOnExceed: true }), '剩余 58 次，可继续运行');
  check('允许降级文案', describeQuota({ limit: 120, used: 120, degradeOnExceed: true }), '本周次数已用完，将降级到快速模型继续');
  check('拦截文案', describeQuota({ limit: 120, used: 130, degradeOnExceed: false }), '本周次数已用完，新任务将被拦截');
}

if (failures.length > 0) {
  console.log(`\n${failures.length} 项不达标：${failures.join('、')}`);
  process.exit(1);
}
console.log('\n全部通过');
