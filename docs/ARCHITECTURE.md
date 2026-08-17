# dsh-memory-s3（记忆S3）架构设计

> 状态：Initiation（v0.1 draft）｜日期：2026-08-17
> 本文档描述模块边界、数据流、S3 对象布局、同步投影机制与安全模型。技术选型结论见 TECH_STACK.md。

---

## 1. 总体架构

```
┌────────────────────────────────────────────────────────────────────────┐
│ DSH Harness (Cordis 4, rc.6)                                            │
│                                                                          │
│  Consumer 面：                                                            │
│   ├ ctx.tools        memory_s3_save/search/recall/list/update/delete/    │
│   │                  forget/sync/status                                   │
│   ├ ctx.systemPrompt 冻结快照段（order=-50，同步提供者 + WeakMap 冻结）    │
│   └ ctx.webServer    只读状态面板（骨架阶段：status 接口）                 │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ 写（带 exec.agent/callId/signal）  读（同步走缓存）
               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Service Definition：ctx.memoryS3（index.mjs）                            │
│  save() search() recall() list() update() remove() forget() sync()       │
│  status()                                                                 │
│  写路径（审批门不可绕过）：                                                │
│    嵌入(异步) ─▶ 预算/去重预检 ─▶ ctx.approval.request ─▶ 落盘 S3 ─▶ 审计  │
│  读路径：缓存优先（同步），缺失/过期时后台异步回源 S3                       │
└──────────────┬───────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────────┐
│ lib/（纯逻辑，零 DSH 依赖，只依赖 node: 内置）                            │
│  s3store.mjs    S3 对象布局 + CRUD + 乐观并发（If-Match）                 │
│  cache.mjs      本地缓存：索引 JSON + 条目 LRU（内存/磁盘）                │
│  embedder.mjs   嵌入接口 + OpenAI 兼容实现（fetch）                       │
│  vector.mjs     余弦相似度 top-k + 元数据过滤（纯 JS）                    │
│  entry.mjs      条目模型校验/规范化/序列化                                │
│  gate.mjs       审批门策略封装（reason 编解码）                           │
│  audit.mjs      审计账本（JSONL 追加，本地）                              │
│  strings.mjs    模型可见/命令面词表（en/zh）                              │
└─────────────────────────────────────────────────────────────────────────┘
               │ HTTPS（SigV4 签名）
┌──────────────▼──────────────────────────────────────────────────────────┐
│ S3 兼容对象存储（AWS S3 / MinIO / Cloudflare R2 / 阿里云 OSS）            │
│ s3://<bucket>/<prefix>/                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. 核心设计决策

### D1. S3 是唯一事实源，本地缓存是同步投影（由 rc.6 同步注入约束强制）
- **平台约束**：rc.6 的 systemPrompt 提供者不被 await，必须同步返回（dsh-memento 决策 1 实证）。
- **推论**：S3 是异步网络面，不可能在注入路径上同步读。因此冻结快照**只从本地缓存投影渲染**。
- 缓存 = 上次同步的索引（manifest）+ 条目副本；启动时异步预热，会话事件驱动增量同步。
- 无缓存首启时快照渲染为空 + 提示「记忆尚未同步」；`memory_s3_sync` 手动触发全量拉取。
- 离线降级：检索走缓存视图，结果标注 `stale: true`；写入标记 `pending`（骨架阶段仅记录，不队列重放）。

### D2. 审批门做在 Service 写方法内部（继承 dsh-memento 决策 2，Hermes #48181 教训）
- 任何路径调 `ctx.memoryS3.save/update/remove/seed` 必然经过 `ctx.approval.request`。
- `writePolicy`（ask/auto/off，默认 ask）是 Config，模型不可见不可改；会话级 `approval/never` 由审批服务硬拦截，插件不可绕过。
- **approve-what-you-see**：审批 reason 携带完整写载荷——save/update 含新旧全文，remove 含被删全文。
- **被拒写留痕**：`rejected/cancelled/unavailable` 落 `*-denied` 审计行后抛结构化错误，零落盘。

### D3. 快照注入走 systemPrompt 段（order=-50），模型可见 ⟺ 落盘
- 冻结语义 = 会话内快照文本不变（前缀缓存稳定）。
- 快照文本同时落本地 audit 账本 + 经 `request/header.system` 入会话日志——两条独立证据链可重建（S2 不变量）。
- 快照头携带同步状态与预算用量（`[记忆S3] 已同步 2026-08-17T12:00Z · 3/5 条`）。

### D4. 混合检索引擎 = 向量余弦 top-k + 元数据过滤 + 关键词子串
- **向量**：嵌入器（可插拔）→ 余弦相似度 top-k（≤10k 条纯内存暴力足够，见 TECH_STACK 性能估算）。
- **关键词**：大小写不敏感子串匹配（继承 dsh-memento 决策 10 的教训：FTS5/unicode61 对 CJK 2 字查询无效）。
- **混合**：`recall(query)` 先向量 top-k（默认 20）→ 可选关键词/元数据过滤 → 合并排序返回。
- 中文语义召回依赖嵌入模型质量；关键词子串作为无嵌入时的降级路径（嵌入器不可用时 `search` 仍可用）。

### D5. 审计三链（继承 dsh-memento 决策 5）
- 写：`approval/asked`（reason 全文载荷）→ `approval/decided` → 本地 audit 账本行。
- 被拒写：`*-denied` 审计行。
- 召回/快照：audit(recalled)/audit(snapshot) 行（snapshot 行与注入文本逐字一致）。
- **rc.6 会话事件约束**：不 append 未注册的 memory/* 事件类型（`KNOWN_SESSION_EVENT_TYPES` 门），与 dsh-memento 同策略。

### D6. S3 对象布局：每条目一对象 + manifest 清单（详见 §3）
- 条目对象 `entries/<id>.json`：GET/PUT/DELETE 粒度最小、可版本化、删除即生效。
- `manifest.json`：数据面元数据（schema_version/updated_at/entry_count/checksums），写路径读改写。
- 乐观并发：PUT 带 `If-Match`（条目 ETag）；manifest 更新带 `If-Match`（防覆盖他人同步）。
- 无 bucket 版本控制依赖（默认关闭，不假设提供商支持）。

### D7. 凭据与网络面（明确披露，与 dsh-memento「零网络零凭据」哲学分岔）
- S3 凭据：环境变量 `AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/SESSION_TOKEN` 优先，其次 DSH 配置（骨架阶段仅环境变量；`dsh-credentials` 接入列为后续）。
- **凭据绝不进入条目字段/快照/审计**；秘密检测器（AK/SK 模式启发式）拒绝含凭据形状的写入。
- 网络面：仅出站 HTTPS 到配置的 S3 endpoint + 嵌入端点。无其他出站。插件权限声明如实披露 network/subprocess 面。

### D8. 错误处理与降级
- 结构化错误码：`S3_UNAVAILABLE` / `CONFLICT`（If-Match 失败）/ `EMBED_FAILED` / `BUDGET_EXCEEDED` / `INVALID_INPUT` / `DENIED`。
- 可重试错误（网络抖动/5xx）指数退避最多 3 次；仍失败 → 写标记 pending（骨架阶段仅日志），读走缓存降级并标注 stale。
- 加载期校验：bucket/prefix/endpoint 非法配置响亮失败（schemastery schema 层双保险）。

## 3. S3 对象布局

```
s3://<bucket>/<prefix>/
├── manifest.json            # {schema_version, updated_at, entry_count, checksum, last_sync}
├── entries/
│   └── <entry-id>.json      # 条目全文（含 embedding 数组），内容寻址可版本化
└── archive/                 # 会话摘要归档（P2）
    └── sessions/
        └── <session-id>.jsonl
