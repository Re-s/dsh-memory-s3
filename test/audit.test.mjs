// test/audit.test.mjs — 审计账本：JSONL 追加 / 尾部读取 / seq 恢复。

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAudit } from '../lib/audit.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-s3-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('append：返回记录且 JSONL 落盘（seq 从 1 起、ts ISO、每行一 JSON）', () => {
  const dir = tempDir(test);
  const audit = createAudit({ dir });
  const record = audit.append('save', { id: 'e1', title: '实验记录' });
  assert.equal(record.seq, 1);
  assert.equal(record.action, 'save');
  assert.deepEqual(record.data, { id: 'e1', title: '实验记录' });
  assert.ok(!Number.isNaN(Date.parse(record.ts))); // ISO 时间可解析

  const raw = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trimEnd();
  assert.equal(raw.split('\n').length, 1);
  assert.deepEqual(JSON.parse(raw), record); // 每行一个完整 JSON
});

test('readTail：按追加顺序返回最近 N 条', () => {
  const dir = tempDir(test);
  const audit = createAudit({ dir });
  for (let i = 1; i <= 5; i++) audit.append('recall', { n: i });
  const tail2 = audit.readTail(2);
  assert.deepEqual(
    tail2.map((r) => r.data.n),
    [4, 5],
  );
  assert.deepEqual(
    tail2.map((r) => r.seq),
    [4, 5],
  );
  const all = audit.readTail(); // 默认 20 条全量
  assert.equal(all.length, 5);
  assert.deepEqual(
    all.map((r) => r.seq),
    [1, 2, 3, 4, 5],
  );
});

test('readTail：空目录返回 []；limit<=0 返回 []', () => {
  const dir = tempDir(test);
  const audit = createAudit({ dir });
  assert.deepEqual(audit.readTail(), []);
  audit.append('sync', {});
  assert.deepEqual(audit.readTail(0), []);
  assert.deepEqual(audit.readTail(-1), []);
});

test('seq 跨实例恢复：同 dir 新实例续号', () => {
  const dir = tempDir(test);
  const a = createAudit({ dir });
  a.append('save', {});
  a.append('save', {});
  const b = createAudit({ dir });
  const record = b.append('remove', {});
  assert.equal(record.seq, 3); // 从已有行数续号
  assert.equal(b.readTail(1)[0].seq, 3);
});

test('append：中文与嵌套对象 round-trip', () => {
  const dir = tempDir(test);
  const audit = createAudit({ dir, retentionDays: 30 });
  audit.append('save', { title: '电话微波炉（暂定名）', nested: { list: [1, 2, { ok: true }] } });
  const [r] = audit.readTail(1);
  assert.equal(r.data.title, '电话微波炉（暂定名）');
  assert.deepEqual(r.data.nested, { list: [1, 2, { ok: true }] });
});

test('retentionDays 非 0：骨架阶段不删文件（语义占位）', () => {
  const dir = tempDir(test);
  const audit = createAudit({ dir, retentionDays: 7 });
  audit.append('save', {});
  assert.equal(audit.readTail(1).length, 1); // 文件仍在，可读
});
