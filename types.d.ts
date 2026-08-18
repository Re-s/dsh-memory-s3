// types.d.ts — dsh-memory-s3 类型契约（声明合并）。
//
// 本插件入口是纯 ESM JavaScript；类型契约集中在本文件：
// - `declare module '@deepseek-ai/cordis'`：ctx.memoryS3 服务（Service Definition 面）
//   与审批 seam 消费面。
//
// 设计继承自 dsh-memento 的类型契约风格（MIT/Apache 参考），
// 差异：条目携带 embedding（向量检索），存储为 S3 对象而非本地 SQLite。

export type MemoryS3Type = 'preference' | 'project' | 'decision' | 'history' | 'moment'

export type MemoryS3WritePolicy = 'ask' | 'auto' | 'off'

export type MemoryS3Action =
  | 'save'
  | 'update'
  | 'remove'
  | 'forget'
  | 'recall'
  | 'seed'
  | 'sync'
  | 'attach'
  | 'detach'

/** 附件种类（UI 渲染图标用）。 */
export type MemoryS3AttachmentKind = 'image' | 'document' | 'archive' | 'file'

/** 附件元数据（条目 embeddings 旁的可选数组元素；二进制存 S3 files/{id} 对象）。 */
export interface MemoryS3Attachment {
  /** 附件 id（uuid，跨会话稳定；与 objectKey files/{id} 一一对应）。 */
  id: string
  /** 原始文件名（basename，无路径分隔符；后缀用于下载还原）。 */
  name: string
  /** MIME 类型（魔法字节证实，非仅扩展名）。 */
  mime: string
  /** 种类：image / document / archive / file。 */
  kind: MemoryS3AttachmentKind
  /** 字节数。 */
  size: number
  /** SHA-256 十六进制摘要（下载校验 + 完整性 proof）。 */
  sha256: string
  /** S3 对象相对 key（files/{id}；客户端不应假设其他布局）。 */
  objectKey: string
  /** 可选说明文字（attach/save 时传入）。 */
  note?: string
  /** 挂载时间（epoch ms）。 */
  createdAt: number
}

/** 附件输入（save/attach 工具参数）：本地路径 + 可选说明。 */
export interface MemoryS3AttachmentInput {
  /** 本地文件路径（插件内做白名单/魔法字节/大小校验，凭据/二进制不进审批 reason）。 */
  path: string
  note?: string
}

/** S3 同步状态。 */
export interface MemoryS3SyncState {
  /** 上次成功同步的 ISO 时间；从未同步为 null。 */
  lastSync: string | null
  /** 同步是否成功（失败时 stale 读取可用）。 */
  ok: boolean
  /** 失败原因（ok=false 时）。 */
  error?: string
}

/** 落盘条目（S3 entries/<id>.json 的形状）。 */
export interface MemoryS3Entry {
  /** 条目 id（本插件生成，跨会话稳定）。 */
  id: string
  /** 类型：preference=用户画像 / project=项目知识 / decision=决策 / history=会话摘要。 */
  type: MemoryS3Type
  /** 简短标题（同类型去重键）。 */
  title: string
  /** 条目正文。 */
  content: string
  /** 标签数组。 */
  tags: string[]
  /** 重要性 1-5；>= threshold 进入自动注入候选。 */
  importance: number
  /** 来源标注（tool / auto-capture / seed 等）。 */
  source: string
  /** 创建时间（epoch ms）。 */
  createdAt: number
  /** 最近更新时间（epoch ms）。 */
  updatedAt: number
  /** 召回次数（排序用：高频即重要）。 */
  recallCount: number
  /** 最近召回时间；从未命中为 null。 */
  lastRecalled: number | null
  /** 嵌入向量（可插拔嵌入器可用时填充；无则向量检索降级为关键词）。 */
  embedding?: number[]
  /** 主体：'me' | 'risu' | 'us' | 'world' 或任意字符串；缺省不落盘（MODEL.md §5.1）。 */
  subject?: string
  /** 时间线归属（世界线/时期，如 'α-2'）；缺省不落盘（MODEL.md §5.2）。 */
  timeline?: string
  /** 关联条目 id 数组（L1 无类型双向引用；反链由本地索引维护，MODEL.md §6）。 */
  links?: string[]
  /** 锁定保护：true 时跳过同 title 自动合并；显式写仍过审批。默认 false。 */
  locked: boolean
  /** 附件元数据数组（照片/文件；二进制在 S3 files/ 对象，此处仅元数据投影）。 */
  attachments?: MemoryS3Attachment[]
  /** workspace 条目的规范化 cwd 键；'' = 全局（跨工作区）。 */
  workspaceKey: string
  /** 规范化 agentPreset 键；'' = 共享层（所有 preset 可见）。 */
  agentKey: string
}

/** 写入输入（save/seed 用）。 */
export interface MemoryS3EntryInput {
  type: MemoryS3Type
  title: string
  content: string
  tags?: string[]
  importance?: number
  source?: string
  /** 显式 workspaceKey；省略时取写方会话 cwd。 */
  workspaceKey?: string
  /** 显式 agentKey；省略时取写方会话 agentPreset。 */
  agentKey?: string
  /** 主体标注（me/risu/us/world 或任意字符串）。 */
  subject?: string
  /** 时间线归属（世界线/时期，如 'α-2'）。 */
  timeline?: string
  /** 关联条目 id（引用式链接；反链自动回填本地索引）。 */
  links?: string[]
  /** 锁定保护（默认 false；true 时跳过同 title 自动合并）。 */
  locked?: boolean
  /** 可选本地附件（{path, note?}）：探测校验后上传 S3 并挂到条目。 */
  attachments?: MemoryS3AttachmentInput[]
}

