// lib/strings.mjs — 模型可见/命令面词表（en/zh）。
//
// 快照头对齐 ARCHITECTURE.md D3 的示例形态（`[记忆S3] 已同步 <ts> · <n>/<m> 条`），
// 其余文案覆盖：未同步提示、stale 离线标记、审批拒绝文案、状态视图标签。
// snapshotHeader 是函数（需插值），其余为字符串模板。

const EN = {
  // 快照头：已同步状态 + 预算用量（count/total/lastSync 由调用方注入）。
  snapshotHeader: ({ count, total, lastSync }) =>
    `[MemoryS3] synced ${lastSync} · ${count}/${total} entries`,
  // 无缓存首启时快照渲染为空 + 提示（ARCHITECTURE.md D1）。
  notSynced: 'Memory not synced yet — run memory_s3_sync to pull from S3.',
  // 离线降级标记（读缓存视图时附加）。
  stale: ' (stale: offline cache, may be outdated)',
  // 审批被拒文案（D2：被拒写零落盘 + 留痕审计）。
  denied: 'Write denied by approval gate — nothing was persisted.',
  // 离线写入标记（骨架阶段仅记录不队列重放，D1）。
  pending: ' (pending: not synced to S3 yet)',
  // 嵌入器不可用时的召回提示（TECH_STACK.md §5 降级路径）。
  embedderNone: 'Embedder unavailable — keyword search used instead.',
  // 状态视图标签。
  status: {
    title: 'MemoryS3 Status',
    configured: 'Configured',
    notConfigured: 'Not configured (credentials missing)',
    syncOk: 'Sync OK',
    syncFailed: 'Sync failed',
    neverSynced: 'Never synced',
    cachedEntries: 'Cached entries',
    remoteEntries: 'Remote entries',
    embedder: 'Embedder',
    cacheDir: 'Cache dir',
    lastSync: 'Last sync',
  },
};

const ZH = {
  snapshotHeader: ({ count, total, lastSync }) =>
    `[记忆S3] 已同步 ${lastSync} · ${count}/${total} 条`,
  notSynced: '记忆尚未同步——运行 memory_s3_sync 从 S3 拉取。',
  stale: '（stale：离线缓存，可能过期）',
  denied: '写操作被审批门拒绝——未落盘任何数据。',
  pending: '（pending：尚未同步到 S3）',
  embedderNone: '嵌入器不可用——已改用关键词检索。',
  status: {
    title: '记忆S3 状态',
    configured: '已配置',
    notConfigured: '未配置（凭据缺失）',
    syncOk: '同步正常',
    syncFailed: '同步失败',
    neverSynced: '从未同步',
    cachedEntries: '缓存条目',
    remoteEntries: '远端条目',
    embedder: '嵌入器',
    cacheDir: '缓存目录',
    lastSync: '上次同步',
  },
};

/** 取词表；lang 未知（非 'zh'）回退英文。 */
export function strings(lang) {
  return lang === 'zh' ? ZH : EN;
}
