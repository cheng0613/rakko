import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COMPONENTS, MAX_DEPTH, SPECS, filterRows, formMessage, interpolate, toPlainText, validateTree } from './index.js';

const card = (children: unknown[]) => ({ component: 'card', props: { title: '构建结果' }, children });

test('白名单固定 12 个组件，且每个都有 spec', () => {
  assert.equal(COMPONENTS.length, 12);
  for (const name of COMPONENTS) assert.ok(SPECS[name], `${name} 缺 spec`);
});

test('合法树通过校验并保留结构', () => {
  const result = validateTree(
    card([
      { component: 'text', props: { text: '3 个任务完成' } },
      {
        component: 'list',
        props: { ordered: true },
        children: [{ component: 'text', props: { text: '迁移 schema' } }],
      },
    ]),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.component, 'card');
    assert.equal(result.value.children?.length, 2);
  }
});

test('白名单外组件一律拒绝 —— 不给模型留任意 HTML 的口子', () => {
  const result = validateTree({ component: 'script', props: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /不在白名单内/);
});

test('未声明属性、类型不符、缺必填都拦下', () => {
  const extra = validateTree({ component: 'text', props: { text: 'x', onclick: 'alert(1)' } });
  assert.equal(extra.ok, false);

  const wrongType = validateTree({ component: 'text', props: { text: 42 } });
  assert.equal(wrongType.ok, false);

  const missing = validateTree({ component: 'button', props: { label: '开始' } });
  assert.equal(missing.ok, false);
});

test('没有子节点的组件塞 children 会被拒', () => {
  const result = validateTree({ component: 'text', props: { text: 'x' }, children: [] });
  assert.equal(result.ok, false);
});

test('嵌套超限报错，而不是栈溢出', () => {
  let node: unknown = { component: 'text', props: { text: '底' } };
  for (let i = 0; i <= MAX_DEPTH + 1; i += 1) node = { component: 'stack', props: {}, children: [node] };
  const result = validateTree(node);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /嵌套超过/);
});

test('降级文本保住内容', () => {
  const parsed = validateTree(
    card([
      { component: 'text', props: { text: '跑完了' } },
      { component: 'table', props: { columns: ['任务', '状态'], rows: [['构建', '成功']] } },
    ]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const plain = toPlainText(parsed.value);
  assert.match(plain, /跑完了/);
  assert.match(plain, /任务 \| 状态/);
  assert.match(plain, /构建 \| 成功/);
});

test('控件只能发消息或改状态，不能带别的花样', () => {
  const ok = validateTree({
    component: 'button',
    props: { label: '只看失败', action: { set: { status: 'failed' } } },
  });
  assert.equal(ok.ok, true);

  const send = validateTree({
    component: 'button',
    props: { label: '再来一次', action: { send: '再试一次 {{query}}' } },
  });
  assert.equal(send.ok, true, 'send 带插值也合法');

  for (const action of [{}, { send: '' }, { set: {} }, { run: 'rm -rf /' }, { send: 'x', run: 'y' }]) {
    const bad = validateTree({ component: 'button', props: { label: '坏', action } });
    assert.equal(bad.ok, false, `应该拒绝：${JSON.stringify(action)}`);
  }

  const badField = validateTree({
    component: 'form',
    props: {
      action: { send: '提交' },
      fields: [{ key: '名称', label: '名字', type: 'text' }],
    },
  });
  assert.equal(badField.ok, false, '字段 key 只能是小写字母数字下划线');

  const badFilter = validateTree({
    component: 'table',
    props: { columns: ['a'], rows: [['x']], filterBy: { key: 'status' } },
  });
  assert.equal(badFilter.ok, false, 'filterBy 必须写清楚按哪一列过滤');
});

test('插值与筛选：找不到的状态就留空，不做表达式求值', () => {
  assert.equal(interpolate('状态：{{status}}', { status: 'failed' }), '状态：failed');
  assert.equal(interpolate('{{missing}} 后面还有字', {}), ' 后面还有字');
  assert.equal(interpolate('{{1+1}}', {}), '{{1+1}}', '不是合法状态名就原样留着');

  const rows = [
    ['1', '成功'],
    ['2', '失败'],
    ['3', '失败'],
  ];
  const filtered = filterRows(['id', '状态'], rows, { key: 'status', field: '状态' }, { status: '失败' });
  assert.deepEqual(filtered, [['2', '失败'], ['3', '失败']]);
  assert.equal(filterRows(['id', '状态'], rows, { key: 'status', field: '状态' }, {}).length, 3, '没选就不筛');
  assert.equal(filterRows(['id', '状态'], rows, { key: 'status', field: '不存在' }, { status: 'x' }).length, 3, '列名找不到就不筛');

  assert.equal(formMessage([{ key: 'q', label: '关键词', type: 'text' }], { q: '出差' }), '关键词：出差');
  assert.equal(
    formMessage([{ key: 'q', label: '关键词', type: 'text' }], { q: '出差' }, '帮我查 {{q}}'),
    '帮我查 出差',
  );
});
