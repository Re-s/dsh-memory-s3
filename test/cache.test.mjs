// test/cache.test.mjs — 本地缓存：索引持久化 / 条目 LRU / stale / 降级。

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCache } from '../lib/cache.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-s3-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('setIndex/getIndex：内存往返（含嵌套结构）', () => {
  const cache = createCache({ dir: tempDir(test) });
  assert.equal(cache.getIndex(), null); // 首次无索引
  const index = { schema_version: 1, updated_at: '2026-08-17T12:00:00.000Z', entry_count: 2, entries: [{ id: 'x', key: 'entries/x.json', etag: '"a"', updated_at: '2026-08-17T12:00:00.000Z' }] };
  cache.setIndex(index);
  assert.deepEqual(cache.getIndex(), index);
});

test('索引持久化：同 dir 新实例可读回 index.json', () => {
  const dir = tempDir(test);
  const a = createCache({ dir });
  const index = { schema_version: 1, updated_at: '2026-08-17T12:00:00.000Z', entry_count: 0, entries: [] };
  a.setIndex(index);
  const b = createCache({ dir });
  assert.deepEqual(b.getIndex(), index);
});

test('index.json 权限 0600（POSIX）', () => {
  const dir = tempDir(test);
  const cache = createCache({ dir });
  cache.setIndex({ schema_version: 1, entries: [] });
  const mode = statSync(join(dir, 'index.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('索引读回损坏 JSON：降级为空 + 不抛', () => {
  const dir = tempDir(test);
  writeFileSync(join(dir, 'index.json'), '{broken json', { mode: 0o600 });
  const cache = createCache({ dir });
  assert.equal(cache.getIndex(), null);
});

test('putEntry/getEntry：往返 + 命中提升 LRU 序', () => {
  const cache = createCache({ dir: tempDir(test), maxEntries: 3 });
  cache.putEntry('a', { id: 'a' });
  cache.putEntry('b', { id: 'b' });
  cache.putEntry('c', { id: 'c' });
  assert.deepEqual(cache.listLocalIds(), ['a', 'b', 'c']);
  cache.getEntry('a'); // 命中提升 → a 变为最新
  assert.deepEqual(cache.listLocalIds(), ['b', 'c', 'a']);
  cache.putEntry('d', { id: 'd' }); // 超上限逐出最旧（b）——只逐出热层
  assert.deepEqual(cache.listLocalIds(), ['c', 'a', 'd']);
  assert.equal(cache.hasLocal('b'), false);
  // 逐出的是内存热层；磁盘持久化层保留（跨进程回源是持久化语义，见「条目持久化」测试）。
  assert.deepEqual(cache.getEntry('b'), { id: 'b' });
  assert.deepEqual(cache.getEntry('a'), { id: 'a' });
});

test('putEntry：同 id 覆盖不增加占用', () => {
  const cache = createCache({ dir: tempDir(test), maxEntries: 2 });
  cache.putEntry('x', { v: 1 });
  cache.putEntry('x', { v: 2 });
  assert.equal(cache.listLocalIds().length, 1);
  assert.deepEqual(cache.getEntry('x'), { v: 2 });
});

test('hasLocal / listLocalIds / getEntry 缺失返回 null', () => {
  const cache = createCache({ dir: tempDir(test) });
  cache.putEntry('k', { id: 'k' });
  assert.equal(cache.hasLocal('k'), true);
  assert.equal(cache.hasLocal('nope'), false);
  assert.deepEqual(cache.listLocalIds(), ['k']);
  assert.equal(cache.getEntry('nope'), null);
});

test('setStale/isStale：离线降级标记', () => {
  const cache = createCache({ dir: tempDir(test) });
  assert.equal(cache.isStale(), false);
  cache.setStale(true);
  assert.equal(cache.isStale(), true);
  cache.setStale(0); // 非布尔值按 falsy 处理
  assert.equal(cache.isStale(), false);
});

test('clear：清空条目 / 索引 / stale', () => {
  const cache = createCache({ dir: tempDir(test) });
  cache.putEntry('k', { id: 'k' });
  cache.setIndex({ schema_version: 1, entries: [] });
  cache.setStale(true);
  cache.clear();
  assert.deepEqual(cache.listLocalIds(), []);
  assert.equal(cache.getIndex(), null);
  assert.equal(cache.isStale(), false);
});

test('磁盘写失败：降级内存-only，不抛错', () => {
  // dir 指向一个已存在的文件 → mkdirSync 必然失败 → 降级路径生效。
  const dir = tempDir(test);
  const filePath = join(dir, 'not-a-dir');
  writeFileSync(filePath, 'occupied');
  const cache = createCache({ dir: filePath });
  const index = { schema_version: 1, entries: [] };
  assert.doesNotThrow(() => cache.setIndex(index));
  assert.deepEqual(cache.getIndex(), index); // 内存视图仍可用
  assert.equal(statSync(filePath).isFile(), true); // 未破坏原文件
});

test('createCache：缺 dir 抛 INVALID_CONFIG', () => {
  assert.throws(() => createCache(), (err) => err.code === 'INVALID_CONFIG');
  assert.throws(() => createCache({ dir: '' }), (err) => err.code === 'INVALID_CONFIG');
});

test('条目持久化：同 dir 新实例可跨进程读回条目（磁盘回源）', () => {
  const dir = tempDir(test);
  const a = createCache({ dir });
  const entry = { id: 'e1', type: 'preference', title: '语言', content: '用户使用中文交流', importance: 5, tags: ['偏好'] };
  a.putEntry('e1', entry);
  // 模拟新进程：新实例（内存热层为空）必须从磁盘读回。
  const b = createCache({ dir });
  assert.equal(b.listLocalIds().length, 0, '热层为空');
  assert.deepEqual(b.listDiskIds(), ['e1']);
  assert.deepEqual(b.getEntry('e1'), entry, '磁盘回源成功');
  assert.equal(b.hasLocal('e1'), true, '回源后进入热层');
});

test('条目磁盘文件 0600 权限（POSIX）', () => {
  const dir = tempDir(test);
  const cache = createCache({ dir });
  cache.putEntry('k', { id: 'k' });
  const mode = statSync(join(dir, 'entries', 'k.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('deleteEntry：内存 + 磁盘同时删除，幂等', () => {
  const dir = tempDir(test);
  const cache = createCache({ dir });
  cache.putEntry('a', { id: 'a' });
  cache.putEntry('b', { id: 'b' });
  cache.deleteEntry('a');
  assert.equal(cache.getEntry('a'), null);
  assert.deepEqual(cache.listDiskIds(), ['b']);
  assert.doesNotThrow(() => cache.deleteEntry('不存在'));
  const fresh = createCache({ dir });
  assert.deepEqual(fresh.listDiskIds(), ['b'], '删除已持久化');
});

test('listDiskIds：entries 目录不存在时返回空', () => {
  const dir = tempDir(test);
  const cache = createCache({ dir });
  assert.deepEqual(cache.listDiskIds(), []);
});
