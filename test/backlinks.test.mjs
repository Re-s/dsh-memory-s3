// test/backlinks.test.mjs — 反链索引（lib/backlinks.mjs）：
// addForward/removeForward/getBacklinks/countOf/allCounts + 本地持久化（0600）。
//
// 语义（MODEL.md §6 L1）：A.links 含 B → B 的反链含 A。正向声明在条目 JSON，
// 反向索引由本模块维护——不污染 S3 条目对象。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBacklinks, isValidLinkId } from '../lib/backlinks.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-s3-backlinks-'));
}

function fileOf(dir) {
  return join(dir, 'backlinks.json');
}

test('isValidLinkId：非空字符串才合法', () => {
  assert.equal(isValidLinkId('abc'), true);
  assert.equal(isValidLinkId('  abc  '), true);
  assert.equal(isValidLinkId(''), false);
  assert.equal(isValidLinkId('   '), false);
  assert.equal(isValidLinkId(42), false);
  assert.equal(isValidLinkId(null), false);
  assert.equal(isValidLinkId(undefined), false);
});

test('addForward：索引写入；getBacklinks 稳定排序；countOf 计数', () => {
  const dir = tempDir();
  try {
    const b = createBacklinks({ dir });
    b.addForward('zeta', ['middle']);
    b.addForward('alpha', ['middle']);
    b.addForward('beta', ['middle', 'other']);
    assert.deepEqual(b.getBacklinks('middle'), ['alpha', 'beta', 'zeta'], '反链列表按 id 排序');
    assert.deepEqual(b.getBacklinks('other'), ['beta']);
    assert.equal(b.countOf('middle'), 3);
    assert.equal(b.countOf('other'), 1);
    // 未知目标 → 空数组 / 0。
    assert.deepEqual(b.getBacklinks('unknown'), []);
    assert.equal(b.countOf('unknown'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addForward：替换语义——旧出链的入边消失，新出链写入', () => {
  const dir = tempDir();
  try {
    const b = createBacklinks({ dir });
    b.addForward('A', ['B']);
    assert.deepEqual(b.getBacklinks('B'), ['A']);
    b.addForward('A', ['C']); // 替换：A 不再引用 B
    assert.deepEqual(b.getBacklinks('B'), [], '旧出链清除');
    assert.deepEqual(b.getBacklinks('C'), ['A']);
    assert.equal(b.countOf('B'), 0);
    assert.equal(b.countOf('C'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addForward：自引用忽略、重复元素去重、空串/空白剔除', () => {
  const dir = tempDir();
  try {
    const b = createBacklinks({ dir });
    b.addForward('A', ['A', 'B', 'B', 'C', '', '   ']);
    assert.deepEqual(b.getBacklinks('A'), [], '自引用不入反链');
    assert.deepEqual(b.getBacklinks('B'), ['A'], '重复元素去重');
    assert.deepEqual(b.getBacklinks('C'), ['A']);
    assert.deepEqual(b.getBacklinks(''), [], '空串不建索引');
    assert.deepEqual(b.getBacklinks('   '), []);
    assert.equal(b.countOf('B'), 1);
    assert.equal(b.countOf('A'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeForward：清空该条目的出链（入边保留——悬空引用渲染容错）', () => {
  const dir = tempDir();
  try {
    const b = createBacklinks({ dir });
    b.addForward('A', ['B']);
    b.addForward('C', ['B']);
    assert.deepEqual(b.getBacklinks('B'), ['A', 'C']);
    b.addForward('A', ['D']); // 替换：A 的出链改为 D
    assert.deepEqual(b.getBacklinks('B'), ['C'], 'A 改引 D 后 B 的入边只剩 C');
    assert.deepEqual(b.getBacklinks('D'), ['A']);
    b.removeForward('A');
    assert.deepEqual(b.getBacklinks('D'), [], 'removeForward 清 A 的出链（D 的入边）');
    assert.deepEqual(b.getBacklinks('B'), ['C'], 'removeForward 只清 A 的出链');
    b.removeForward('C');
    assert.deepEqual(b.getBacklinks('B'), [], '全部来源移除后索引清空');
    assert.equal(b.countOf('B'), 0);
    // 不存在条目 id 的 removeForward 幂等不抛。
    b.removeForward('ghost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allCounts：全量被引用计数快照', () => {
  const dir = tempDir();
  try {
    const b = createBacklinks({ dir });
    b.addForward('A', ['B', 'C']);
    b.addForward('D', ['B']);
    const counts = b.allCounts();
    assert.equal(counts.get('B'), 2);
    assert.equal(counts.get('C'), 1);
    assert.equal(counts.get('D'), undefined, '无入边的目标不在快照中');
    assert.equal(counts.size, 2);
    // 快照与索引解耦：外部修改 Map 不影响内部。
    counts.set('X', 99);
    assert.equal(b.countOf('X'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化：变更即写盘；同 dir 新实例读回', () => {
  const dir = tempDir();
  try {
    const b1 = createBacklinks({ dir });
    b1.addForward('A', ['B', 'C']);
    b1.addForward('E', ['B']);
    const file = fileOf(dir);
    assert.ok(existsSync(file), '变更即写盘');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(onDisk, { B: ['A', 'E'], C: ['A'] }, '盘面形状 target → sorted sources');
    // 同 dir 新实例：构造时载入索引。
    const b2 = createBacklinks({ dir });
    assert.deepEqual(b2.getBacklinks('B'), ['A', 'E']);
    assert.equal(b2.countOf('C'), 1);
    // 新实例变更不影响旧实例内存态。
    b2.removeForward('A');
    assert.deepEqual(b2.getBacklinks('B'), ['E']);
    assert.deepEqual(b1.getBacklinks('B'), ['A', 'E'], '旧实例保持独立内存态');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏 backlinks.json → 空索引不抛（容错启动），并覆写为可用文件', () => {
  const dir = tempDir();
  try {
    writeFileSync(fileOf(dir), 'not json {{{');
    const b = createBacklinks({ dir }); // 不抛
    assert.deepEqual(b.getBacklinks('x'), []);
    assert.equal(b.countOf('x'), 0);
    assert.deepEqual([...b.allCounts().entries()], []);
    // 构造时 persist 已将损坏文件覆写为空索引，重开可用。
    const b2 = createBacklinks({ dir });
    assert.deepEqual(b2.getBacklinks('x'), []);
    assert.equal(JSON.parse(readFileSync(fileOf(dir), 'utf8')).x, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('载入容错：sources 非数组目标跳过；数组内非 string 项过滤', () => {
  const dir = tempDir();
  try {
    writeFileSync(fileOf(dir), JSON.stringify({ B: [42, 'A'], C: 'not-array' }));
    const b = createBacklinks({ dir });
    assert.deepEqual(b.getBacklinks('B'), ['A'], '非 string 项过滤');
    assert.deepEqual(b.getBacklinks('C'), [], '非数组目标跳过');
    assert.equal(b.countOf('B'), 1);
    assert.equal(b.countOf('C'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backlinks.json 新建权限 0600', () => {
  const dir = tempDir();
  try {
    const b = createBacklinks({ dir });
    b.addForward('A', ['B']);
    const mode = statSync(fileOf(dir)).mode & 0o777;
    assert.equal(mode, 0o600, '索引文件仅属主可读写');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});