```

**manifest.json 形状**：
```json
{
  "schema_version": 1,
  "updated_at": "2026-08-17T12:00:00.000Z",
  "entry_count": 3,
  "checksum": "sha256:...",
  "entries": [
    { "id": "uuid", "key": "entries/uuid.json", "etag": "\"abc123\"", "updated_at": "..." }
  ]
}
```

**并发写协议**：
1. 读 manifest（GetObject，取 ETag）
2. 写条目对象（PutObject with If-Match 条目旧 ETag 或 If-None-Match 创建）
3. 更新 manifest（PutObject with If-Match manifest ETag）；失败 → 重读合并（last-writer-wins 按 updated_at）

**对象生命周期**：条目删除 = DeleteObject（manifest 同步移除）；桶级 Lifecycle 规则仅用于 archive/ 冷归档（P2）。

## 4. 模块划分与依赖方向

```
index.mjs（唯一 DSH 依赖面：tools/systemPrompt/approval/on）
  ├── lib/s3store.mjs    ← node:http/fetch + crypto（SigV4）
  ├── lib/cache.mjs      ← node:fs + node:path
  ├── lib/embedder.mjs   ← fetch（可插拔）
  ├── lib/vector.mjs     ← 纯函数
  ├── lib/entry.mjs      ← 纯函数
  ├── lib/gate.mjs       ← 纯函数
  ├── lib/audit.mjs      ← node:fs（JSONL 追加）
  └── lib/strings.mjs    ← 纯函数
