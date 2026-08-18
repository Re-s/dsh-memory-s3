// lib/filemeta.mjs — 附件文件探测：魔法字节嗅探 / 扩展名白名单 / 大小上限 / sha256。
//
// 纯 node 模块（node:fs + node:crypto），零 DSH 依赖。职责：
// - probeFile(path)：本地文件 → 附件元数据 + 完整 bytes（service 层直接上传）。
// - sniffMime(header)：按"扩展名先验 + 魔法字节证实"识别 mime 与 kind。
//
// 设计取舍（对应 docs/SECURITY.md 附件节）：
// - 白名单制：未知扩展名 / 未知魔法字节一律拒绝（UPLOAD_REJECTED），不搞黑名单。
// - 文本类（txt/md/json/csv）无魔法字节：靠扩展名 + 前 512 字节无 NUL 判定；
//   服务层需对其内容跑入口秘密检测（entry.detectSecret），二进制类不扫描（披露）。
// - SVG 故意不在白名单：XML 形态可含脚本载荷，静态存储虽不执行，但下游渲染暴露面
//   不可控（XSS），文档披露。
// - 头像/缩略图尺寸校准不在本层（原样存储，不为存储改变像素）。

import { createHash } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const MB = 1024 * 1024;

/** 默认附件大小上限（字节）。20MB 覆盖照片/PDF/压缩包；更大的文档走外部文件分享。 */
export const DEFAULT_MAX_FILE_BYTES = 20 * MB;

/** 默认允许的扩展名（小写，无点）。kind 用于 UI 渲染图标。 */
export const DEFAULT_ALLOWED_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', // 图片
  'pdf', 'zip', // 文档 / 压缩包
  'txt', 'md', 'json', 'csv', // 文本类（服务层对其内容跑秘密检测）
];

/** 扩展名 → 期望 mime（先验；最终以魔法字节证实为准）。 */
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
};

/** 文本类扩展名集合（内容需过秘密检测）。 */
export const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv']);

/**
 * 魔法字节表：识别头 → {mime, kind}。
 * 匹配顺序即优先级；表项为 (名称, 最小长度, 匹配函数)。
 */
