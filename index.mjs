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
// - 「装了但没配」必须能启动：bucket 缺失只待机 + 告警，绝不抛错。抛错会让 cordis 加载器
//   判定条目失败并拖垮整个 profile，用户连 GUI 都进不去，也就无从配置 bucket（死锁）。
// - 配置文件三层解析（@deepseek-ai/dsh-settings 契约）：schema 默认 → entry config(base) →
//   用户设置段。ctx.settings 为可选服务，未挂载/注册失败均无痕回退 entry config；
//   挂载晚于本插件时经 ctx.inject 子 fiber 补注册（否则命名空间丢失 → GUI 无设置页）。
// - 附件（照片/文件）能力：entries 元数据 + files/{id} 二进制对象（不可变、If-None-Match、
//   sha256 校验）；本地读取经 lib/filemeta.mjs 白名单+魔法字节+大小三层防护；
//   附件二进制不进审批 reason/审计（只进元数据摘要），文本类附件内容过秘密检测。
// - 函数调用日志（dev-preset quality_standards.function_tracing）：开发/验证阶段经
//   DSH_MEMORY_S3_DEBUG 开启（trace 级 console.debug，JSON 结构化、敏感脱敏），
//   生产默认关闭。

import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createS3Store } from './lib/s3store.mjs';
import { createEmbedder } from './lib/embedder.mjs';
import {
  normalizeEntry,
  fromJSON,
  toJSON,
  sameTitle,
  detectEntrySecrets,
  detectSecret,
  normalizeAttachment,
  TYPES,
} from './lib/entry.mjs';
import {
  probeFile,
  formatBytes,
  extensionOf,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_ALLOWED_EXTENSIONS,
  TEXT_EXTENSIONS,
} from './lib/filemeta.mjs';
import { bruteForceTopK } from './lib/vector.mjs';
import { createCache } from './lib/cache.mjs';
import { createAudit } from './lib/audit.mjs';
import { createBacklinks } from './lib/backlinks.mjs';
import { buildWriteReason, isOwnReason } from './lib/gate.mjs';
import { strings } from './lib/strings.mjs';

export const name = 'memory-s3';

/**
 * 只声明必需服务。settings 刻意不进这里：cordis 的 inject 是**阻塞式**的
 * （Fiber._refresh：任一 inject 服务缺失 → epoch=INACTIVE → 永不 apply），
 * 把可选服务写进去会让未挂载 settings 的 profile 整个插件不启动。
 * settings 的时序问题改由 apply() 内的 ctx.inject(['settings'], …) 子 fiber 解决。
 */
export const inject = ['tools', 'systemPrompt', 'approval'];

/** 工具名前缀（approval answerer 认领与工具注册共用）。 */
const TOOL_PREFIX = 'memory_s3_';

/** 领域错误码（工具层转为 {ok:false, error:{code,message}}；其余视为基础设施错误抛出）。 */
const DOMAIN_CODES = new Set([
  'INVALID_INPUT',
  'NOT_FOUND',
  'SECRET_DETECTED',
  'DENIED',
  'CONFLICT',
  'FILE_NOT_FOUND',
  'FILE_TOO_LARGE',
  'UPLOAD_REJECTED',
  'CORRUPT_FILE',
]);

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

/** 摘要帧：工具 render 的 content block 形状（dsh-tools 约定）。 */
function renderText(text) {
  return [{ type: 'text', text }];
}

/** links 清洗：string 化、去空、去自引用、去重（normalizeEntry 与 update patch 共用语义）。 */
function sanitizeLinks(links, selfId) {
  if (!Array.isArray(links)) {
    throw domainError('INVALID_INPUT', 'links must be an array of entry id strings');
  }
  const seen = new Set();
  const out = [];
  for (const raw of links) {
    const link = String(raw).trim();
    if (link === '' || link === selfId || seen.has(link)) continue;
    seen.add(link);
    out.push(link);
  }
  return out;
}

