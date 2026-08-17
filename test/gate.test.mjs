// test/gate.test.mjs — 审批门 reason 编解码：往返 / 截断 / 非己 reason。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWriteReason, parseWriteReason, isOwnReason } from '../lib/gate.mjs';

test('buildWriteReason → parseWriteReason 往返一致', () => {
  const payload = { type: 'project', title: '电话微波炉（暂定名）', content: '第 1 号实验：向过去发送 D-Mail。', tags: ['lab'], importance: 5 };
  const reason = buildWriteReason({ action: 'save', payload });
  const parsed = parseWriteReason(reason);
  assert.equal(parsed.prefix, 'dsh-memory-s3');
  assert.equal(parsed.action, 'save');
  assert.deepEqual(parsed.payload, payload);
});

test('自定义 prefix 保留在首行并可解析', () => {
  const reason = buildWriteReason({ prefix: 'my-plugin', action: 'update', payload: { id: 'x' } });
  assert.match(reason, /^\[my-plugin\] update:/);
  const parsed = parseWriteReason(reason);
  assert.equal(parsed.prefix, 'my-plugin');
});

test('reason 形状：首行可读摘要 + 空行 + 完整载荷 JSON', () => {
  const payload = { type: 'preference', title: 't', content: 'c' };
  const reason = buildWriteReason({ action: 'save', payload });
  const lines = reason.split('\n');
  assert.equal(lines[0], `[dsh-memory-s3] save: ${JSON.stringify(payload)}`); // 摘要 = 紧凑 JSON
  assert.equal(lines[1], ''); // 空行分隔
  assert.deepEqual(JSON.parse(lines.slice(2).join('\n')), payload); // 正文 = 完整载荷
});

test('摘要截断：>300 字符截断并标注 [truncated]，正文载荷保持完整', () => {
  const longContent = 'x'.repeat(500);
  const payload = { type: 'history', title: 't', content: longContent };
  const reason = buildWriteReason({ action: 'save', payload });
  const firstLine = reason.split('\n')[0];
  assert.ok(firstLine.includes('[truncated]'));
  // 摘要部分 ≤ 300 字符（含标记）
  const summary = firstLine.slice('[dsh-memory-s3] save: '.length);
  assert.ok(summary.length <= 300);
  assert.ok(summary.endsWith('[truncated]'));
  // 正文仍是完整载荷，round-trip 无损
  const parsed = parseWriteReason(reason);
  assert.equal(parsed.payload.content, longContent);
});

test('摘要边界：序列化文本恰好 ≤300 不截断，>300 截断', () => {
  // 紧凑 JSON 开销为 8 字符（{"a":"..."}），故 280 字符 → 288 不截断，
  // 295 字符 → 303 截断：精确落在 300 阈值两侧。
  const atLimit = buildWriteReason({ action: 'save', payload: { a: 'y'.repeat(280) } });
  assert.ok(!atLimit.split('\n')[0].includes('[truncated]'));
  const over = buildWriteReason({ action: 'save', payload: { a: 'y'.repeat(295) } });
  assert.ok(over.split('\n')[0].includes('[truncated]'));
  assert.ok(parseWriteReason(over).payload.a.length === 295); // 正文无损
});

test('isOwnReason：仅识别本插件 prefix', () => {
  const own = buildWriteReason({ action: 'save', payload: {} });
  assert.equal(isOwnReason(own), true);
  assert.equal(isOwnReason('[dsh-memory-s3] save: {}'), true);
  assert.equal(isOwnReason('[other-plugin] save: {}'), false);
  assert.equal(isOwnReason('plain text'), false);
  assert.equal(isOwnReason(''), false);
  assert.equal(isOwnReason(null), false);
  assert.equal(isOwnReason(undefined), false);
});

test('parseWriteReason：格式不符 / 载荷损坏返回 null', () => {
  assert.equal(parseWriteReason(null), null);
  assert.equal(parseWriteReason(undefined), null);
  assert.equal(parseWriteReason(42), null);
  assert.equal(parseWriteReason('没有空行分隔'), null);
  assert.equal(parseWriteReason('[dsh-memory-s3] save: {}'), null); // 缺正文
  assert.equal(parseWriteReason('[dsh-memory-s3] save: x\n\n{broken json'), null); // 坏 JSON
  assert.equal(parseWriteReason(''), null);
});

test('buildWriteReason：缺 action 抛 INVALID_INPUT', () => {
  assert.throws(() => buildWriteReason({ payload: {} }), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => buildWriteReason({ action: '', payload: {} }), (err) => err.code === 'INVALID_INPUT');
});

test('buildWriteReason：循环引用载荷响亮失败（不产出损坏 reason）', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => buildWriteReason({ action: 'save', payload: cyclic }), TypeError);
});