export const MAGIC_SNIFFERS = [
  { name: 'png', min: 8, match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { name: 'jpeg', min: 3, match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { name: 'gif', min: 6, match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  { name: 'webp', min: 12, match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { name: 'pdf', min: 5, match: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d },
  { name: 'zip', min: 4, match: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) && b[3] === 0x04 },
];

function dbg(msg) {
  if (process.env.DSH_MEMORY_S3_DEBUG) console.debug('[filemeta]', msg);
}

/** 结构化输入错误（对齐 D8 错误码表；工具层映射为 ok:false）。 */
function invalid(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

/**
 * 魔法字节嗅探：返回 {mime, kind} 或 null（无法识别）。
 * @param {Uint8Array} header - 文件头字节（至少前 12 字节；短文件即全部）。
 */
export function sniffMime(header) {
  if (!(header instanceof Uint8Array) || header.length === 0) return null;
  for (const s of MAGIC_SNIFFERS) {
    if (header.length < s.min) continue;
    if (s.match(header)) {
      return s.name === 'jpeg' ? { mime: 'image/jpeg', kind: 'image' } : { mime: MIME_BY_EXT[s.name], kind: kindOf(s.name) };
    }
  }
  return null;
}

function kindOf(ext) {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'pdf' || ext === 'txt' || ext === 'md' || ext === 'json' || ext === 'csv') return 'document';
  if (ext === 'zip') return 'archive';
  return 'file';
}

/** 扩展名小写规范化（'JPG'→'jpg'，无点；无扩展名返回 ''）。 */
export function extensionOf(name) {
  const ext = extname(String(name ?? '')).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/**
 * 探测本地文件：校验（存在/非目录/大小上限/扩展名白名单/魔法字节一致）→ 全量读取 +
 * sha256 → 附件元数据（不含 objectKey/createdAt——那些由 service 层补充）。
 *
 * @param {string} path - 本地文件路径（工具参数透传）。
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=DEFAULT_MAX_FILE_BYTES]
 * @param {string[]} [opts.allowedExtensions=DEFAULT_ALLOWED_EXTENSIONS]
 * @returns {Promise<{bytes: Buffer, name: string, size: number, sha256: string, mime: string, kind: string, extension: string}>}
 * @throws {Error} code ∈ INVALID_INPUT | FILE_NOT_FOUND | FILE_TOO_LARGE | UPLOAD_REJECTED
 */
export async function probeFile(path, opts = {}) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw invalid('INVALID_INPUT', 'attachment path must be a non-empty string');
  }
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_FILE_BYTES;
  const allowed = Array.isArray(opts.allowedExtensions) && opts.allowedExtensions.length > 0 ? opts.allowedExtensions : DEFAULT_ALLOWED_EXTENSIONS;

  let st;
  try {
    st = await stat(path);
  } catch {
    throw invalid('FILE_NOT_FOUND', `attachment file not found: ${path}`);
  }
  if (!st.isFile()) {
    throw invalid('INVALID_INPUT', `attachment path is not a regular file: ${path}`);
  }
  if (st.size > maxBytes) {
    throw invalid('FILE_TOO_LARGE', `attachment exceeds size limit (${st.size} > ${maxBytes} bytes)`, { size: st.size, maxBytes });
  }

  const name = basename(path);
  const extension = extensionOf(name);
  if (!allowed.includes(extension)) {
    throw invalid('UPLOAD_REJECTED', `file extension ".${extension}" is not in the allowed list [${allowed.join(', ')}]`, { extension, allowed });
  }

  // 读取 + 头字节嗅探 + sha256 单遍。
  const bytes = await readAll(path, st.size);
  const header = bytes.subarray(0, 16);
  const sniffed = sniffMime(header);

  let mime;
  let kind;
  if (TEXT_EXTENSIONS.has(extension)) {
    // 文本类无魔法字节：扩展名白名单 + 全文件无 NUL 即接受（含 UTF-8 多字节安全：
    // NUL 只可能出现在二进制里；UTF-16 文本首字节常含 NUL，连同拒绝——披露）。
    // 注意：全文件扫描而非仅头部——二进制伪装文本的 NUL 可藏在任意偏移。
    if (bytes.includes(0)) {
      throw invalid('UPLOAD_REJECTED', `text file "${name}" contains NUL bytes (binary-looking content mislabeled as text)`, { extension });
    }
    mime = MIME_BY_EXT[extension];
    kind = 'document';
  } else {
    if (sniffed === null) {
      throw invalid('UPLOAD_REJECTED', `file "${name}" has unrecognized magic bytes (extension .${extension} allowed, content does not match)`, { extension });
    }
    // 扩展名先验与魔法字节证实一致性：不一致即拒绝（.png 里塞 PDF 是走私载体）。
    const expect = MIME_BY_EXT[extension];
    if (expect !== sniffed.mime) {
      throw invalid('UPLOAD_REJECTED', `file "${name}" content (${sniffed.mime}) does not match its extension (.${extension})`, { extension, detected: sniffed.mime });
    }
    mime = sniffed.mime;
    kind = sniffed.kind;
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  dbg(`probe ok ${name} ${bytes.length}B ${mime} sha256=${sha256.slice(0, 12)}…`);
  return { bytes, name, size: bytes.length, sha256, mime, kind, extension };
}

/** 全量读取（大小已由调用方校验 ≤ maxBytes，内存安全）。 */
async function readAll(path, expectedSize) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const { bytesRead } = await fh.read(buf, offset, expectedSize - offset, offset);
      if (bytesRead === 0) break; // 文件在 stat 后被截断：按实际读到的算
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await fh.close();
  }
}

/** 人类可读字节数（工具 render 用；1.5 MB / 233.6 KB）。 */
export function formatBytes(size) {
  if (!Number.isFinite(size) || size < 0) return '0 B';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}