/**
 * 插件配置（Schemastery，对齐 README.md 配置表；cordis loader 已套默认值，
 * apply 内再显式补默认——与 Config 同源）。
 * embedder.provider 默认 'none'（零配置可用，search 关键词不依赖嵌入）；要启用
 * 向量召回再显式配置 provider/endpoint/apiKeyEnv。
 *
 * bucket 刻意不用 .required()：cordis loader 在 apply() 之前就对 entry config 跑
 * schema 校验，而 bundle 自带的 cordis.patch.yml 不带 config，必填会让校验抛
 * "$.bucket missing required value" 并拖垮整个 profile 启动（连 GUI 都进不去），
 * 用户也就永远没有机会在设置页里填这个值。必填语义下移到 apply()：仅当
 * enabled 为 true 时才要求 bucket 非空，未配置时插件保持存活并降级待机。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  bucket: Schema.string().default(''),
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
  maxFileBytes: Schema.number().default(DEFAULT_MAX_FILE_BYTES),
  allowedFileTypes: Schema.array(Schema.string()).default(DEFAULT_ALLOWED_EXTENSIONS),
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
    /** 反链索引（links 入边镜像，本地持久化；MODEL.md §6 L1）。 */
    this.backlinks = deps.backlinks;
    /** 附件上限与类型白名单（apply 层 resolved 传入；filemeta 默认兜底）。 */
    this.maxFileBytes = Number.isFinite(deps.config.maxFileBytes) && deps.config.maxFileBytes > 0
      ? deps.config.maxFileBytes
      : DEFAULT_MAX_FILE_BYTES;
    this.allowedFileTypes = Array.isArray(deps.config.allowedFileTypes) && deps.config.allowedFileTypes.length > 0
      ? deps.config.allowedFileTypes
      : DEFAULT_ALLOWED_EXTENSIONS;
  }

  // ── 写路径 ────────────────────────────────────────────────────────────────

  /**
   * 新增条目（审批门 + 去重合并）。
   * 同 (type, title) 已存在 → merged（走 update 审批，载荷含新旧全文）；
   * 否则 created（If-None-Match: * 条件创建）。
   * input.attachments = [{path, note}]：本地文件探测 → 审批后上传 files/{id} →
   * 条目 attachments 元数据挂载。附件对象不可变（uuid 键 + If-None-Match + sha256）。
   */
  async save(input, write) {
    this.#assertAgent(write);
    const t0 = Date.now();
    const workspaceKey = typeof input.workspaceKey === 'string' ? input.workspaceKey : this.#workspaceKeyOf(write);
    const agentKey = typeof input.agentKey === 'string' ? input.agentKey : this.#agentKeyOf(write);

    // 1. 附件探测（本地读+三层校验；失败早失败，零 S3 副作用）。
    const files = await this.#probeAttachments(input.attachments);
    // 2. 构造条目（附件元数据挂入）。
    const entry = normalizeEntry(
      { ...input, ...(files.length > 0 ? { attachments: files.map((f) => f.meta) } : {}) },
      { workspaceKey, agentKey },
    );
    this.#assertNoSecrets(entry);
    this.#trace('save', { type: entry.type, title: entry.title, attachments: files.length, ms: Date.now() - t0 });

    // 3. 去重合并且带附件 → 合并路径（附件在审批后统一上传）。
    const existing = this.#findByTitle(entry.type, entry.title);
    if (existing !== null) {
      return this.#mergeWithAttachments(existing, entry, files, write);
    }
    // 查重未命中但缓存可能未同步（清缓存/首次启动未预热）→ 远端预检同 type 前缀，
    // 防「S3 已有同 title 对象而本地缓存无」时创建重复条目（真实场景验证暴露）。
    if (this.cache.listDiskIds().length === 0) {
      const remoteSame = await this.#findRemoteByTitle(entry.type, entry.title);
      if (remoteSame !== null) {
        return this.#mergeWithAttachments(remoteSame, entry, files, write);
      }
    }

    // 4. created 路径：嵌入 → 审批（reason 含附件元数据摘要）→ 上传附件 → 落条目。
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
      ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
      ...(entry.timeline !== undefined ? { timeline: entry.timeline } : {}),
      ...(Array.isArray(entry.links) && entry.links.length > 0 ? { links: entry.links } : {}),
      ...(entry.locked ? { locked: true } : {}),
      ...(entry.attachments !== undefined ? { attachments: this.#attachmentSummary(entry.attachments) } : {}),
    }, write);
    this.#throwIfAborted(write);

    const key = this.s3.keyOf(entry.type, entry.id);
    try {
      await this.#uploadAttachments(files);
      await this.s3.putObject(key, JSON.stringify(toJSON(entry)), { ifNoneMatch: '*' });
    } catch (error) {
      // 预检未发现但远端已存在（多实例并发/缓存过期）：读回远端条目。
      // 同 title 则合并（再走一次 update 审批，披露新旧全文）；否则亮 CONFLICT——
      // 不同内容撞 id 绝不静默覆盖（乐观并发语义，ARCHITECTURE.md D6）。
      if (error?.code === 'CONFLICT') {
        const remote = await this.#readRemoteByType(entry.type, entry.id);
        if (remote !== null && sameTitle(remote, entry) && !remote.locked) {
          await this.#cleanupUploaded(files); // 合并路径会重传/重用：清理本次孤儿，避免重复对象
          return this.#mergeWithAttachments(remote, entry, files, write);
        }
      }
      await this.#cleanupUploaded(files); // 尽力回滚已上传附件（best-effort，S3 DELETE 幂等）
      throw error;
    }
    this.cache.putEntry(entry.id, entry);
    this.backlinks?.addForward(entry.id, entry.links); // 反链索引：写正向链接，自动回填入边
    this.#auditWrite('save', entry, write, { attachments: entry.attachments?.length ?? 0 });
    this.#trace('save:ok', { id: entry.id, ms: Date.now() - t0 });
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
    // 同步清本地缓存（内存+磁盘）：否则磁盘残留会在新进程回源时复活（真实场景验证暴露）。
    this.cache.deleteEntry(existing.id);
    this.backlinks?.removeForward(existing.id); // 反链：清空该条目的出链（入边保留——悬空引用渲染容错）
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

  // ── 附件路径（照片/文件，审批门同样不可绕过） ────────────────────────────

  /**
   * 给已有条目挂附件（审批门）。流程：探测本地文件（三层校验）→ 审批（reason 含附件
   * 元数据）→ 上传 files/{id}（If-None-Match）→ 条目 attachments 追加（If-Match
   * 乐观锁）→ 审计。失败尽力回滚已上传对象。
   */
  async attach(entryId, fileInput, write) {
    this.#assertAgent(write);
    const t0 = Date.now();
    const existing = this.cache.getEntry(entryId);
    if (existing === null) {
      throw domainError('NOT_FOUND', `entry ${entryId} not found in cache; run memory_s3_sync first`);
    }
    const probed = await this.#probeAttachment(fileInput);
    const attachment = probed.meta;
    const next = {
      ...existing,
      attachments: [...(existing.attachments ?? []), attachment],
      updatedAt: Date.now(),
    };
    this.#trace('attach', {
      entryId,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      ms: Date.now() - t0,
    });
    await this.#askApproval({
      action: 'attach',
      id: existing.id,
      type: existing.type,
      title: existing.title,
      attachment: this.#attachmentSummary([attachment])[0],
    }, write);
    this.#throwIfAborted(write);

    try {
      // 附件不可变对象：uuid key + If-None-Match（同 id 重复上传不可能；撞键即配置异常）。
      await this.s3.putObject(attachment.objectKey, probed.bytes, {
        contentType: attachment.mime,
        ifNoneMatch: '*',
      });
      await this.#putEntryConditional(next);
    } catch (error) {
      await this.#cleanupUploaded([probed]);
      throw error;
    }
    this.cache.putEntry(next.id, next);
    this.#auditWrite('attach', next, write, {
      attachmentId: attachment.id,
      attachmentName: attachment.name,
    });
    this.#trace('attach:ok', { entryId, attachmentId: attachment.id, ms: Date.now() - t0 });
    return { entry: next, attachment };
  }

  /**
   * 移除附件（审批门）：删 files/{id} 对象 + 条目元数据移除（If-Match）。
   * 文件对象删除成功才更新条目——二者保持引用一致（重试可恢复）。
   */
  async detach(entryId, attachmentId, write) {
    this.#assertAgent(write);
    const t0 = Date.now();
    const existing = this.cache.getEntry(entryId);
    if (existing === null) {
      throw domainError('NOT_FOUND', `entry ${entryId} not found in cache; run memory_s3_sync first`);
    }
    const attachment = (existing.attachments ?? []).find((a) => a.id === attachmentId);
    if (attachment === undefined) {
      throw domainError('NOT_FOUND', `attachment ${attachmentId} not found on entry ${entryId}`);
    }
    const next = {
      ...existing,
      attachments: existing.attachments.filter((a) => a.id !== attachmentId),
      updatedAt: Date.now(),
    };
    this.#trace('detach', { entryId, attachmentId, ms: Date.now() - t0 });
    await this.#askApproval({
      action: 'detach',
      id: existing.id,
      type: existing.type,
      title: existing.title,
      attachment: this.#attachmentSummary([attachment])[0],
    }, write);
    this.#throwIfAborted(write);

    await this.s3.deleteObject(attachment.objectKey); // S3 DELETE 幂等；失败 → 抛，条目不更新（保持一致）
    await this.#putEntryConditional(next, { requireRemote: true });
    this.cache.putEntry(next.id, next);
    this.#auditWrite('detach', next, write, {
      attachmentId: attachment.id,
      attachmentName: attachment.name,
    });
    this.#trace('detach:ok', { entryId, attachmentId, ms: Date.now() - t0 });
    return { entry: next, attachment };
  }

  /**
   * 下载附件到本地（读路径，无审批）：S3 拉取（binary）→ sha256 校验（防篡改/损坏）
   * → 写入 <cacheDir>/files/<id>.<ext> → 返回本地路径与元数据。校验失败 → CORRUPT_FILE
   * 拒绝落盘（损坏数据不落地，避免模型读到被投毒的文件）。
   * 无 dir 参数时写入插件缓存目录（跨进程可见、可复用）。
   */
  async getFile(entryId, attachmentId, { dir } = {}) {
    const t0 = Date.now();
    const existing = this.cache.getEntry(entryId);
    if (existing === null) {
      throw domainError('NOT_FOUND', `entry ${entryId} not found in cache; run memory_s3_sync first`);
    }
    const attachment = (existing.attachments ?? []).find((a) => a.id === attachmentId);
    if (attachment === undefined) {
      throw domainError('NOT_FOUND', `attachment ${attachmentId} not found on entry ${entryId}`);
    }
    this.#trace('getFile', { entryId, attachmentId, ms: Date.now() - t0 });
    const obj = await this.s3.getObject(attachment.objectKey, { binary: true });
    if (obj === null) {
      throw domainError('NOT_FOUND', `attachment object ${attachment.objectKey} missing on remote (entry metadata exists but file object does not)`);
    }
    const sha = createHash('sha256').update(obj.body).digest('hex');
    if (sha !== attachment.sha256) {
      throw domainError('CORRUPT_FILE', `attachment ${attachmentId} sha256 mismatch (expected ${attachment.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…) — object corrupted or tampered`);
    }
    const targetDir = typeof dir === 'string' && dir !== '' ? dir : join(this.config.cacheDir, 'files');
    await mkdir(targetDir, { recursive: true });
    const ext = extensionOf(attachment.name);
    const filePath = join(targetDir, `${attachment.id}${ext ? `.${ext}` : ''}`);
    await writeFile(filePath, obj.body, { mode: 0o600 });
    this.audit.append('file-retrieved', {
      entryId,
      attachmentId,
      name: attachment.name,
      size: attachment.size,
      outcome: 'ok',
    });
    this.#trace('getFile:ok', { filePath, bytes: obj.body.length, ms: Date.now() - t0 });
    return { attachment, path: filePath, size: obj.body.length };
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
   * 反链查询（读路径，无审批）：返回引用了该条目 id 的条目列表（MODEL.md §6 L1——
   * 写正向 links 时本地索引自动回填入边）。悬空目标（不存在于缓存）跳过——容错。
   */
  linkedTo(entryId) {
    if (typeof entryId !== 'string' || entryId === '') {
      throw domainError('INVALID_INPUT', 'linkedTo requires a non-empty entry id');
    }
    const sources = this.backlinks?.getBacklinks(entryId) ?? [];
    const entries = [];
    for (const id of sources) {
      if (this.deleted.has(id)) continue;
      const entry = this.#readCachedEntry(id);
      if (entry !== null) entries.push(entry);
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return { entries, total: entries.length, stale: this.cache.isStale() };
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
      .map((id) => this.#readCachedEntry(id))
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
      cachedEntries: this.cache.listDiskIds().length,
      embedder: this.embedder.name,
      cacheDir: this.config.cacheDir,
    };
  }

  /**
   * 冻结快照渲染（systemPrompt 提供者专用：同步、无 await、只读内存缓存）。
   * 投影 = 分层注入（MODEL.md §8）：Bonds（locked 或 importance≥5 约定）恒前 →
   * Moments（时刻按新近）→ Facts（知识按重要性，同分按图中心性/被引用数）。
   * 排除 forgotten/deleted；无缓存返回 strings.notSynced 提示。
   */
  snapshotText() {
    const index = this.cache.getIndex();
    const all = this.#filterEntries({});
    const total = all.length;
    if (total === 0) return this.text.notSynced;
    const counts = this.backlinks?.allCounts() ?? new Map();
    const visible = all.filter((e) => !this.forgotten.has(e.id));
    const cap = this.config.maxInjectedItems;

    // 分层三桶（仅收集 importance ≥ threshold 的注入候选；locked 无论如何入选——
    // 约定类记忆是守护型，永不沉底）。
    const bonds = visible
      .filter((e) => e.locked === true || (e.type === 'preference' && e.importance >= 5))
      .sort((a, b) => b.importance - a.importance || (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
    const moments = visible
      .filter((e) => e.type === 'moment' && !bonds.includes(e))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const facts = visible
      .filter((e) => !bonds.includes(e) && !moments.includes(e) && e.importance >= this.config.importanceThreshold)
      .sort((a, b) => b.importance - a.importance || (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));

    // 按层填充预算：Bonds 保底（占 40% 或至少 1 条），余量给 Moments → Facts。
    const bondCap = Math.max(1, Math.ceil(cap * 0.4));
    const selected = [
      ...bonds.slice(0, Math.min(bondCap, bonds.length)),
      ...moments.slice(0, Math.max(0, cap - Math.min(bondCap, bonds.length))),
    ];
    const used = selected.length;
    if (used < cap) selected.push(...facts.slice(0, cap - used));

    const lastSync = index?.lastSync ?? 'never';
    const header = this.text.snapshotHeader({ count: selected.length, total, lastSync });
    const lines = selected.map((e) => {
      const att =
        Array.isArray(e.attachments) && e.attachments.length > 0
          ? ` 📎${e.attachments.map((a) => a.name).join(', ').slice(0, 48)}`
          : '';
      const linkMark =
        Array.isArray(e.links) && e.links.length > 0
          ? ` →关联${e.links.length}`
          : '';
      return `- [${e.type}] ${e.title}: ${snippet(e.content)}${att}${linkMark}`;
    });
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

  /**
   * 读路径的归一化取条目：缓存可能由更早版本插件写入（缺 v2.1 之后的 locked 等
   * 必需字段），直接原样返回会让工具输出校验失败（ENRY_OUTPUT 声明 locked required）。
   * fromJSON 幂等且补齐默认（locked→false 等），保证任何读路径产物满足输出 schema。
   */
  #readCachedEntry(id) {
    const raw = this.cache.getEntry(id);
    if (raw === null) return null;
    try {
      return fromJSON(raw);
    } catch {
      // 单条损坏不炸读路径：跳过（与 sync 的「账本可重建性优先」哲学一致）。
      return null;
    }
  }

  /** 过滤 + updatedAt 倒序排序的缓存条目全量（search/list/recall/快照共用语义）。 */
  #filterEntries(filter = {}) {
    const text = typeof filter.text === 'string' && filter.text !== '' ? filter.text.toLowerCase() : '';
    const type = filter.type;
    const tags =
      Array.isArray(filter.tags) && filter.tags.length > 0 ? filter.tags.map((t) => String(t).toLowerCase()) : null;
    const importanceMin = filter.importanceMin;
    const out = [];
    // 磁盘+内存并集遍历：跨进程时热层为空，磁盘条目必须可读（快照/检索的持久化基础）。
    const ids = new Set([...this.cache.listDiskIds(), ...this.cache.listLocalIds()]);
    for (const id of ids) {
      if (this.deleted.has(id)) continue;
      const entry = this.#readCachedEntry(id);
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

  /** 同 (type, title) 去重预检（区分大小写，entry.mjs sameTitle 语义）。locked 条目跳过——不可触碰。 */
  #findByTitle(type, title) {
    const ids = new Set([...this.cache.listDiskIds(), ...this.cache.listLocalIds()]);
    for (const id of ids) {
      if (this.deleted.has(id)) continue;
      const entry = this.cache.getEntry(id);
      if (entry !== null && entry.locked !== true && sameTitle(entry, { type, title })) return entry;
    }
    return null;
  }

  /**
   * 合并更新实现（save 的 merged 路径与 update 共用）：秘密检测 → 嵌入 → 审批 → 条件写。
   * 附件扩展： opts.attachmentsToAdd（已探测的元数据）→ 并入 next.attachments；
   * opts.pendingUploads（{meta,bytes}[]）→ 审批后先上传附件再落条目（approve-what-you-see：
   * 审批 reason 已含附件元数据摘要，二进制不进 reason）。
   */
  async #updateExisting(existing, patch, write, opts = {}) {
    const { attachmentsToAdd = [], pendingUploads = [] } = opts;
    const next = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      // type 迁移：patch.type 必须应用到 next（此前遗漏——迁移分支会对旧 key 自覆盖后自删，
      // 经测试断言暴露修正：新 key 按 next.type 计算 + 旧 key 删除）。
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
      // v2.1 模型字段：subject/timeline/links/locked 支持增量更新（links 替换语义）。
      // subject/timeline 空串 = 清除（缺省不落盘契约：undefined 在 toJSON 时被省略）。
      ...(patch.subject !== undefined ? { subject: patch.subject.trim() === '' ? undefined : patch.subject } : {}),
      ...(patch.timeline !== undefined ? { timeline: patch.timeline.trim() === '' ? undefined : patch.timeline } : {}),
      ...(patch.links !== undefined ? { links: sanitizeLinks(patch.links, existing.id) } : {}),
      ...(patch.locked !== undefined ? { locked: patch.locked === true } : {}),
      updatedAt: Date.now(),
    };
    if (attachmentsToAdd.length > 0) {
      // 附件合并：追加（不覆盖既有附件——同 title 合并语义是"补充内容"而非"替换"）。
      next.attachments = [...(existing.attachments ?? []), ...attachmentsToAdd];
    }
    this.#assertNoSecrets(next);
    if (next.content !== existing.content || next.title !== existing.title) await this.#tryEmbed(next);
    await this.#askApproval({
      action: 'update',
      id: existing.id,
      previous: {
        title: existing.title,
        content: existing.content,
        ...(existing.subject !== undefined ? { subject: existing.subject } : {}),
        ...(existing.timeline !== undefined ? { timeline: existing.timeline } : {}),
        ...(existing.links !== undefined ? { links: existing.links } : {}),
        ...(existing.locked ? { locked: true } : {}),
      },
      next: {
        title: next.title,
        content: next.content,
        ...(next.subject !== undefined ? { subject: next.subject } : {}),
        ...(next.timeline !== undefined ? { timeline: next.timeline } : {}),
        ...(Array.isArray(next.links) && next.links.length > 0 ? { links: next.links } : {}),
        ...(next.locked ? { locked: true } : {}),
      },
      type: next.type,
      tags: next.tags,
      importance: next.importance,
      ...(attachmentsToAdd.length > 0
        ? { attachmentsToAdd: this.#attachmentSummary(attachmentsToAdd) }
        : {}),
    }, write);
    this.#throwIfAborted(write);

    try {
      if (pendingUploads.length > 0) await this.#uploadAttachments(pendingUploads);
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
    } catch (error) {
      await this.#cleanupUploaded(pendingUploads); // 尽力回滚本次已上传附件（勿伤已有引用）
      throw error;
    }
    this.cache.putEntry(next.id, next);
    this.backlinks?.addForward(next.id, next.links); // 反链随链接改动自动刷新（替换语义）
    this.#auditWrite('update', next, write, { previousId: existing.id });
    return { previous: existing, entry: next };
  }

  /** save 合并路径的统一入口：带附件 → 走 #updateExisting 附件扩展；不带 → 原样合并。 */
  async #mergeWithAttachments(existing, entry, files, write) {
    const patch = {
      content: entry.content,
      tags: entry.tags,
      importance: entry.importance,
    };
    if (files.length === 0) {
      const { entry: merged } = await this.#updateExisting(existing, patch, write);
      return { action: 'merged', entry: merged };
    }
    // 去重合并：新探测的附件作为 addition 合并；旧附件保留。
    const existingIds = new Set((existing.attachments ?? []).map((a) => a.id));
    const additions = files.filter((f) => !existingIds.has(f.meta.id));
    const { entry: merged } = await this.#updateExisting(existing, patch, write, {
      attachmentsToAdd: additions.map((f) => f.meta),
      pendingUploads: additions,
    });
    return { action: 'merged', entry: merged };
  }

  // ── 附件辅助 ──────────────────────────────────────────────────────────────

  /** 探测多附件（save 的 attachments 数组；空/缺失 → []）。单个失败整体失败（早失败）。 */
  async #probeAttachments(attachments) {
    if (attachments === undefined || attachments === null) return [];
    if (!Array.isArray(attachments)) {
      throw domainError('INVALID_INPUT', 'attachments must be an array of {path, note?}');
    }
    const out = [];
    for (const item of attachments) {
      out.push(await this.#probeAttachment(item));
    }
    return out;
  }

  /**
   * 探测单附件：lib/filemeta 三层校验（白名单/魔法字节/大小）+ 文本类内容秘密检测 →
   * 构造不可变元数据（uuid id、files/{id} key、sha256）。零网络副作用。
   */
  async #probeAttachment(input) {
    if (input === null || typeof input !== 'object' || typeof input.path !== 'string' || input.path === '') {
      throw domainError('INVALID_INPUT', 'attachment requires a non-empty path');
    }
    const probed = await probeFile(input.path, {
      maxBytes: this.maxFileBytes,
      allowedExtensions: this.allowedFileTypes,
    });
    // 文本类附件内容过秘密检测（二进制跳过——无法文本扫描，安全披露见 docs/SECURITY.md）。
    if (TEXT_EXTENSIONS.has(probed.extension)) {
      const hit = detectSecret(probed.bytes.toString('utf8'));
      if (hit !== null) {
        throw domainError('SECRET_DETECTED', `attachment "${probed.name}" content contains secret-like content (${hit.pattern})`);
      }
    }
    const id = randomUUID();
    const meta = normalizeAttachment({
      id,
      name: probed.name,
      mime: probed.mime,
      kind: probed.kind,
      size: probed.size,
      sha256: probed.sha256,
      objectKey: this.s3.fileKeyOf(id),
      ...(typeof input.note === 'string' && input.note !== '' ? { note: input.note } : {}),
    });
    return { meta, bytes: probed.bytes };
  }

  /** 上传附件对象（If-None-Match 条件创建；撞键 = 配置异常，抛 CONFLICT）。 */
  async #uploadAttachments(files) {
    for (const f of files) {
      await this.s3.putObject(f.meta.objectKey, f.bytes, {
        contentType: f.meta.mime,
        ifNoneMatch: '*',
      });
    }
  }

  /** 尽力回滚已上传附件（S3 DELETE 幂等；失败静默——孤儿对象无害且审计可查）。 */
  async #cleanupUploaded(files) {
    for (const f of files) {
      try {
        await this.s3.deleteObject(f.meta.objectKey);
        this.audit.append('attachment-rollback', { objectKey: f.meta.objectKey, outcome: 'ok' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.audit.append('attachment-rollback', { objectKey: f.meta.objectKey, outcome: 'failed', error: message });
      }
    }
  }

  /** 条目条件写（If-Match 乐观锁；远端缺失时报错而非覆盖）。attach/detach 共用。 */
  async #putEntryConditional(entry, { requireRemote = true } = {}) {
    const key = this.s3.keyOf(entry.type, entry.id);
    const head = await this.s3.headObject(key);
    if (head === null) {
      if (!requireRemote) return; // 创建性写入不要求远端已存在
      throw domainError('NOT_FOUND', `entry ${entry.id} not found on remote; run memory_s3_sync and retry`);
    }
    await this.s3.putObject(key, JSON.stringify(toJSON(entry)), { ifMatch: head.etag });
  }

  /** 附件元数据摘要（审批 reason / 审计用；不含二进制，仅身份信息）。 */
  #attachmentSummary(attachments) {
    return attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mime: a.mime,
      kind: a.kind,
      size: a.size,
      sha256: a.sha256.slice(0, 12),
    }));
  }

  /** 函数调用日志（dev-preset function_tracing，trace 级）：DSH_MEMORY_S3_DEBUG 门控，JSON 结构化。 */
  #trace(fn, fields) {
    if (!process.env.DSH_MEMORY_S3_DEBUG) return;
    console.debug(`[memory-s3:${fn}]`, JSON.stringify({ fn, ...fields }));
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

  /** 远端预检：列出同 type 前缀（memories/<type>/），匹配 (type, title) 返回首个条目。 */
  async #findRemoteByTitle(type, title) {
    try {
      let token;
      do {
        const page = await this.s3.listObjects({ prefix: `memories/${type}/`, continuationToken: token });
        for (const item of page.keys) {
          // item.key 形如 [<prefix>/]memories/<type>/<id>.json → 提取 id（兼容有无前导斜杠）。
          const match = /(?:^|\/)memories\/[^/]+\/([^/]+)\.json$/.exec(item.key);
          if (match === null) continue;
          const remote = await this.#readRemoteByType(type, match[1]);
          if (remote !== null && remote.locked !== true && sameTitle(remote, { type, title })) return remote;
        }
        token = page.nextToken;
      } while (token !== undefined);
    } catch {
      // 预检失败不阻塞创建（远端不可达时降级为正常创建路径）。
      return null;
    }
    return null;
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
    subject: { type: 'string' },
    timeline: { type: 'string' },
    links: { type: 'array', items: { type: 'string' } },
    locked: { type: 'boolean', required: true },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          mime: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          size: { type: 'integer', required: true },
          sha256: { type: 'string', required: true },
          objectKey: { type: 'string', required: true },
          note: { type: 'string' },
          createdAt: { type: 'integer', required: true },
        },
      },
    },
  },
};

