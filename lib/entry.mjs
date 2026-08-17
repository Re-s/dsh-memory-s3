// lib/entry.mjs — 条目模型：校验 / 规范化 / 序列化 / 秘密检测。
//
// 纯函数模块，零 DSH 依赖（只 node:crypto）。对齐 types.d.ts 的 MemoryS3Entry
// 字段集：任何字段增删都要同步本文件与 types.d.ts。
//
// 设计要点：
// - normalizeEntry 是「用户输入 → 完整条目」的唯一入口（宽容规范化：夹取、
//   补默认）；validateEntry 是「完整条目」的严格校验（外部读回数据用）。
// - 秘密检测是启发式（见 docs/SECURITY.md §3），命中即拒写入，返回结构化
//   错误 {code:'SECRET_DETECTED', pattern}。

import { randomUUID } from 'node:crypto';

export const TYPES = ['preference', 'project', 'decision', 'history'];

/** 默认来源标注（tool 写入是最常见路径；seed/auto-capture 由调用方显式覆盖）。 */
export const DEFAULT_SOURCE = 'tool';
/** 默认重要性（1-5 中位；低于 BUDGET threshold 不进入自动注入候选）。 */
export const DEFAULT_IMPORTANCE = 3;

// 秘密检测规则表：名称 → 正则。顺序即优先级（命中返回第一个匹配）。
// 启发式而非确定性检测——见 docs/SECURITY.md §3 的诚实披露。
export const SECRET_PATTERNS = [
  // AWS 访问密钥（AKIA 永久 / ASIA 临时），后随 16 位大写字母数字。
  { name: 'aws-access-key', regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  // JWT：三段 base64url，每段至少 10 字符（eyJ 开头）。
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // PEM 私钥头（RSA/EC/OPENSSH 变体）。
  { name: 'pem-private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // 通用口令赋值：secret/token/api[_-]key/password 后接 : 或 = 与值。
  // \b 防止命中 my_token / password123 这类词内子串；\S+ 要求确实有值。
  { name: 'secret-assignment', regex: /\b(?:secret|token|api[_-]?key|password)\s*[:=]\s*\S+/i },
];

function dbg(msg) {
  if (process.env.DSH_MEMORY_S3_DEBUG) console.debug('[entry]', msg);
}

/** 结构化输入错误：{code, message, details?} 形状（对齐 D8 错误码表）。 */
function invalid(message, details) {
  return { code: 'INVALID_INPUT', message, ...(details ? { details } : {}) };
}

/** 数字夹取到 [min, max]；非有限数回退 fallback。 */
function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * 校验规范化条目，返回 null（合法）或结构化错误。
 * 严格模式：不做夹取/补默认——越界即错，供外部读回数据把关。
 */
export function validateEntry(entry) {
  if (entry === null || typeof entry !== 'object') {
    return invalid('entry must be an object');
  }
  const missing = [];
  for (const field of ['id', 'type', 'title', 'content', 'tags', 'importance', 'source', 'createdAt', 'updatedAt', 'recallCount', 'lastRecalled', 'workspaceKey', 'agentKey']) {
    if (!(field in entry)) missing.push(field);
  }
  if (missing.length > 0) {
    return invalid(`missing required field(s): ${missing.join(', ')}`, { missing });
  }
  if (!TYPES.includes(entry.type)) {
    return invalid(`invalid type "${entry.type}", expected one of ${TYPES.join('|')}`, { type: entry.type });
  }
  if (typeof entry.title !== 'string' || entry.title.trim() === '') {
    return invalid('title must be a non-empty string');
  }
  if (typeof entry.content !== 'string') {
    return invalid('content must be a string');
  }
  if (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== 'string')) {
    return invalid('tags must be an array of strings');
  }
  const imp = entry.importance;
  if (typeof imp !== 'number' || !Number.isFinite(imp) || imp < 1 || imp > 5) {
    return invalid(`importance must be a number in [1,5], got ${imp}`, { importance: imp });
  }
  if (typeof entry.source !== 'string') {
    return invalid('source must be a string');
  }
  for (const field of ['createdAt', 'updatedAt', 'recallCount']) {
    if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field])) {
      return invalid(`${field} must be a finite number`);
    }
  }
  if (entry.recallCount < 0) {
    return invalid('recallCount must be >= 0');
  }
  if (entry.lastRecalled !== null && (typeof entry.lastRecalled !== 'number' || !Number.isFinite(entry.lastRecalled))) {
    return invalid('lastRecalled must be null or a finite number');
  }
  if (typeof entry.workspaceKey !== 'string' || typeof entry.agentKey !== 'string') {
    return invalid('workspaceKey and agentKey must be strings');
  }
  if (entry.embedding !== undefined) {
    if (!Array.isArray(entry.embedding)) {
      return invalid('embedding must be an array of numbers');
    }
    if (entry.embedding.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return invalid('embedding entries must be finite numbers');
    }
  }
  return null;
}

/**
 * 用户输入 → 完整条目。宽容规范化：
 * - importance 默认 3，夹取 1-5（validateEntry 的严格检查由调用方在
 *   读回时使用，写入路径这里就消化掉边界输入）；
 * - tags 元素转字符串并 trim 去空；
 * - createdAt/updatedAt 默认 now（epoch ms）。
 */
