// lib/cache.mjs — 本地缓存：索引 JSON + 条目（均磁盘持久化，0600）。
//
// 设计（ARCHITECTURE.md D1）：缓存 = 上次同步的索引 + 条目副本，是快照注入的
// 同步投影源（rc.6 注入不 await，必须本地可读）。
// - 索引落盘 dir/index.json；
// - 条目落盘 dir/entries/<id>.json，内存 LRU 只是热层；
//   启动/首读时从磁盘懒加载 → 跨进程存活（真实场景：新会话启动时缓存仍在）。
// - 写失败降级为内存-only 并 WARN（不静默吞错）。
//
// 权限说明：writeFileSync 的 {mode:0o600} 仅在新建文件时生效（POSIX；
// win32 无意义，SECURITY.md §5 已披露）。

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_FILE = 'index.json';
const ENTRIES_DIR = 'entries';
const DEFAULT_MAX_ENTRIES = 500;

export function createCache({ dir, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw Object.assign(new TypeError('cache dir is required'), { code: 'INVALID_CONFIG' });
  }
  const indexPath = join(dir, INDEX_FILE);
  const entriesDir = join(dir, ENTRIES_DIR);
  let index = null; // 内存索引（null = 无索引）
  let indexLoaded = false; // 惰性加载标记：只尝试读盘一次
  let diskOk = true; // 磁盘可用性；写失败后置 false 并永久降级内存-only
  let stale = false; // 离线降级标记
  const entries = new Map(); // LRU：Map 迭代序 = 最近使用序（尾 = 最新）

  function warn(msg) {
    // 降级路径必须有可见告警，绝不静默吞错。
    console.warn(`[cache] ${msg}`);
  }

  /** 条目落盘路径（<dir>/entries/<id>.json）。id 含路径分隔符时安全化。 */
  function entryPath(id) {
    const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_');
    return join(entriesDir, `${safe}.json`);
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

  /** 从磁盘加载条目（首读时懒加载一次）。磁盘损坏/缺失 → null（不抛，走降级）。 */
  function loadEntryFromDisk(id) {
    if (!diskOk) return null;
    try {
      const raw = readFileSync(entryPath(id), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function getEntry(id) {
    if (!entries.has(id)) {
      // 内存未命中 → 尝试磁盘（跨进程持久化的关键路径）。
      const fromDisk = loadEntryFromDisk(id);
      if (fromDisk !== null) {
        entries.set(id, fromDisk);
      } else {
        return null;
      }
    }
    // 命中即提升为最新：delete + set 重建迭代序，实现 LRU 语义。
    const entry = entries.get(id);
    entries.delete(id);
    entries.set(id, entry);
    return entry;
  }

  function putEntry(id, entry) {
    entries.delete(id); // 已有同 id 先移除，保持「新写入 = 最新」
    entries.set(id, entry);
    if (diskOk) {
      try {
        mkdirSync(entriesDir, { recursive: true });
        writeFileSync(entryPath(id), JSON.stringify(entry) + '\n', { mode: 0o600 });
      } catch (err) {
        diskOk = false;
        warn(`entry persist failed, degraded to memory-only: ${err.message}`);
      }
    }
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

  /** 从内存与磁盘加载所有条目 id（持久化视图；listLocalIds 只覆盖已加载热层）。 */
  function listDiskIds() {
    if (!diskOk || !existsSync(entriesDir)) return [];
    try {
      return readdirSync(entriesDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  /** 删除条目（内存 + 磁盘）。不存在时静默。 */
  function deleteEntry(id) {
    entries.delete(id);
    if (diskOk) {
      try {
        rmSync(entryPath(id), { force: true });
      } catch (err) {
        warn(`entry delete failed: ${err.message}`);
      }
    }
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
    deleteEntry,
    hasLocal,
    listLocalIds,
    listDiskIds,
    setStale,
    isStale,
    clear,
  };
}
