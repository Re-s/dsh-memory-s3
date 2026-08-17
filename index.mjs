// index.mjs — dsh-memory-s3 插件入口（唯一 DSH 依赖面）。
//
// 三角色 seam（继承 dsh-memento 模式，ARCHITECTURE.md §4）：
// - Service Definition：ctx.memoryS3（save/update/remove 写方法内部强制过审批门，
//   模型无论经哪个工具间接调用都无法绕过；search/list/recall 读方法无审批，走缓存）。
// - Provider：lib/s3store.mjs（S3 对象存储，SigV4）+ lib/cache.mjs（本地投影）。
// - Consumer：memory_s3_* 九工具 + 冻结快照注入（systemPrompt 段，同步提供者）。
//
// 红线遵守：
// - lib/ 零 DSH 依赖；@deepseek-ai/* 只出现在本文件。
// - systemPrompt 提供者必须同步（rc.6 不 await）：text 回调内禁止 await，只读内存缓存。
// - 不 append 未注册的会话事件类型（KNOWN_SESSION_EVENT_TYPES 门）：骨架干脆不 append。
// - enabled:false 整体 return，不留半残。
//
// 骨架阶段说明（如实披露）：
// - cache.mjs 无 deleteEntry API，remove 用本地 deleted 集合屏蔽读路径（S3 侧对象已删，
//   sync 后自然消失）。
// - forget 仅本地标记（不删 S3 对象），快照投影排除 forgotten。
// - 词表固定 en（Config 无 language 字段；strings('en')）。

import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createS3Store } from './lib/s3store.mjs';
import { createEmbedder } from './lib/embedder.mjs';
import { normalizeEntry, fromJSON, toJSON, sameTitle, detectEntrySecrets, TYPES } from './lib/entry.mjs';
import { bruteForceTopK } from './lib/vector.mjs';
import { createCache } from './lib/cache.mjs';
import { createAudit } from './lib/audit.mjs';
import { buildWriteReason, isOwnReason } from './lib/gate.mjs';
import { strings } from './lib/strings.mjs';

export const name = 'memory-s3';

export const inject = ['tools', 'systemPrompt', 'approval'];

/** 工具名前缀（approval answerer 认领与工具注册共用）。 */
const TOOL_PREFIX = 'memory_s3_';

/** 领域错误码（工具层转为 {ok:false, error:{code,message}}；其余视为基础设施错误抛出）。 */
const DOMAIN_CODES = new Set(['INVALID_INPUT', 'NOT_FOUND', 'SECRET_DETECTED', 'DENIED', 'CONFLICT']);

/** 结构化领域错误：{code, message, details?}（对齐 ARCHITECTURE.md D8 错误码表）。 */
function domainError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function invalidConfig(message) {
  return Object.assign(new Error(`dsh-memory-s3 config: ${message}`), { code: 'INVALID_CONFIG' });
}

/** 文本截断（快照/渲染用；骨架 200 字符）。 */
function snippet(text, max = 200) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 工具 render 的 content block 形状（dsh-tools 约定）。 */
function renderText(text) {
  return [{ type: 'text', text }];
}

/**
 * 插件配置（Schemastery，对齐 README.md 配置表；cordis loader 已套默认值，
 * apply 内再显式补默认——与 Config 同源）。
 * embedder.provider 默认 'none'（零配置可用，search 关键词不依赖嵌入）；要启用
 * 向量召回再显式配置 provider/endpoint/apiKeyEnv。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  bucket: Schema.string().required(),
  prefix: Schema.string().default('dsh-memory-s3'),
  endpoint: Schema.string().default(''),
  region: Schema.string().default('us-east-1'),
  accessKeyEnv: Schema.string().default('AWS_ACCESS_KEY_ID'),
  secretKeyEnv: Schema.string().default('AWS_SECRET_ACCESS_KEY'),
  sessionTokenEnv: Schema.string().default('AWS_SESSION_TOKEN'),
  writePolicy: Schema.union(['ask', 'auto', 'off']).default('ask'),
  snapshotOrder: Schema.number().default(-50),
  maxInjectedItems: Schema.number().default(5),
  importanceThreshold: Schema.number().default(3),
  embedder: Schema.object({
    provider: Schema.union(['openai-compatible', 'ollama', 'none']).default('none'),
    endpoint: Schema.string().default(''),
    apiKeyEnv: Schema.string().default('OPENAI_API_KEY'),
    model: Schema.string().default('text-embedding-3-small'),
    dimensions: Schema.number().default(768),
  }),
  cacheDir: Schema.string().default(''),
  auditRetentionDays: Schema.number().default(0),
});

/**
 * ctx.memoryS3 服务（Service Definition 实现，对齐 types.d.ts 接口）。
 * 写方法（save/update/remove）内部强制过 ctx.approval.request：
 *   秘密检测 → 嵌入（异步，失败降级）→ 审批（reason 携带完整写载荷）→ S3 落盘
 *   → 缓存更新 → 审计；outcome !== 'allowed-once' 落 *-denied 审计行后抛 DENIED。
 * 读方法（search/list/recall）走缓存（同步），结果标注 stale。
 */