const ENTRY_LIST_OUTPUT = {
  type: 'array',
  items: ENTRY_OUTPUT,
};

/**
 * 条目公开投影：从返回给模型/工具层的条目中剔除仅供内部向量召回用的 embedding 字段
 * （对齐 ENTRY_OUTPUT 的「不含 embedding 向量」声明；768 维浮点不入模型上下文）。
 * 返回浅拷贝，不污染内部缓存条目（内部向量路径仍可取到嵌入向量）。
 */
function toPublicEntry(entry) {
  if (entry === null || typeof entry !== 'object') return entry;
  const { embedding, ...rest } = entry;
  return rest;
}

/** 附件元数据输出投影（attach/get_file/detach 的 attachment 字段；字段集对齐 types.d.ts）。 */
const ENTRY_ATTACHMENT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    mime: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    size: { type: 'integer', required: true },
    sha256: { type: 'string', required: true },
    objectKey: { type: 'string', required: true },
    note: { type: 'string' },
    createdAt: { type: 'integer', required: true },
  },
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
  total: { type: 'integer' },
  stale: { type: 'boolean' },
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
        'type ∈ preference|project|decision|history|moment. Deduplicates by (type, title): an existing entry with ' +
        'the same type and title is merged via an update approval carrying both old and new text.',
      parameters: {
        type: { type: 'string', enum: TYPES, required: true, description: 'Entry type: preference|project|decision|history.' },
        title: { type: 'string', required: true, description: 'Short title; also the dedup key within a type.' },
        content: { type: 'string', required: true, description: 'Entry body text.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag strings.' },
        importance: { type: 'integer', description: 'Importance 1-5 (default 3); >= threshold enters snapshot injection.' },
        workspaceKey: { type: 'string', description: 'Explicit workspace key; default = session cwd.' },
        agentKey: { type: 'string', description: 'Explicit agent key; default = session agentPreset.' },
        subject: { type: 'string', description: 'Subject: who this memory is about — me | risu | us | world (or any string).' },
        timeline: { type: 'string', description: 'Timeline anchor: worldline/period, e.g. α-2 | β | steins-gate | 2026-08.' },
        links: { type: 'array', items: { type: 'string' }, description: 'Linked entry ids (reference-style links; backlinks auto-indexed locally).' },
        locked: { type: 'boolean', description: 'Lock the entry (default false): locked entries skip same-title auto-merge; explicit writes still pass approval.' },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true, description: 'Local file path to attach (PNG/JPG/GIF/WebP/PDF/ZIP/TXT/MD/JSON/CSV).' },
              note: { type: 'string', description: 'Optional note/description for the attachment.' },
            },
          },
          description: 'Optional local photo/file attachments. Validated (magic bytes + extension + size limit), uploaded to S3 as immutable objects; binary is never included in approval reasons (metadata+sha256 only).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            action: { type: 'string', enum: ['created', 'merged'] },
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
          return { ok: true, action: result.action, entry: toPublicEntry(result.entry) };
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
          return { ok: true, entries: result.entries.map(toPublicEntry), total: result.total, stale: result.stale };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_backlinks',
      description:
        'Backlink query (no approval; reads the local backlink index): returns entries whose links reference ' +
        'the given entry id — "who points at this memory". Written links auto-populate this index (MODEL.md §6).',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id to find backlinks for.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: QUERY_RESULT_PROPS },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_backlinks: ${value.total} backlink(s) → ${value.entries.map((e) => `[${e.type}] ${e.title}`).join(' | ') || '(none)'}`)
            : renderText(`memory_s3_backlinks failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = service.linkedTo(args.id);
          return { ok: true, entries: result.entries.map(toPublicEntry), total: result.total, stale: result.stale };
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
          return { ok: true, entries: result.entries.map(toPublicEntry), total: result.total, stale: result.stale };
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
          return { ok: true, entries: result.entries.map(toPublicEntry), total: result.total, stale: result.stale };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_update',
      description:
        'Update one memory entry by id (approval-gated; the approval reason carries the full old and new text). ' +
        'Supports title/content/tags/importance/type/subject/timeline/links/locked. Changing type migrates the S3 object key.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id (from save/search/list results).' },
        title: { type: 'string', description: 'New title.' },
        content: { type: 'string', description: 'New body text.' },
        type: { type: 'string', enum: TYPES, description: 'New type (migrates S3 key).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
        importance: { type: 'integer', description: 'New importance 1-5.' },
        subject: { type: 'string', description: 'New subject (empty string clears it).' },
        timeline: { type: 'string', description: 'New timeline anchor (empty string clears it).' },
        links: { type: 'array', items: { type: 'string' }, description: 'Replacement linked entry ids (references; backlinks auto-indexed).' },
        locked: { type: 'boolean', description: 'New locked flag (true = skip same-title auto-merge).' },
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
              subject: args.subject,
              timeline: args.timeline,
              links: args.links,
              locked: args.locked,
            },
            writeContextOf(exec),
          );
          return { ok: true, previous: toPublicEntry(result.previous), entry: toPublicEntry(result.entry) };
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
          return { ok: true, entry: toPublicEntry(result.entry) };
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
        render: (args, value) =>
          value.ok
            ? renderText(
                `memory_s3_forget: ${value.entry.id} injection ${args.forgotten === false ? 'restored' : 'suppressed'}`,
              )
            : renderText(`memory_s3_forget failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.forget(args.id, args.forgotten !== false);
          return { ok: true, entry: toPublicEntry(result.entry) };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_attach',
      description:
        'Attach a local photo/file to an existing memory entry (approval-gated). ' +
        'The file is validated (magic bytes + extension whitelist + size limit <=20MB), uploaded to S3 as an ' +
        'immutable object, and its metadata (name/mime/size/sha256) is appended to the entry. ' +
        'Attachments are listed in search/list results; download with memory_s3_get_file.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id from save/search/list results.' },
        path: { type: 'string', required: true, description: 'Local file path (PNG/JPG/GIF/WebP/PDF/ZIP/TXT/MD/JSON/CSV).' },
        note: { type: 'string', description: 'Optional note/description for the attachment.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            entry: ENTRY_OUTPUT,
            attachment: ENTRY_ATTACHMENT_OUTPUT,
          },
        },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_attach: +${value.attachment.name} (${value.attachment.kind}, ${formatBytes(value.attachment.size)}) → ${value.entry.id}`)
            : renderText(`memory_s3_attach failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.attach(args.id, { path: args.path, note: args.note }, writeContextOf(exec));
          return { ok: true, entry: toPublicEntry(result.entry), attachment: result.attachment };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_get_file',
      description:
        'Download an attached photo/file to a local path (no approval; read path). ' +
        'Verifies the object sha256 against the entry metadata (rejects corrupted/tampered files), ' +
        'writes to the plugin cache dir (or dir=...) and returns the absolute path for the model to use.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id.' },
        attachmentId: { type: 'string', required: true, description: 'Attachment id (from entry.attachments).' },
        dir: { type: 'string', description: 'Optional destination directory; default = plugin cache files dir.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            path: { type: 'string' },
            size: { type: 'integer' },
            attachment: ENTRY_ATTACHMENT_OUTPUT,
          },
        },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_get_file: ${value.attachment.name} (${formatBytes(value.size)}) → ${value.path}`)
            : renderText(`memory_s3_get_file failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.getFile(args.id, args.attachmentId, { dir: args.dir });
          return { ok: true, path: result.path, size: result.size, attachment: result.attachment };
        } catch (error) {
          return toolCatch(error);
        }
      },
    }),

    defineTool({
      name: 'memory_s3_detach',
      description:
        'Remove an attachment from an entry (approval-gated): deletes the S3 file object and strips its ' +
        'metadata from the entry (If-Match optimistic lock). The entry itself is kept.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id.' },
        attachmentId: { type: 'string', required: true, description: 'Attachment id (from entry.attachments).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...OK_ERROR_PROPS,
            entry: ENTRY_OUTPUT,
            attachment: ENTRY_ATTACHMENT_OUTPUT,
          },
        },
        render: (_args, value) =>
          value.ok
            ? renderText(`memory_s3_detach: -${value.attachment.name} from ${value.entry.id} (${value.entry.attachments?.length ?? 0} attachment(s) left)`)
            : renderText(`memory_s3_detach failed: ${value.error.code}: ${value.error.message}`),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        try {
          const result = await service.detach(args.id, args.attachmentId, writeContextOf(exec));
          return { ok: true, entry: toPublicEntry(result.entry), attachment: result.attachment };
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
 * bucket 未配置 → 同样整体 return，但只 WARN 不抛错：这是「已装未配」的合法待机态，
 * 抛错会拖垮整个 profile 启动，用户就再也进不到 GUI 去填这个值。
 * 加载期校验（SECURITY.md §8）：endpoint 协议、数值范围、白名单类型——非法响亮抛错
 * （这些是**写错了**的配置，与「还没配」性质不同，必须响亮失败）。
 * 凭据缺失 → WARN + configured:false（插件仍加载，读走缓存/空）。
 */
/** 本插件拥有的官方 settings 命名空间（`settings.yaml` 顶层同名段）。 */
const SETTINGS_NS = 'memory-s3';

/**
 * 将 entry config 规整为「schema 默认强化」的 base 层。
 *
 * 这一层即官方 settings 三层解析中的 composition base：
 * schema 默认 → **base（entry config）** → 用户设置段（`settings.yaml` 顶层 `memory-s3:`）。
 * 命名空间注册与三层合并由 apply() 经官方 `settings.installSection` 完成，本函数保持纯粹
 * （不触碰 ctx、不注册任何东西），因此可安全重复调用。
 *
 * @param {object} config - 该插件 cordis 条目配置（entry config，= patch override 层）。
 * @returns {object} schema 默认强化后的 base 配置。
 */
function normalizeEntryConfig(config = {}) {
  const base = {
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
    maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    allowedFileTypes: Array.isArray(config.allowedFileTypes) && config.allowedFileTypes.length > 0
      ? config.allowedFileTypes
      : DEFAULT_ALLOWED_EXTENSIONS,
  };

  return base;
}

/**
 * 插件入口。
 *
 * 关键时序：官方 settings 服务是**可选且可能晚于本插件挂载**的，而用户设置段
 * （`settings.yaml` 顶层 `memory-s3:`）只能经该服务读到。若在 apply 当刻同步读一次配置
 * 就定型，用户段永远赶不上——表现为「settings.yaml 里明明填了 bucket，插件却仍报
 * bucket not configured」。因此这里先经 ctx.inject(['settings']) 等服务就绪、拿到三层
 * 合并结果，再执行真正的挂载（mountWithConfig）。
 *
 * 子 fiber 缺服务只是自身 INACTIVE，不牵连主插件；因此未挂载 settings 服务的 profile
 * 走 else 分支，以 entry config 直接挂载（官方契约：无 provider 时插件不受影响）。
 *
 * 配置变更契约仍是 `applies: 'restart'`：本函数不做热重载，改完设置重启生效。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} config - entry config（cordis 条目配置层）。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  // enabled:false 在 entry config 层即可短路，无需牵动 settings。
  if (config.enabled === false) return;

  const base = normalizeEntryConfig(config);
  let mounted = false;
  const mountOnce = (resolved) => {
    if (mounted) return;
    mounted = true;
    mountWithConfig(ctx, resolved && typeof resolved === 'object' ? { ...base, ...resolved } : base);
  };

  // 无 inject 的宿主：直接以 entry config 挂载。
  if (typeof ctx?.inject !== 'function') {
    mountOnce(base);
    return;
  }

  // 配置源接线严格遵循官方 `settings.installSection` 契约（实现见 dsh-settings，
  // 用法见官方插件 dsh-tool-subagent/lib/model-selection-settings.js）。
  //
  // 关键：installSection 在接线完成后会**主动调用 hooks.onChange()**（dsh-settings
  // lib/index.js:338），这就是官方给出的「配置已就位」通知点。插件在此读 source 即可
  // 拿到三层合并结果，无需猜测任何时序。
  //
  // 实测踩过的坑，全部由此规避：
  //   1. ctx.inject 回调**异步**执行，且晚于 setTimeout(0) 宏任务批次——任何固定延时
  //      兜底都会抢跑，导致用户设置段静默失效（settings.yaml 填了 bucket 却报
  //      bucket not configured）。
  //   2. 「dsh-settings 包能否解析」也不可作判据：宿主共享层通常都装着它，
  //      包存在 ≠ 本 profile 挂载了该服务。
  //   3. settings 只能经 inject 后的 scoped context 访问；裸 ctx 上读 ctx.settings 会抛
  //      "cannot get property settings without inject" 并拖垮整个 profile 启动。
  //   4. settings 不能写进顶层 export const inject：cordis 的 inject 是阻塞式的
  //      （Fiber._refresh：任一服务缺失 → epoch=INACTIVE → 永不 apply）。
  let settingsSeen = false;
  ctx.inject(['settings'], (settingsCtx) => {
    settingsSeen = true;
    const settings = settingsCtx?.settings;
    if (settings == null || typeof settings.installSection !== 'function') {
      mountOnce(base);
      return;
    }
    let source = () => base;
    try {
      settings.installSection(ctx, SETTINGS_NS, Config, base, {
        setSource: (next) => {
          if (typeof next === 'function') source = next;
        },
        // 官方在接线完成后主动触发一次：此时 source 已指向 resolved scope。
        // 契约 applies:'restart' → 首次用于挂载，后续变更只提示重启。
        onChange: () => {
          if (!mounted) {
            mountOnce(source());
            return;
          }
          console.warn("[memory-s3] settings changed; restart the profile to apply (applies: 'restart')");
        },
      });
    } catch (error) {
      // 注册失败绝不拖垮插件树：以 entry config 继续（官方容错语义）。
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[memory-s3] settings section skipped (${message}); using entry config`);
    }
    // installSection 未按契约触发 onChange（宿主实现差异）时仍需挂载。
    mountOnce(source());
  });

  // 本 profile 无 settings 提供者时上面的回调永不执行，插件会形同未安装。
  // 这里**不使用**定时兜底（实测必抢跑），而是挂在 fiber 的 ready 事件上：
  // 该事件在插件树全部就绪后触发，此时 settings 若仍未出现，即可断定它不存在。
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('ready', () => {
        if (!settingsSeen) mountOnce(base);
      });
    } catch {
      // 宿主不支持 ready 事件：退化为立即以 entry config 挂载，保证插件可用。
      mountOnce(base);
    }
  } else {
    mountOnce(base);
  }
}

