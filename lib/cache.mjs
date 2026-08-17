// lib/cache.mjs — 本地缓存：索引 JSON（可持久化）+ 条目 LRU（内存）。
//
// 骨架阶段用同步 fs（简单优先，ARCHITECTURE.md D1 缓存投影语义）：
// - 索引可落盘 dir/index.json（0600），写失败降级为内存-only 并 WARN；
// - 条目 LRU 只驻内存（同步投影的「缓存 = 上次同步的索引 + 条目副本」），
//   磁盘持久化留给 s3store 层做对象级缓存（另一路实验体负责）。
//
// 权限说明：writeFileSync 的 {mode:0o600} 仅在新建文件时生效（POSIX；
// win32 无意义，SECURITY.md §5 已披露）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_FILE = 'index.json';
const DEFAULT_MAX_ENTRIES = 500;

export function createCache({ dir, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw Object.assign(new TypeError('cache dir is required'), { code: 'INVALID_CONFIG' });
  }
  const indexPath = join(dir, INDEX_FILE);
  let index = null; // 内存索引（null = 无索引）
  let indexLoaded = false; // 惰性加载标记：只尝试读盘一次
  let diskOk = true; // 磁盘可用性；写失败后置 false 并永久降级内存-only
  let stale = false; // 离线降级标记
  const entries = new Map(); // LRU：Map 迭代序 = 最近使用序（尾 = 最新）

  function warn(msg) {
    // 降级路径必须有可见告警，绝不静默吞错。
    console.warn(`[cache] ${msg}`);
  }

  function getIndex() {
    if (!indexLoaded) {
      indexLoaded = true;
      if (diskOk && existsSync(indexPath)) {
        try {
          index = JSON.parse(readFileSync(indexPath, 'utf8'));
        } catch (err) {
          warn(`index load failed, falling back to empty: ${err.message}`);
          index = null;
        }
      }
    }
    return index;
  }

  function setIndex(nextIndex) {
    index = nextIndex;
    if (diskOk) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(indexPath, JSON.stringify(nextIndex, null, 2) + '\n', { mode: 0o600 });
      } catch (err) {
        diskOk = false; // 持久化失败 → 后续只走内存，避免每次写都重试失败 I/O
        warn(`index persist failed, degraded to memory-only: ${err.message}`);
      }
    }
    return index;
  }

  function getEntry(id) {
    if (!entries.has(id)) return null;
    // 命中即提升为最新：delete + set 重建迭代序，实现 LRU 语义。
    const entry = entries.get(id);
    entries.delete(id);
    entries.set(id, entry);
    return entry;
  }

  function putEntry(id, entry) {
    entries.delete(id); // 已有同 id 先移除，保持「新写入 = 最新」
    entries.set(id, entry);
    // 超出上限逐出最旧（迭代序头部）。Map 的插入序保证这是真实 LRU。
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
    return entry;
  }

  function hasLocal(id) {
    return entries.has(id);
  }

  function listLocalIds() {
    return [...entries.keys()];
  }

  function setStale(v) {
    stale = Boolean(v);
  }

  function isStale() {
    return stale;
  }

  function clear() {
    entries.clear();
    index = null;
    indexLoaded = true; // 显式清空后不再尝试读盘
    stale = false;
  }

  return {
    getIndex,
    setIndex,
    getEntry,
    putEntry,
    hasLocal,
    listLocalIds,
    setStale,
    isStale,
    clear,
  };
}