class MemoryS3Service {
  /**
   * @param {object} deps - {s3, cache, audit, embedder, approval, config}。
   */
  constructor(deps) {
    this.s3 = deps.s3;
    this.cache = deps.cache;
    this.audit = deps.audit;
    this.embedder = deps.embedder;
    this.approval = deps.approval;
    this.config = deps.config;
    this.text = strings('en');
    /** 快照注入抑制集合（forget 标记；S3 侧保留，仅本地投影过滤）。 */
    this.forgotten = new Set();
    /** 本地删除屏蔽集合（cache 无 deleteEntry API 的骨架替代，见文件头注释）。 */
    this.deleted = new Set();
  }

  // ── 写路径 ────────────────────────────────────────────────────────────────

  /**
   * 新增条目（审批门 + 去重合并）。
   * 同 (type, title) 已存在 → merged（走 update 审批，载荷含新旧全文）；
   * 否则 created（If-None-Match: * 条件创建）。
   */
  async save(input, write) {
    this.#assertAgent(write);
    const workspaceKey = typeof input.workspaceKey === 'string' ? input.workspaceKey : this.#workspaceKeyOf(write);
    const agentKey = typeof input.agentKey === 'string' ? input.agentKey : this.#agentKeyOf(write);
    const entry = normalizeEntry(input, { workspaceKey, agentKey });
    this.#assertNoSecrets(entry);

    const existing = this.#findByTitle(entry.type, entry.title);
    if (existing !== null) {
      const { entry: merged } = await this.#updateExisting(existing, {
        content: entry.content,
        tags: entry.tags,
        importance: entry.importance,
      }, write);
      return { action: 'merged', entry: merged };
    }

    await this.#tryEmbed(entry);
    await this.#askApproval({
      action: 'save',
      type: entry.type,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      importance: entry.importance,
      source: entry.source,
      workspaceKey,
      agentKey,
    }, write);
    this.#throwIfAborted(write);

    const key = this.s3.keyOf(entry.type, entry.id);
    try {
      await this.s3.putObject(key, JSON.stringify(toJSON(entry)), { ifNoneMatch: '*' });
    } catch (error) {
      // 预检未发现但远端已存在（多实例并发/缓存过期）：读回远端条目。
      // 同 title 则合并（再走一次 update 审批，披露新旧全文）；否则亮 CONFLICT——
      // 不同内容撞 id 绝不静默覆盖（乐观并发语义，ARCHITECTURE.md D6）。
      if (error?.code === 'CONFLICT') {
        const remote = await this.#readRemoteByType(entry.type, entry.id);
        if (remote !== null && sameTitle(remote, entry)) {
          const { entry: merged } = await this.#updateExisting(remote, {
            content: entry.content,
            tags: entry.tags,
            importance: entry.importance,
          }, write);
          return { action: 'merged', entry: merged };
        }
      }
      throw error;
    }
    this.cache.putEntry(entry.id, entry);
    this.#auditWrite('save', entry, write, {});
    return { action: 'created', entry };
  }

  /**
   * 更新条目（审批门；载荷携带新旧全文，approve-what-you-see）。
   * patch.type 变化触发 key 迁移（新 key If-None-Match 创建 + 旧 key 删除）。
   */
  async update(id, patch, write) {
    this.#assertAgent(write);
    const existing = this.cache.getEntry(id);
    if (existing === null) {
      throw domainError('NOT_FOUND', `entry ${id} not found in cache; run memory_s3_sync first`);
    }
    return this.#updateExisting(existing, patch, write);
  }

  /** 删除条目（审批门；载荷携带被删全文）。S3 对象删除，versioning 下可恢复。 */
  async remove(id, write) {
    this.#assertAgent(write);
    const existing = this.cache.getEntry(id);
    if (existing === null) {
      throw domainError('NOT_FOUND', `entry ${id} not found in cache; run memory_s3_sync first`);
    }
    await this.#askApproval({
      action: 'remove',
      id: existing.id,
      type: existing.type,
      title: existing.title,
      content: existing.content,
    }, write);
    this.#throwIfAborted(write);
    await this.s3.deleteObject(this.s3.keyOf(existing.type, existing.id));
    this.deleted.add(existing.id);
    this.#auditWrite('remove', existing, write, {});
    return { entry: existing };
  }

  /** 抑制自动注入而不删除（无审批；仅本地标志，S3 侧保留）。 */
  async forget(id, forgotten = true) {
    const entry = this.cache.getEntry(id);
    if (entry === null) throw domainError('NOT_FOUND', `entry ${id} not found in cache`);
    if (forgotten) this.forgotten.add(id);
    else this.forgotten.delete(id);
    this.audit.append('forget', {
      entryId: id,
      type: entry.type,
      title: entry.title,
      forgotten,
      outcome: 'ok',
    });
    return { entry };
  }

  // ── 读路径（同步走缓存） ─────────────────────────────────────────────────

  /** 关键词检索：大小写不敏感子串匹配 title/content/tags + 元数据过滤（无审批）。 */
  search(filter = {}) {
    const all = this.#filterEntries(filter);
    const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 10;
    return {
      entries: all.slice(0, limit),
      total: all.length,
      stale: this.cache.isStale(),
    };
  }

  /** 列表：按 updatedAt 倒序，offset/limit 分页。 */
  list(filter = {}) {
    const all = this.#filterEntries(filter);
    const offset = Number.isInteger(filter.offset) && filter.offset > 0 ? filter.offset : 0;
    const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 10;
    return {
      entries: all.slice(offset, offset + limit),
      total: all.length,
      stale: this.cache.isStale(),
    };
  }

  /**
   * 语义召回（异步）：embed(query) → 向量 top-k（bruteForceTopK）→ 关键词子串
   * → RRF 合并（向量 w=1.0，关键词 w=0.7；TECH_STACK.md §6）。嵌入器不可用
   * 或全部无 embedding 时降级为纯关键词。
   */
  async recall(query) {
    const q = typeof query?.query === 'string' ? query.query : '';
    if (q === '') throw domainError('INVALID_INPUT', 'recall query must be a non-empty string');
    const topK = Number.isInteger(query.topK) && query.topK > 0 ? query.topK : 20;
    const limit = Number.isInteger(query.limit) && query.limit > 0 ? query.limit : 10;

    let queryVec = null;
    try {
      queryVec = await this.embedder.embed(q);
    } catch (error) {
      // 嵌入失败降级关键词（不阻塞召回；EMBED_DISABLED 属预期路径，debug 级）。
      console.debug(`[memory-s3] embed skipped (${error?.code ?? 'error'}): ${error?.message ?? error}`);
    }

    const candidates = this.#filterEntries({ type: query.type, tags: query.tags });
    const scores = new Map(); // entryId → 累计 RRF 分数
    if (queryVec !== null) {
      const items = candidates
        .filter((c) => Array.isArray(c.embedding))
        .map((c) => ({ id: c.id, vec: c.embedding }));
      bruteForceTopK(queryVec, items, topK).forEach((hit, rank) => {
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1.0 / (60 + rank + 1));
      });
    }
    const text = q.toLowerCase();
    const keywordHits = candidates
      .filter((c) => `${c.title}\n${c.content}\n${c.tags.join(' ')}`.toLowerCase().includes(text))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    keywordHits.forEach((c, rank) => {
      scores.set(c.id, (scores.get(c.id) ?? 0) + 0.7 / (60 + rank + 1));
    });

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const entries = ranked
      .slice(0, limit)
      .map((id) => this.cache.getEntry(id))
      .filter((e) => e !== null);
    // 召回计数本地递增（骨架不落 S3；sync 拉取会覆盖为远端值）。
    for (const entry of entries) {
      entry.recallCount += 1;
      entry.lastRecalled = Date.now();
    }
    this.audit.append('recalled', { query: q, matches: ranked.length, outcome: 'ok' });
    return { entries, total: ranked.length, stale: this.cache.isStale() };
  }

  // ── 同步与状态 ────────────────────────────────────────────────────────────

  /**
   * 手动同步：listObjects 分页拉远端全部条目 → fromJSON → 更新缓存索引 →
   * 标记 stale 清除。失败 → sync 状态记录错误 + 缓存 stale（离线降级读仍可用）。
   */
  async sync() {
    const startedAt = new Date().toISOString();
    try {
      let pulled = 0;
      let token;
      do {
        const page = await this.s3.listObjects({ prefix: 'memories/', continuationToken: token });
        for (const item of page.keys) {
          const obj = await this.s3.getObject(item.key);
          if (obj === null) continue;
          let entry;
          try {
            entry = fromJSON(JSON.parse(obj.body));
          } catch (error) {
            // 单条损坏跳过但不静默：warn + 继续（账本可重建性优先，与 audit 同哲学）。
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[memory-s3] skipping corrupt object ${item.key}: ${message}`);
            continue;
          }
          this.cache.putEntry(entry.id, entry);
          pulled += 1;
        }
        token = page.nextToken;
      } while (token !== undefined);
      this.cache.setIndex({ lastSync: startedAt, ok: true });
      this.cache.setStale(false);
      this.audit.append('sync', { pulled, outcome: 'ok' });
      return { ok: true, pulled, updatedAt: startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cache.setIndex({ lastSync: this.#syncState().lastSync, ok: false, error: message });
      this.cache.setStale(true);
      this.audit.append('sync', { outcome: 'failed', error: message });
      return { ok: false, pulled: 0, updatedAt: startedAt, error: message };
    }
  }

  /** 状态视图（types.d.ts MemoryS3Status）。 */
  status() {
    return {
      configured: this.config.configured,
      sync: this.#syncState(),
      cachedEntries: this.cache.listLocalIds().length,
      embedder: this.embedder.name,
      cacheDir: this.config.cacheDir,
    };
  }

  /**
   * 冻结快照渲染（systemPrompt 提供者专用：同步、无 await、只读内存缓存）。
   * 投影 = 缓存条目中 importance ≥ threshold 的前 maxInjectedItems 条（排除
   * forgotten/deleted）；无缓存返回 strings.notSynced 提示。
   */
  snapshotText() {
    const index = this.cache.getIndex();
    const all = this.#filterEntries({});
    const total = all.length;
    if (total === 0) return this.text.notSynced;
    const eligible = all
      .filter((e) => !this.forgotten.has(e.id))
      .filter((e) => e.importance >= this.config.importanceThreshold)
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      .slice(0, this.config.maxInjectedItems);
    const lastSync = index?.lastSync ?? 'never';
    const header = this.text.snapshotHeader({ count: eligible.length, total, lastSync });
    const lines = eligible.map((e) => `- [${e.type}] ${e.title}: ${snippet(e.content)}`);
    return [header, ...lines].join('\n');
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────────────

  /** 同步状态从缓存索引读取（sync 落盘；status/快照复用同一事实源）。 */
  #syncState() {
    const index = this.cache.getIndex();
    if (index === null || typeof index !== 'object') return { lastSync: null, ok: false };
    return {
      lastSync: typeof index.lastSync === 'string' ? index.lastSync : null,
      ok: index.ok === true,
      ...(typeof index.error === 'string' ? { error: index.error } : {}),
    };
  }

  /** 过滤 + updatedAt 倒序排序的缓存条目全量（search/list/recall/快照共用语义）。 */
  #filterEntries(filter = {}) {
    const text = typeof filter.text === 'string' && filter.text !== '' ? filter.text.toLowerCase() : '';
    const type = filter.type;
    const tags =
      Array.isArray(filter.tags) && filter.tags.length > 0 ? filter.tags.map((t) => String(t).toLowerCase()) : null;
    const importanceMin = filter.importanceMin;
    const out = [];
    for (const id of this.cache.listLocalIds()) {
      if (this.deleted.has(id)) continue;
      const entry = this.cache.getEntry(id);
      if (entry === null) continue;
      if (type !== undefined && entry.type !== type) continue;
      if (tags !== null && !tags.every((t) => entry.tags.map((x) => x.toLowerCase()).includes(t))) continue;
      if (importanceMin !== undefined && entry.importance < importanceMin) continue;
      if (text !== '' && !`${entry.title}\n${entry.content}\n${entry.tags.join(' ')}`.toLowerCase().includes(text)) continue;
      out.push(entry);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /** 同 (type, title) 去重预检（区分大小写，entry.mjs sameTitle 语义）。 */
  #findByTitle(type, title) {
    for (const id of this.cache.listLocalIds()) {
      if (this.deleted.has(id)) continue;
      const entry = this.cache.getEntry(id);
      if (entry !== null && sameTitle(entry, { type, title })) return entry;
    }
    return null;
  }

  /** 合并更新实现（save 的 merged 路径与 update 共用）：秘密检测 → 嵌入 → 审批 → 条件写。 */
  async #updateExisting(existing, patch, write) {
    const next = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      updatedAt: Date.now(),
    };
    this.#assertNoSecrets(next);
    if (next.content !== existing.content || next.title !== existing.title) await this.#tryEmbed(next);
    await this.#askApproval({
      action: 'update',
      id: existing.id,
      previous: { title: existing.title, content: existing.content },
      next: { title: next.title, content: next.content },
      type: next.type,
      tags: next.tags,
      importance: next.importance,
    }, write);
    this.#throwIfAborted(write);

    const key = this.s3.keyOf(next.type, next.id);
    const keyChanged = patch.type !== undefined && patch.type !== existing.type;
    if (keyChanged) {
      // type 迁移：新 key 条件创建（If-None-Match），旧 key 删除。
      await this.s3.putObject(key, JSON.stringify(toJSON(next)), { ifNoneMatch: '*' });
      await this.s3.deleteObject(this.s3.keyOf(existing.type, existing.id));
    } else {
      const head = await this.s3.headObject(key);
      if (head === null) {
        throw domainError('NOT_FOUND', `entry ${next.id} not found on remote; run memory_s3_sync and retry`);
      }
      // 乐观并发：If-Match 失败 → CONFLICT（工具层返回 ok:false，模型可重试）。
      await this.s3.putObject(key, JSON.stringify(toJSON(next)), { ifMatch: head.etag });
    }
    this.cache.putEntry(next.id, next);
    this.#auditWrite('update', next, write, { previousId: existing.id });
    return { previous: existing, entry: next };
  }

  /** 审批门（approve-what-you-see）：唯一放行 allowed-once；其余落 *-denied 审计行后抛 DENIED。 */
  async #askApproval(payload, write) {
    let outcome;
    try {
      outcome = await this.approval.request({
        agent: write.agent,
        toolName: typeof write.toolName === 'string' ? write.toolName : `${TOOL_PREFIX}save`,
        reason: buildWriteReason({ action: payload.action, payload }),
        ...(write.callId === undefined ? {} : { callId: write.callId }),
        ...(write.signal === undefined ? {} : { signal: write.signal }),
      });
    } catch (error) {
      // 审批服务自身故障（unavailable）→ 视同拒绝（写不落盘），留痕审计。
      const message = error instanceof Error ? error.message : String(error);
      this.audit.append(`${payload.action}-denied`, {
        ...this.#auditBase(write),
        outcome: 'unavailable',
        error: message,
      });
      throw domainError('DENIED', this.text.denied, { outcome: 'unavailable' });
    }
    if (outcome !== 'allowed-once') {
      this.audit.append(`${payload.action}-denied`, { ...this.#auditBase(write), outcome });
      throw domainError('DENIED', this.text.denied, { outcome });
    }
    return outcome;
  }

  /** 写成功审计行（content 全文入账——秘密检测已拦截凭据形状，S2 可重建）。 */
  #auditWrite(action, entry, write, extra) {
    this.audit.append(action, {
      entryId: entry.id,
      type: entry.type,
      title: entry.title,
      content: entry.content,
      ...this.#auditBase(write),
      ...extra,
    });
  }

  /** 审计基础归属字段（sessionId 用于重建）。 */
  #auditBase(write) {
    return { sessionId: write.agent?.session?.id ?? null };
  }

  /** 秘密检测（SECURITY.md §3 启发式）：命中即拒写。 */
  #assertNoSecrets(entry) {
    const hit = detectEntrySecrets(entry);
    if (hit !== null) {
      throw domainError(hit.code, `entry contains secret-like content (${hit.pattern})`, hit);
    }
  }

  /** 嵌入（失败降级：仅日志，不阻塞写入——关键词检索仍可用）。 */
  async #tryEmbed(entry) {
    try {
      const vec = await this.embedder.embed(entry.content);
      entry.embedding = [...vec];
    } catch (error) {
      console.debug(`[memory-s3] embed skipped (${error?.code ?? 'error'}): ${error?.message ?? error}`);
    }
  }

  /** 按已知 type 直读远端条目（CONFLICT 重读-合并用）。 */
  async #readRemoteByType(type, id) {
    const obj = await this.s3.getObject(this.s3.keyOf(type, id));
    if (obj === null) return null;
    try {
      return fromJSON(JSON.parse(obj.body));
    } catch {
      return null; // 远端对象损坏 → 无从合并，调用方继续抛 CONFLICT。
    }
  }

  /** 写路径必须有 agent（审批路由与审计归属）：缺失即失败封闭。 */
  #assertAgent(write) {
    if (write === null || typeof write !== 'object' || write.agent === undefined || write.agent === null) {
      throw domainError('INVALID_INPUT', 'write requires an agent context (approval routing)');
    }
  }

  #throwIfAborted(write) {
    write.signal?.throwIfAborted();
  }

  #workspaceKeyOf(write) {
    const cwd = write.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : '';
  }

  #agentKeyOf(write) {
    const preset = write.agent?.session?.header?.agentPreset;
    return typeof preset === 'string' && preset !== '' ? preset : '';
  }
}

// ── 工具输出 schema 复用块 ──────────────────────────────────────────────────

/** 条目公开投影（不含 embedding 向量；对齐 types.d.ts MemoryS3Entry 字段集）。 */
const ENTRY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    type: { type: 'string', enum: TYPES, required: true },
    title: { type: 'string', required: true },
    content: { type: 'string', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    importance: { type: 'integer', required: true },
    source: { type: 'string', required: true },
    createdAt: { type: 'integer', required: true },
    updatedAt: { type: 'integer', required: true },
    recallCount: { type: 'integer', required: true },
    lastRecalled: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    workspaceKey: { type: 'string', required: true },
    agentKey: { type: 'string', required: true },
  },
};

const ENTRY_LIST_OUTPUT = {
  type: 'array',
  items: ENTRY_OUTPUT,
};

const ERROR_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
};

const OK_ERROR_PROPS = {
  ok: { type: 'boolean', required: true },
  error: ERROR_OUTPUT,
};

const QUERY_RESULT_PROPS = {
  ...OK_ERROR_PROPS,
  entries: ENTRY_LIST_OUTPUT,
  total: { type: 'integer', required: true },
  stale: { type: 'boolean', required: true },
};

/** 工具 execute 的公共错误闸：领域错误 → {ok:false, error}；基础设施错误原样抛出。 */
function toolCatch(error) {
  if (error !== null && typeof error === 'object' && DOMAIN_CODES.has(error.code)) {
    return { ok: false, error: { code: error.code, message: error instanceof Error ? error.message : String(error) } };
  }
  throw error;
}

/** 写上下文（工具 execute 公共构造）。 */
function writeContextOf(exec) {
  return {
    agent: exec.agent,
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    signal: exec.signal,
    toolName: exec.name,
  };
}

/** 条目渲染行（工具 render 用）。 */
function entryLine(entry) {
  return `- [${entry.type}] ${entry.title} (${entry.id}, importance ${entry.importance}): ${snippet(entry.content)}`;
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

/** 注册 memory_s3_* 九工具（description/parameters/output.schema 对齐 types.d.ts 语义）。 */
function makeMemoryTools(service) {
  return [
    defineTool({
      name: 'memory_s3_save',
      description:
        'Save a structured memory entry to S3-backed cross-session memory (approval-gated). ' +
        'type ∈ preference|project|decision|history. Deduplicates by (type, title): an existing entry with ' +
        'the same type and title is merged via an update approval carrying both old and new text.',
      parameters: {
        type: { type: 'string', enum: TYPES, required: true, description: 'Entry type: preference|project|decision|history.' },
        title: { type: 'string', required: true, description: 'Short title; also the dedup key within a type.' },
        content: { type: 'string', required: true, description: 'Entry body text.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag strings.' },
        importance: { type: 'integer', description: 'Importance 1-5 (default 3); >= threshold enters snapshot injection.' },
        workspaceKey: { type: 'string', description: 'Explicit workspace key; default = session cwd.' },
        agentKey: { type: 'string', description: 'Explicit agent key; default = session agentPreset.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            action: { type: 'string', enum: ['created', 'merged'], required: true },
            entry: ENTRY_OUTPUT,
          },
        },
        render: (_args, value) =>
          renderText(
            value.ok
              ? `memory_s3_save: ${value.action} entry\n${entryLine(value.entry)}`
              : `memory_s3_save failed: ${value.error.code}: ${value.error.message}`,
          ),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.save(args, writeContextOf(exec));
          return { ok: true, action: result.action, entry: result.entry };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_search',
      description:
        'Keyword substring search over cached memory entries (no approval; reads the local cache projection). ' +
        'Case-insensitive substring match on title/content/tags, plus type/tags/importanceMin filters.',
      parameters: {
        text: { type: 'string', description: 'Case-insensitive substring to match.' },
        type: { type: 'string', enum: TYPES, description: 'Filter by entry type.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Entry must contain ALL listed tags.' },
        importanceMin: { type: 'integer', description: 'Minimum importance (1-5).' },
        limit: { type: 'integer', description: 'Max entries to return (default 10).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: QUERY_RESULT_PROPS },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_search: ${value.total} match(es)\n${value.entries.map(entryLine).join('\n')}`)
            : renderText(`memory_s3_search failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = service.search({
            text: args.text,
            type: args.type,
            tags: args.tags,
            importanceMin: args.importanceMin,
            limit: args.limit,
          });
          return { ok: true, entries: result.entries, total: result.total, stale: result.stale };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_recall',
      description:
        'Semantic recall: embed the query, score cached entries by vector top-k + keyword substring, ' +
        'merge with RRF. Falls back to keyword-only when the embedder is unavailable (provider none).',
      parameters: {
        query: { type: 'string', required: true, description: 'Natural-language query to recall against.' },
        type: { type: 'string', enum: TYPES, description: 'Filter by entry type.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Entry must contain ALL listed tags.' },
        topK: { type: 'integer', description: 'Vector candidate count (default 20).' },
        limit: { type: 'integer', description: 'Max entries to return (default 10).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: QUERY_RESULT_PROPS },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_recall: ${value.total} match(es)\n${value.entries.map(entryLine).join('\n')}`)
            : renderText(`memory_s3_recall failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.recall({
            query: args.query,
            type: args.type,
            tags: args.tags,
            topK: args.topK,
            limit: args.limit,
          });
          return { ok: true, entries: result.entries, total: result.total, stale: result.stale };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_list',
      description:
        'List cached memory entries, newest first (updatedAt desc), with offset/limit paging and ' +
        'type/tags/importanceMin filters. No approval (local cache read).',
      parameters: {
        type: { type: 'string', enum: TYPES, description: 'Filter by entry type.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Entry must contain ALL listed tags.' },
        importanceMin: { type: 'integer', description: 'Minimum importance (1-5).' },
        limit: { type: 'integer', description: 'Max entries to return (default 10).' },
        offset: { type: 'integer', description: 'Paging offset (default 0).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: QUERY_RESULT_PROPS },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_list: ${value.total} entrie(s)\n${value.entries.map(entryLine).join('\n')}`)
            : renderText(`memory_s3_list failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = service.list({
            type: args.type,
            tags: args.tags,
            importanceMin: args.importanceMin,
            limit: args.limit,
            offset: args.offset,
          });
          return { ok: true, entries: result.entries, total: result.total, stale: result.stale };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_update',
      description:
        'Update one memory entry by id (approval-gated; the approval reason carries the full old and new text). ' +
        'Supports title/content/tags/importance/type. Changing type migrates the S3 object key.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id (from save/search/list results).' },
        title: { type: 'string', description: 'New title.' },
        content: { type: 'string', description: 'New body text.' },
        type: { type: 'string', enum: TYPES, description: 'New type (migrates S3 key).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
        importance: { type: 'integer', description: 'New importance 1-5.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            previous: ENTRY_OUTPUT,
            entry: ENTRY_OUTPUT,
          },
        },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_update: ${value.entry.id}\nbefore: ${snippet(value.previous.content)}\nafter: ${snippet(value.entry.content)}`)
            : renderText(`memory_s3_update failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.update(
            args.id,
            {
              title: args.title,
              content: args.content,
              type: args.type,
              tags: args.tags,
              importance: args.importance,
            },
            writeContextOf(exec),
          );
          return { ok: true, previous: result.previous, entry: result.entry };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_delete',
      description:
        'Delete one memory entry by id (approval-gated; the approval reason carries the full text being deleted). ' +
        'Removes the S3 object (recoverable under bucket versioning).',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id to delete.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ...OK_ERROR_PROPS, entry: ENTRY_OUTPUT },
        },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_delete: removed ${value.entry.id} (${value.entry.type}) ${value.entry.title}`)
            : renderText(`memory_s3_delete failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.remove(args.id, writeContextOf(exec));
          return { ok: true, entry: result.entry };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_forget',
      description:
        'Suppress auto-injection of an entry into the system-prompt snapshot without deleting it ' +
        '(no approval; local flag only, the S3 object stays). Pass forgotten=false to re-enable injection.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id to suppress/restore.' },
        forgotten: { type: 'boolean', description: 'true = suppress (default), false = restore.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ...OK_ERROR_PROPS, entry: ENTRY_OUTPUT },
        },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_forget: ${value.entry.id} injection ${value.entry.importance >= 0 ? 'suppressed' : ''}`)
            : renderText(`memory_s3_forget failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.forget(args.id, args.forgotten !== false);
          return { ok: true, entry: result.entry };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_sync',
      description:
        'Pull remote S3 objects into the local cache index and rebuild the in-memory vector index. ' +
        'Returns the number of entries pulled. Run after configuring the bucket or when results look stale.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            result: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                pulled: { type: 'integer', required: true },
                updatedAt: { type: 'string', required: true },
                error: { type: 'string' },
              },
              required: true,
            },
          },
        },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_sync: ${value.result.ok ? 'ok' : 'failed'} — pulled ${value.result.pulled} entrie(s) at ${value.result.updatedAt}${value.result.error ? ` (${value.result.error})` : ''}`)
            : renderText(`memory_s3_sync failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.sync();
          return { ok: true, result };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_status',
      description:
        'Return plugin status: configured (credentials present), sync state (lastSync/ok/error), cached entry count, ' +
        'embedder provider, and cache directory.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            status: {
              type: 'object',
              additionalProperties: false,
              properties: {
                configured: { type: 'boolean', required: true },
                sync: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    lastSync: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                    ok: { type: 'boolean', required: true },
                    error: { type: 'string' },
                  },
                  required: true,
                },
                cachedEntries: { type: 'integer', required: true },
                embedder: { type: 'string', required: true },
                cacheDir: { type: 'string', required: true },
              },
              required: true,
            },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return renderText(`memory_s3_status failed: ${value.error.code}: ${value.error.message}`);
          const s = value.status;
          const lines = [
            `configured: ${s.configured}`,
            `sync: ${s.sync.ok ? 'ok' : 'failed'} (lastSync ${s.sync.lastSync ?? 'never'}${s.sync.error ? `, ${s.sync.error}` : ''})`,
            `cachedEntries: ${s.cachedEntries}`,
            `embedder: ${s.embedder}`,
            `cacheDir: ${s.cacheDir}`,
          ];
          return renderText(`memory_s3_status\n${lines.join('\n')}`);
        },
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          return { ok: true, status: service.status() };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),
  ];
}

/**
 * 插件挂载。enabled:false → 整体 return（工具/服务/注入/审批 answerer 全部消失）。
 * 加载期校验（SECURITY.md §7）：bucket 非空、endpoint 协议、数值范围——非法响亮抛错。
 * 凭据缺失 → WARN + configured:false（插件仍加载，读走缓存/空）。
 */
export function apply(ctx, config = {}) {
  const resolved = {
    enabled: config.enabled ?? true,
    bucket: config.bucket ?? '',
    prefix: config.prefix ?? 'dsh-memory-s3',
    endpoint: config.endpoint ?? '',
    region: config.region ?? 'us-east-1',
    accessKeyEnv: config.accessKeyEnv ?? 'AWS_ACCESS_KEY_ID',
    secretKeyEnv: config.secretKeyEnv ?? 'AWS_SECRET_ACCESS_KEY',
    sessionTokenEnv: config.sessionTokenEnv ?? 'AWS_SESSION_TOKEN',
    writePolicy: config.writePolicy ?? 'ask',
    snapshotOrder: config.snapshotOrder ?? -50,
    maxInjectedItems: config.maxInjectedItems ?? 5,
    importanceThreshold: config.importanceThreshold ?? 3,
    embedder: {
      provider: config.embedder?.provider ?? 'none',
      endpoint: config.embedder?.endpoint ?? '',
      apiKeyEnv: config.embedder?.apiKeyEnv ?? 'OPENAI_API_KEY',
      model: config.embedder?.model ?? 'text-embedding-3-small',
      dimensions: config.embedder?.dimensions ?? 768,
    },
    cacheDir: config.cacheDir ?? '',
    auditRetentionDays: config.auditRetentionDays ?? 0,
  };
  if (resolved.enabled === false) return;

  if (typeof resolved.bucket !== 'string' || resolved.bucket === '') {
    throw invalidConfig('bucket must be a non-empty string');
  }
  if (!['ask', 'auto', 'off'].includes(resolved.writePolicy)) {
    throw invalidConfig(`writePolicy must be ask|auto|off (got ${JSON.stringify(resolved.writePolicy)})`);
  }
  if (!Number.isFinite(resolved.snapshotOrder)) throw invalidConfig('snapshotOrder must be a finite number');
  if (!Number.isInteger(resolved.maxInjectedItems) || resolved.maxInjectedItems <= 0) {
    throw invalidConfig('maxInjectedItems must be a positive integer');
  }
  if (!Number.isInteger(resolved.importanceThreshold) || resolved.importanceThreshold < 1 || resolved.importanceThreshold > 5) {
    throw invalidConfig('importanceThreshold must be an integer in [1,5]');
  }
  if (!Number.isInteger(resolved.auditRetentionDays) || resolved.auditRetentionDays < 0) {
    throw invalidConfig('auditRetentionDays must be a non-negative integer');
  }
  if (resolved.endpoint !== '') {
    if (!/^https?:\/\//.test(resolved.endpoint)) {
      throw invalidConfig(`endpoint must start with https:// (or http:// for local MinIO only): ${resolved.endpoint}`);
    }
    if (resolved.endpoint.startsWith('http://')) {
      console.warn('[memory-s3] endpoint uses http:// — plaintext transport, local MinIO only (SECURITY.md §5)');
    }
  }

  // 凭据探测（SECURITY.md §2）：仅环境变量，绝不落盘/入审计。
  const accessKey = process.env[resolved.accessKeyEnv] ?? '';
  const secretKey = process.env[resolved.secretKeyEnv] ?? '';
  const sessionToken = process.env[resolved.sessionTokenEnv] ?? '';
  const configured = accessKey !== '' && secretKey !== '';
  if (!configured) {
    console.warn(
      `[memory-s3] credentials missing (${resolved.accessKeyEnv}/${resolved.secretKeyEnv}); ` +
        'plugin loads with reads-only/empty cache — status().configured=false',
    );
  }

  // 组装依赖（Provider 面）。
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness');
  const cacheDir = resolved.cacheDir !== '' ? resolved.cacheDir : join(home, 'dsh-memory-s3', 'cache');
  const s3 = createS3Store({
    endpoint: resolved.endpoint !== '' ? resolved.endpoint : `https://s3.${resolved.region}.amazonaws.com`,
    region: resolved.region,
    bucket: resolved.bucket,
    prefix: resolved.prefix,
    accessKey,
    secretKey,
    sessionToken,
  });
  const cache = createCache({ dir: cacheDir });
  const audit = createAudit({ dir: cacheDir, retentionDays: resolved.auditRetentionDays });
  const embedder = createEmbedder({
    provider: resolved.embedder.provider,
    endpoint: resolved.embedder.endpoint,
    apiKey: process.env[resolved.embedder.apiKeyEnv] ?? '',
    model: resolved.embedder.model,
    dimensions: resolved.embedder.dimensions,
  });
  const service = new MemoryS3Service({
    s3,
    cache,
    audit,
    embedder,
    approval: ctx.approval,
    config: {
      writePolicy: resolved.writePolicy,
      importanceThreshold: resolved.importanceThreshold,
      maxInjectedItems: resolved.maxInjectedItems,
      cacheDir,
      configured,
    },
  });

  ctx.provide('memoryS3', service);
  ctx.effect(() => () => {
    // dispose：S3 客户端无连接句柄；cache/audit 为文件追加式，无资源需显式关闭。骨架无操作。
  });

  // 审批 answerer：只认领本插件写请求（toolName 前缀 + reason 带 [dsh-memory-s3]）。
  // auto → 直接放行；off → 直接拒绝；ask → 交下游（UI）answerer。prepend 保证确定性先于 UI。
  ctx.on(
    'approval/request',
    async function answerer(req, next) {
      const toolName = req?.toolName;
      const reason = req?.reason;
      const ours = typeof toolName === 'string' && toolName.startsWith(TOOL_PREFIX) && isOwnReason(reason);
      if (!ours) return next();
      if (resolved.writePolicy === 'auto') return 'allowed-once';
      if (resolved.writePolicy === 'off') return 'rejected';
      return next(); // ask：交给 UI answerer 裁决
    },
    { prepend: true },
  );

  for (const tool of makeMemoryTools(service)) {
    ctx.tools.register(tool);
  }

  // 冻结快照注入：会话首个 assemble 时同步渲染（text 回调内禁止 await），WeakMap 按
  // Session 冻结——会话内快照文本不变（ARCHITECTURE.md D3）。快照同时落 audit 行
  // （S2 可重建链的本地一链，同步 append 不违反同步提供者约束）。
  const snapshots = new WeakMap();
  ctx.systemPrompt.section({
    name: 'dsh-memory-s3:memory',
    order: resolved.snapshotOrder,
    text: (assemble) => {
      const agent = assemble?.agent;
      const session = agent?.session;
      if (session === undefined || session === null) return '';
      let frozen = snapshots.get(session);
      if (frozen === undefined) {
        frozen = service.snapshotText();
        snapshots.set(session, frozen);
        audit.append('snapshot', {
          text: frozen,
          outcome: 'ok',
          sessionId: session.id ?? null,
        });
      }
      return frozen;
    },
  });

  // 会话事件观察（骨架阶段）：turn/end 且缓存为空 → 触发一次后台 sync（fire-and-forget，
  // 失败仅告警不阻塞会话）。不 append 任何自定义事件类型（rc.6 已知类型门）。
  ctx.on('session/event', (session, event) => {
    const record = event;
    if (record === null || typeof record !== 'object') return;
    if (record.type !== 'turn/end') return;
    if (cache.listLocalIds().length > 0) return; // 已有缓存，不自动全量同步
    void service
      .sync()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[memory-s3] background sync failed: ${message}`);
      });
  });
}
