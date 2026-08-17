// lib/audit.mjs — 审计账本：JSONL 追加式日志（本地）。
//
// 骨架阶段实现（对齐 ARCHITECTURE.md D5 审计三链的本地一链）：
// - append 原子追加一行 {seq, ts, action, data}；seq 单调递增且跨重启恢复
//   （启动时从现有行数续号，保证重建时顺序完整）。
// - retentionDays 语义：>0 时表示保留天数，但骨架阶段只统计不删除——删除
//   逻辑留待正式版按文件 mtime 清理，见 append 内注释。
// - 审计失败（写盘异常）是安全相关事件：抛结构化错误 {code:'AUDIT_FAILED'}，
//   不静默吞错——调用方必须决定降级策略而非假装成功。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const AUDIT_FILE = 'audit.jsonl';

export function createAudit({ dir, retentionDays = 0 } = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw Object.assign(new TypeError('audit dir is required'), { code: 'INVALID_CONFIG' });
  }
  const file = join(dir, AUDIT_FILE);

  // 恢复 seq：数已有行数（JSONL 每行一条记录，空行跳过）。
  let seq = 0;
  if (existsSync(file)) {
    try {
      const text = readFileSync(file, 'utf8');
      seq = text.split('\n').filter((l) => l.trim() !== '').length;
    } catch (err) {
      console.warn(`[audit] existing log unreadable, seq starts fresh: ${err.message}`);
    }
  }

  function append(action, data) {
    const record = { seq: ++seq, ts: new Date().toISOString(), action, data };
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch (err) {
      // 审计是安全不变量的一环（S2），写失败必须响亮失败而非静默继续。
      throw Object.assign(new Error(`audit append failed: ${err.message}`), {
        code: 'AUDIT_FAILED',
        cause: err,
      });
    }
    // retentionDays 骨架简化：>0 时仅记录语义（供未来按行龄/文件 mtime 清理），
    // 不真正删除——避免骨架阶段引入误删风险。正式版在此接清理逻辑。
    if (retentionDays > 0) {
      void retentionDays; // 占位：保留语义由调用方文档化，本阶段不执行删除
    }
    return record;
  }

  function readTail(limit = 20) {
    if (!existsSync(file)) return [];
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    try {
      // 骨架简化：全读截尾（10k 行内毫秒级）；数据量大时改尾部流式读取。
      const text = readFileSync(file, 'utf8');
      const records = text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null; // 单行损坏跳过，不阻塞整链读取（账本可重建性优先）
          }
        })
        .filter((r) => r !== null);
      return records.slice(-n);
    } catch (err) {
      throw Object.assign(new Error(`audit read failed: ${err.message}`), {
        code: 'AUDIT_READ_FAILED',
        cause: err,
      });
    }
  }

  return { append, readTail };
}