/**
 * 真正的挂载逻辑（原 apply 主体）：校验配置、构造 S3/缓存/审计、注册工具与注入。
 * @param {object} ctx - 插件上下文（可能是 inject 后的 scoped context）。
 * @param {object} resolved - 三层解析后的最终配置。
 * @returns {void}
 */
function mountWithConfig(ctx, resolved) {
  if (resolved.enabled === false) return;

  // bucket 未填 = 「已装但未配置」，不是错误：抛错会拖垮整个 profile 启动，用户连
  // GUI 设置页都进不去，也就永远没机会填这个值（死锁）。此处保持插件存活并待机——
  // 命名空间已在 resolveRuntimeConfig 注册，设置页可见，填好 bucket 重启即生效。
  if (typeof resolved.bucket !== 'string' || resolved.bucket.trim() === '') {
    console.warn(
      '[memory-s3] bucket not configured; plugin stands by (no tools/injection registered). ' +
        `Set a bucket in the "${SETTINGS_NS}" settings section, then restart the profile.`,
    );
    return;
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
  if (!Number.isFinite(resolved.maxFileBytes) || resolved.maxFileBytes <= 0) {
    throw invalidConfig('maxFileBytes must be a positive number');
  }
  if (resolved.maxFileBytes > 100 * 1024 * 1024) {
    console.warn('[memory-s3] maxFileBytes > 100MB — large attachments may exceed S3/network limits; keep objects small for reliable sync');
  }
  if (resolved.allowedFileTypes.some((t) => typeof t !== 'string' || t === '')) {
    throw invalidConfig('allowedFileTypes must be an array of non-empty strings');
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
  const backlinks = createBacklinks({ dir: cacheDir });
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
    backlinks,
    embedder,
    approval: ctx.approval,
    config: {
      writePolicy: resolved.writePolicy,
      importanceThreshold: resolved.importanceThreshold,
      maxInjectedItems: resolved.maxInjectedItems,
      cacheDir,
      configured,
      maxFileBytes: resolved.maxFileBytes,
      allowedFileTypes: resolved.allowedFileTypes,
    },
  });

  ctx.provide('memoryS3', service);
  ctx.effect(() => () => {
    // dispose：S3 客户端无连接句柄；cache/audit 为文件追加式，无资源需显式关闭。骨架无操作。
  });

  // 启动预热：插件加载后立即后台拉取一次远端记忆（fire-and-forget，不阻塞加载）。
  // 理由（ARCHITECTURE.md D1）：快照注入是同步的（rc.6 不 await 提供者），只读本地缓存投影；
  // 若不预热，新会话首启时缓存为空 → 快照无内容可注入。预热让跨会话记忆尽快进入缓存。
  // 仅凭据已配置（configured）且缓存为空时触发，避免每次启动都全量拉取。
  if (configured && cache.listDiskIds().length === 0) {
    setTimeout(() => {
      service
        .sync()
        .then((result) => {
          if (!result.ok) {
            console.warn(`[memory-s3] warm sync failed: ${result.error ?? 'unknown'}`);
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[memory-s3] warm sync error: ${message}`);
        });
    }, 0);
  }

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
    if (cache.listDiskIds().length > 0) return; // 已有缓存，不自动全量同步
    void service
      .sync()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[memory-s3] background sync failed: ${message}`);
      });
  });
}