export function normalizeEntry(input, { workspaceKey = '', agentKey = '', now = Date.now() } = {}) {
  if (input === null || typeof input !== 'object') {
    throw invalid('input must be an object');
  }
  if (!TYPES.includes(input.type)) {
    throw invalid(`invalid type "${input.type}", expected one of ${TYPES.join('|')}`, { type: input.type });
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw invalid('title must be a non-empty string');
  }
  if (typeof input.content !== 'string') {
    throw invalid('content must be a string');
  }

  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags)) {
    throw invalid('tags must be an array of strings');
  }
  const entry = {
    id: randomUUID(),
    type: input.type,
    title: input.title.trim(),
    content: input.content,
    tags: tags.map((t) => String(t).trim()).filter((t) => t !== ''),
    importance: clampNumber(input.importance, 1, 5, DEFAULT_IMPORTANCE),
    source: input.source === undefined ? DEFAULT_SOURCE : String(input.source),
    createdAt: now,
    updatedAt: now,
    recallCount: 0,
    lastRecalled: null,
    workspaceKey,
    agentKey,
  };
  if (input.embedding !== undefined) {
    if (!Array.isArray(input.embedding)) {
      throw invalid('embedding must be an array of numbers');
    }
    entry.embedding = input.embedding;
  }
  dbg(`normalize ok ${entry.id} type=${entry.type}`);
  return entry;
}

// toJSON/fromJSON 共享的字段白名单：序列化面 = types.d.ts 字段集。
// 未知字段一律丢弃（防止缓存/S3 对象混入脏数据）；embedding 可选保留。
const JSON_FIELDS = [
  'id', 'type', 'title', 'content', 'tags', 'importance', 'source',
  'createdAt', 'updatedAt', 'recallCount', 'lastRecalled', 'workspaceKey', 'agentKey',
];

/** 序列化为纯 JSON 对象（浅拷贝已知字段；embedding 存在才带上）。 */
export function toJSON(entry) {
  const out = {};
  for (const field of JSON_FIELDS) {
    out[field] = entry[field];
  }
  if (entry.embedding !== undefined) out.embedding = entry.embedding;
  return out;
}

// fromJSON 的容错默认值：缺字段补默认、类型错误字段也回退默认。
// 数字字段用 0 表示「未知」（确定性、可测），而非 Date.now()。
// type 特殊：缺 → 默认 'history'；存在但非法 → 抛（数据损坏响亮失败）。
const FALLBACK = {
  id: () => randomUUID(),
  title: () => '',
  content: () => '',
  tags: () => [],
  importance: () => DEFAULT_IMPORTANCE,
  source: () => 'unknown',
  createdAt: () => 0,
  updatedAt: () => 0,
  recallCount: () => 0,
  lastRecalled: () => null,
  workspaceKey: () => '',
  agentKey: () => '',
};

function pick(raw, field, isOk) {
  return isOk(raw[field]) ? raw[field] : FALLBACK[field]();
}

/**
 * 反序列化（缓存/S3 读回用）：容错恢复 + 未知字段丢弃。
 * - 缺字段 / 类型错误的字段 → 补默认；
 * - type 明确非法 → 抛 INVALID_INPUT（数据损坏应响亮失败，不静默吞错）。
 */
export function fromJSON(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw invalid('raw must be an object');
  }
  // type 单独处理：缺失补默认，明确非法则抛——容错不掩盖数据损坏。
  let type = 'history';
  if (raw.type !== undefined) {
    if (!TYPES.includes(raw.type)) {
      throw invalid(`unknown type "${raw.type}", expected one of ${TYPES.join('|')}`, { type: raw.type });
    }
    type = raw.type;
  }
  const entry = {
    id: pick(raw, 'id', (v) => typeof v === 'string' && v !== ''),
    type,
    title: pick(raw, 'title', (v) => typeof v === 'string'),
    content: pick(raw, 'content', (v) => typeof v === 'string'),
    tags: pick(raw, 'tags', (v) => Array.isArray(v) && v.every((t) => typeof t === 'string')),
    importance: pick(raw, 'importance', (v) => typeof v === 'number' && Number.isFinite(v)),
    source: pick(raw, 'source', (v) => typeof v === 'string'),
    createdAt: pick(raw, 'createdAt', (v) => typeof v === 'number' && Number.isFinite(v)),
    updatedAt: pick(raw, 'updatedAt', (v) => typeof v === 'number' && Number.isFinite(v)),
    recallCount: pick(raw, 'recallCount', (v) => typeof v === 'number' && Number.isFinite(v)),
    lastRecalled: pick(raw, 'lastRecalled', (v) => v === null || (typeof v === 'number' && Number.isFinite(v))),
    workspaceKey: pick(raw, 'workspaceKey', (v) => typeof v === 'string'),
    agentKey: pick(raw, 'agentKey', (v) => typeof v === 'string'),
  };
  if (Array.isArray(raw.embedding) && raw.embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    entry.embedding = raw.embedding;
  }
  return entry;
}

/** 去重合并键：同类型 + title trim 后相等（区分大小写，按任务字面语义）。 */
export function sameTitle(a, b) {
  return a.type === b.type && a.title.trim() === b.title.trim();
}

/**
 * 启发式秘密检测：对文本扫描 SECRET_PATTERNS。
 * 命中返回 {code:'SECRET_DETECTED', pattern}，未命中返回 null。
 */
export function detectSecret(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const { name, regex } of SECRET_PATTERNS) {
    if (regex.test(text)) {
      dbg(`secret detected pattern=${name}`);
      return { code: 'SECRET_DETECTED', pattern: name };
    }
  }
  return null;
}

/**
 * 对条目的 title/content/tags 逐一检测，返回第一个命中或 null。
 * 写入路径（save/update/seed）在过审批门前调用，命中即拒。
 */
export function detectEntrySecrets(entry) {
  const fields = [entry.title, entry.content, ...(Array.isArray(entry.tags) ? entry.tags : [])];
  for (const text of fields) {
    const hit = detectSecret(text);
    if (hit) return hit;
  }
  return null;
}