```

**红线**：`lib/` 零 DSH 依赖（只 node: 内置），任何 `@deepseek-ai/*` import 只允许出现在 `index.mjs`（继承 dsh-memento 质量约定）。测试用 mock S3（内存实现 `lib/s3store` 的接口）与真实 MinIO 冒烟双轨。

## 5. 数据流

### 写路径（save）
```
memory_s3_save 工具
  → MemoryService.save（entry 校验 → 嵌入（异步）→ 去重预检）
  → ctx.approval.request（reason 携带全文载荷）
  → outcome === allowed-once 才继续
  → S3Store.putEntry（If-Match/If-None-Match）+ manifest 更新
  → 本地缓存更新 + audit 行
  → 下一会话首 assemble：冻结快照从缓存渲染注入 systemPrompt 段
```

### 读路径（recall/search）
```
memory_s3_recall 工具
  → 缓存命中（同步）：向量 top-k + 过滤 → 返回（带 stale 标记）
  → 缓存缺失/过期：后台异步回源 S3 → 更新缓存 → 返回结果（标记刚同步）
```

### 同步路径（sync）
```
memory_s3_sync 工具 / 启动预热 / 会话事件驱动
  → GetObject manifest（带 If-None-Match: 缓存 ETag）
  → 变更则拉取增量条目 → 重建向量索引 → 更新缓存 + 审计
```

## 6. 安全模型

| 面 | 措施 |
|---|---|
| 传输 | HTTPS 强制（S3 endpoint 与嵌入端点均为 https://） |
| 静态 | 依赖 S3 服务端加密（SSE-S3 默认，可配 SSE-KMS）；本地缓存文件权限 0600 |
| 凭据 | 仅环境变量/DSH 配置；不进条目/快照/审计；秘密检测器拒绝写入 |
| 权限 | 最小权限 IAM/桶策略：仅单 prefix 读写（TECH_STACK.md 附 policy 示例） |
| 治理 | 审批门不可绕过；审计三链可重建；卸载不删云上数据（文档明示） |
| 信任域 | 单 bucket+prefix 单信任域；共享 = 共享数据（README 安全边界明示） |

## 7. 待调研确认的选型（TECH_STACK.md 落定）

1. S3 客户端：官方 `@aws-sdk/client-s3` vs 零依赖自实现 SigV4（fetch+crypto）——**依赖子代理 B 报告**
2. 向量检索：纯内存暴力余弦 vs 轻量索引库——**依赖子代理 C 报告**
3. 嵌入器：OpenAI 兼容端点 vs Ollama 本地 vs DSH provider 复用——**依赖子代理 C 报告**
4. DSH API 精确签名（tools.register/approval.request/systemPrompt.section）——**依赖子代理 A 报告**

---

*El Psy Kongroo.*
