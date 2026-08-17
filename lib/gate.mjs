// lib/gate.mjs — 审批门 reason 编解码（approve-what-you-see）。
//
// reason 形状（正则可逆，ARCHITECTURE.md D2）：
//   第一行：`[dsh-memory-s3] <action>: <摘要>`（摘要 = 载荷紧凑 JSON，>300
//   字符截断并标注 [truncated]，保证第一行保持单行可读）；
//   空行后：完整载荷 JSON（美化缩进，供审批人逐字核验）。
// parseWriteReason 用正则切分第一行与正文，正文 JSON.parse 失败即返回 null。

const DEFAULT_PREFIX = 'dsh-memory-s3';
const SUMMARY_LIMIT = 300;
const TRUNCATE_MARKER = '[truncated]';

// 首行：`[prefix] action: summary`；\n\n 后为载荷正文（[\s\S]* 容忍正文内换行）。
const REASON_RE = /^\[([^\]]+)\]\s+([^:]+):\s*(.*?)\n\n([\s\S]*)$/;

function truncateSummary(text) {
  if (text.length <= SUMMARY_LIMIT) return text;
  // 截断后总长仍 ≤ 300：留出标记自身长度。
  return text.slice(0, SUMMARY_LIMIT - TRUNCATE_MARKER.length) + TRUNCATE_MARKER;
}

/**
 * 构建写审批 reason。
 * @param {{prefix?: string, action: string, payload: object}} opts
 */
export function buildWriteReason({ prefix = DEFAULT_PREFIX, action, payload }) {
  if (typeof action !== 'string' || action === '') {
    throw Object.assign(new TypeError('action is required'), { code: 'INVALID_INPUT' });
  }
  // 摘要用紧凑 JSON（无换行，保证第一行结构）；JSON.stringify 遇循环引用
  // 会抛 TypeError——让非法载荷响亮失败，不静默产出损坏 reason。
  const summary = truncateSummary(JSON.stringify(payload));
  const body = JSON.stringify(payload, null, 2);
  return `[${prefix}] ${action}: ${summary}\n\n${body}`;
}

/**
 * 解析 reason → {prefix, action, payload}；格式不符 / 载荷 JSON 损坏返回 null。
 */
export function parseWriteReason(reason) {
  if (typeof reason !== 'string') return null;
  const m = REASON_RE.exec(reason);
  if (!m) return null;
  const [, prefix, action, , body] = m;
  try {
    return { prefix, action: action.trim(), payload: JSON.parse(body) };
  } catch {
    return null;
  }
}

/** 是否本插件发出的 reason（以 [dsh-memory-s3] 开头）。 */
export function isOwnReason(reason) {
  return typeof reason === 'string' && reason.startsWith(`[${DEFAULT_PREFIX}]`);
}
