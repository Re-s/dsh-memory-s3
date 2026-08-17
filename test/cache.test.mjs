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
  cache.putEntry('d', { id: 'd' }); // 超上限逐出最旧（b）
  assert.deepEqual(cache.listLocalIds(), ['c', 'a', 'd']);
  assert.equal(cache.hasLocal('b'), false);
  assert.deepEqual(cache.getEntry('b'), null);
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
