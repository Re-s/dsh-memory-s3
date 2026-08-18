// lib/backlinks.mjs — 记忆反链索引（links 的入边镜像，本地持久化）。
//
// 设计依据（docs/MODEL.md §6，L1 方案）：
// - 条目 A 的 links 含 B 的 id → A 是 B 的反链（backlink/B 的入边）。
// - 只存正向声明（A.links 落条目 JSON），反向索引由本模块维护——不污染 S3 条目
//   对象（Obsidian 反链视图同款心智：写正向链接，自动回填反向视图）。
// - 被引用数（图中心性）是快照注入排序的信号（MODEL.md §8：注入分数含关系度）。
//
// 一致性策略：
// - addForward(entryId, links)：先移除旧出链，再写入新出链（替换语义，与 tags 一致）。
// - removeForward(entryId)：删除条目时清空其出链（目标仍持有悬空引用，渲染层容错）。
// - 悬空引用（links 指向已删除条目）：本索引不主动清理目标侧（目标已删），
//   检索/渲染按"目标不存在"容错显示 (已删除)。
//
// 持久化：cacheDir/backlinks.json（0600），每次变更同步写盘（文件小；
// 与 cache.mjs 的 JSON 持久化一致）。load 在构造时调用。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 校验 links 元素形状：非空字符串且去空白后非空。 */
export function isValidLinkId(id) {
  return typeof id === 'string' && id.trim() !== '';
}

function dbg(msg) {
  if (process.env.DSH_MEMORY_S3_DEBUG) console.debug('[backlinks]', msg);
}

/**
 * 创建反链索引。
 * @param {object} opts
 * @param {string} opts.dir - 缓存目录（backlinks.json 落于此）。
 * @returns {{
 *   addForward(entryId: string, links: string[]): void,
 *   removeForward(entryId: string): void,
 *   getBacklinks(targetId: string): string[],
 *   countOf(targetId: string): number,
 *   allCounts(): Map<string, number>,
 * }}
 */
export function createBacklinks({ dir }) {
  const file = join(dir, 'backlinks.json');
  /** 反链映射：targetId → Set<sourceId>。 */
  const index = new Map();

  // 载入既有索引（容错：损坏 → 从空开始，不抛——反链可重建，不值得阻塞启动）。
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw !== null && typeof raw === 'object') {
        for (const [target, sources] of Object.entries(raw)) {
          if (Array.isArray(sources)) {
            // 载入清洗：仅接受合法来源 id（非空、去空白）——防历史脏数据（空串）穿透并回写。
            const sourceIds = sources.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(isValidLinkId);
            const set = new Set(sourceIds);
            if (set.size > 0) index.set(target.trim(), set);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[backlinks] index load failed, starting empty: ${message}`);
    }
  }

  persist();

  function persist() {
    const out = {};
    for (const [target, sources] of index) {
      out[target] = [...sources].sort();
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch (error) {
      // 持久化失败降级为内存态（索引功能不中断；下次成功写盘覆盖）。
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[backlinks] persist failed, degraded to memory-only: ${message}`);
    }
  }

  // 同步写盘：变更即时持久化（文件规模 O(边数)，10k 条目内 < 1MB，可接受）。

  /**
   * 替换式写入某条目的出链。
   * @param {string} entryId - 来源条目（含 links 的那个）。
   * @param {string[]} links - 完整新出链数组（替换语义）。
   */
  function addForward(entryId, links) {
    const id = String(entryId);
    // 1. 移除该条目的旧出链（替换语义）。
    for (const [target, sources] of index) {
      if (sources.has(id)) {
        sources.delete(id);
        if (sources.size === 0) index.delete(target);
      }
    }
    // 2. 写入新出链（自引用忽略——条目引用自己无意义；坏 id 拒绝）。
    const seen = new Set();
    for (const raw of links ?? []) {
      const link = String(raw).trim();
      if (!isValidLinkId(link) || link === id || seen.has(link)) continue;
      seen.add(link);
      if (!index.has(link)) index.set(link, new Set());
      index.get(link).add(id);
    }
    persist();
    dbg(`addForward ${id} -> ${[...seen].length} link(s)`);
  }

  /** 删除条目时清空其出链（该条目不再作为任何目标的反链来源）。 */
  function removeForward(entryId) {
    const id = String(entryId);
    for (const [target, sources] of index) {
      if (sources.has(id)) {
        sources.delete(id);
        if (sources.size === 0) index.delete(target);
      }
    }
    persist();
    dbg(`removeForward ${id}`);
  }

  /** 查 target 的反链（引用它的条目 id 列表，稳定排序）。 */
  function getBacklinks(targetId) {
    const sources = index.get(String(targetId));
    return sources === undefined ? [] : [...sources].sort();
  }

  /** 某条目的被引用数（图中心性信号）。 */
  function countOf(targetId) {
    return index.get(String(targetId))?.size ?? 0;
  }

  /** 全量计数快照（快照注入排序用）。 */
  function allCounts() {
    const out = new Map();
    for (const [target, sources] of index) out.set(target, sources.size);
    return out;
  }

  return { addForward, removeForward, getBacklinks, countOf, allCounts };
}