/** 会话最小形状（插件只读这些面）。 */
export interface MemoryS3SessionLike {
  id?: unknown
  header?: { cwd?: unknown; agentPreset?: unknown }
}

/** 审批服务最小形状（插件消费的 seam 面）。 */
export interface MemoryS3ApprovalLike {
  request(req: {
    agent?: unknown
    toolName?: string
    reason?: string
    callId?: unknown
    signal?: AbortSignal
  }): Promise<string>
  overrideOf?(session: unknown): string | undefined
}

/** 写上下文：审批路由与审计归属所必需。agent 缺失时写失败封闭。 */
export interface MemoryS3WriteContext {
  /** 发起写的 agent（其 session 承载审批审计对）。 */
  agent: { session?: MemoryS3SessionLike | null } | null | undefined
  /** 发起写的工具 callId。 */
  callId?: unknown
  /** 取消信号：中止即 cancelled，不写任何东西。 */
  signal?: AbortSignal
}

/** 检索过滤条件。 */
export interface MemoryS3Filter {
  type?: MemoryS3Type
  tags?: string[]
  importanceMin?: number
  limit?: number
}

/** 语义召回请求。 */
export interface MemoryS3RecallQuery {
  query: string
  type?: MemoryS3Type
  tags?: string[]
  /** 向量 top-k（默认 20）。 */
  topK?: number
}

/** 检索结果。 */
export interface MemoryS3QueryResult {
  entries: MemoryS3Entry[]
  total: number
  /** 结果是否来自过期缓存（离线降级标记）。 */
  stale: boolean
}

/** 同步结果。 */
export interface MemoryS3SyncResult {
  ok: boolean
  pulled: number
  pushed?: number
  updatedAt: string
  error?: string
}

/** 状态视图。 */
export interface MemoryS3Status {
  configured: boolean
  sync: MemoryS3SyncState
  cachedEntries: number
  remoteEntries?: number
  embedder: 'none' | 'openai-compatible' | 'ollama'
  cacheDir: string
}

/** ctx.memoryS3 服务：写方法内部强制过审批门，读方法无审批。 */
export interface MemoryS3Service {
  /** 新增条目（审批门 + 去重合并）。 */
  save(
    input: MemoryS3EntryInput,
    write: MemoryS3WriteContext,
  ): Promise<{ action: 'created' | 'merged'; entry: MemoryS3Entry }>

  /** 关键词检索（子串匹配 + 元数据过滤；无审批；走缓存）。 */
  search(filter: MemoryS3Filter & { text?: string }): MemoryS3QueryResult

  /** 语义召回（向量 top-k + 关键词混合；无审批；走缓存）。 */
  recall(query: MemoryS3RecallQuery): Promise<MemoryS3QueryResult>

  /** 列表（按 updatedAt 倒序，分页）。 */
  list(filter: MemoryS3Filter & { offset?: number }): MemoryS3QueryResult

  /** 反链查询（无审批；读本地反链索引）：返回引用了该条目 id 的条目列表。 */
  linkedTo(entryId: string): MemoryS3QueryResult

  /** 更新条目（审批门；载荷携带新旧全文）。 */
  update(
    id: string,
    patch: Partial<Pick<MemoryS3EntryInput, 'title' | 'content' | 'type' | 'tags' | 'importance'>>,
    write: MemoryS3WriteContext,
  ): Promise<{ previous: MemoryS3Entry; entry: MemoryS3Entry }>

  /** 删除条目（审批门；载荷携带被删全文）。 */
  remove(id: string, write: MemoryS3WriteContext): Promise<{ entry: MemoryS3Entry }>

  /** 抑制自动注入而不删除（无审批；仅改本地标志，S3 侧保留）。 */
  forget(id: string, forgotten: boolean): Promise<{ entry: MemoryS3Entry }>

  /** 给已有条目挂附件（审批门；附件对象不可变 + sha256 proof）。 */
  attach(
    entryId: string,
    input: MemoryS3AttachmentInput,
    write: MemoryS3WriteContext,
  ): Promise<{ entry: MemoryS3Entry; attachment: MemoryS3Attachment }>

  /** 移除附件（审批门）：删 S3 文件对象 + 条目元数据移除（If-Match）。 */
  detach(
    entryId: string,
    attachmentId: string,
    write: MemoryS3WriteContext,
  ): Promise<{ entry: MemoryS3Entry; attachment: MemoryS3Attachment }>

  /** 下载附件到本地（读路径无审批）：sha256 校验后写入目标目录，返回本地路径。 */
  getFile(
    entryId: string,
    attachmentId: string,
    opts?: { dir?: string },
  ): Promise<{ attachment: MemoryS3Attachment; path: string; size: number }>

  /** 手动同步：拉取远端增量，重建索引。 */
  sync(): Promise<MemoryS3SyncResult>

  /** 状态视图。 */
  status(): MemoryS3Status
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-memory-s3 记忆服务（本插件提供）。 */
    memoryS3: MemoryS3Service
    /** 审批 seam（本插件消费；由 DSH interaction 能力提供）。 */
    approval: MemoryS3ApprovalLike
  }
  interface Events {
    /** 审批 waterfall（本插件 answerer 挂链）。 */
    'approval/request'(req: unknown, next: () => Promise<string>): Promise<string>
    /** 会话事件桥（自动同步触发等观察面用）。 */
    'session/event'(session: unknown, event: unknown): void
  }
}
