# dsh-memory-s3（记忆S3）架构设计

> 状态：Initiation（v0.1 draft）｜日期：2026-08-17（附件能力增补 2026-08-18；记忆模型 v2.1 增补 2026-08-18，design 依据 docs/MODEL.md）
> 本文档描述模块边界、数据流、S3 对象布局、同步投影机制与安全模型。技术选型结论见 TECH_STACK.md，记忆模型设计定稿见 MODEL.md。

---

## 1. 总体架构

```
┌────────────────────────────────────────────────────────────────────────┐
│ DSH Harness (Cordis 4, rc.6)                                            │
│                                                                          │
│  Consumer 面：                                                            │
│   ├ ctx.tools        memory_s3_save/search/backlinks/recall/list/update/  │
│   │                  delete/forget/attach/get_file/detach/sync/status      │
│   ├ ctx.systemPrompt 冻结快照段（order=-50，同步提供者 + WeakMap 冻结）    │
│   └ ctx.webServer    只读状态面板（规划中，未实现）                 │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ 写（带 exec.agent/callId/signal）  读（同步走缓存）
               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Service Definition：ctx.memoryS3（index.mjs）                            │
│  save() search() recall() list() update() remove() forget() sync()       │
│  status() attach() detach() getFile() linkedTo()                         │
│  写路径（审批门不可绕过）：                                                │
│    嵌入(异步) ─▶ 去重预检     ─▶ ctx.approval.request ─▶ 落盘 S3 ─▶ 审计  │
│    附件路径：本地探测(filemeta)─▶ 审批(元数据摘要)─▶ 上传 files/{id} ─▶ 条目│
│  读路径：缓存优先（同步），缺失/过期时后台异步回源 S3                       │
└──────────────┬───────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────────┐
│ lib/（纯逻辑，零 DSH 依赖，只依赖 node: 内置）                            │
│  s3store.mjs    S3 对象布局 + CRUD + 乐观并发（If-Match）                 │
│  cache.mjs      本地缓存：索引 JSON + 条目 LRU（内存/磁盘）                │
│  embedder.mjs   嵌入接口 + OpenAI 兼容实现（fetch）                       │
│  vector.mjs     余弦相似度 top-k + 元数据过滤（纯 JS）                    │
│  entry.mjs      条目模型校验/规范化/序列化（含附件元数据 + v2.1 四字段）    │
│  backlinks.mjs  反链索引（links 入边镜像，本地 backlinks.json 持久化）      │
│  filemeta.mjs   附件探测：白名单/魔数嗅探/大小上限/sha256（纯 node）       │
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
- 缓存 = 上次同步的本地索引（cache 的 `index.json`：记录 lastSync/ok）+ 条目副本；启动时异步预热，会话事件驱动触发同步。
- 无缓存首启时快照渲染为空 + 提示「记忆尚未同步」；`memory_s3_sync` 手动触发全量拉取。
- 离线降级：检索走缓存视图，结果标注 `stale: true`；写入标记 `pending`（骨架阶段仅记录，不队列重放）。

### D2. 审批门做在 Service 写方法内部（继承 dsh-memento 决策 2，Hermes #48181 教训）
- 任何路径调 `ctx.memoryS3.save/update/remove/attach/detach` 必然经过 `ctx.approval.request`（附件挂/摘同属写操作，审批门不可绕过）。
- `writePolicy`（ask/auto/off，默认 ask）是 Config，模型不可见不可改；会话级 `approval/never` 由审批服务硬拦截，插件不可绕过。
- **approve-what-you-see**：审批 reason 携带完整写载荷——save/update 含新旧全文，remove 含被删全文；附件写操作携带**附件元数据摘要**（id/name/mime/kind/size/sha256 前缀），**二进制内容不进 reason**。
- **被拒写留痕**：`rejected/cancelled/unavailable` 落 `*-denied` 审计行后抛结构化错误，零落盘。

### D3. 快照注入走 systemPrompt 段（order=-50），模型可见 ⟺ 落盘
- 冻结语义 = 会话内快照文本不变（前缀缓存稳定）。
- 快照文本同时落本地 audit 账本 + 经 `request/header.system` 入会话日志——两条独立证据链可重建（S2 不变量）。
- 快照头携带同步状态与预算用量（`[记忆S3] 已同步 2026-08-17T12:00Z · 3/5 条`）。
- 快照内容 = **分层注入**（v2.1，见 D9）：Bonds 保底 → Moments → Facts，由 `maxInjectedItems` 预算控制。

### D4. 混合检索引擎 = 向量余弦 top-k + 元数据过滤 + 关键词子串
- **向量**：嵌入器（可插拔）→ 余弦相似度 top-k（≤10k 条纯内存暴力足够，见 TECH_STACK 性能估算）。
- **关键词**：大小写不敏感子串匹配（继承 dsh-memento 决策 10 的教训：FTS5/unicode61 对 CJK 2 字查询无效）。
- **混合**：`recall(query)` 先向量 top-k（默认 20）→ 可选关键词/元数据过滤 → 合并排序返回。
- 中文语义召回依赖嵌入模型质量；关键词子串作为无嵌入时的降级路径（嵌入器不可用时 `search` 仍可用）。

### D5. 审计三链（继承 dsh-memento 决策 5）
- 写成功落一条审计行，行名为动作名：`save` / `update` / `remove` / `forget` / `attach` / `detach` / `sync` / `recalled` / `file-retrieved` / `attachment-rollback` / `snapshot`（见 lib/audit.mjs append 调用点）。
- 被拒 / 审批不可用（unavailable / rejected / cancelled）：落 `${action}-denied` 审计行（`outcome` 记录拒绝态），零落盘后抛 `DENIED`。
- 快照：`audit('snapshot')` 行与注入文本逐字一致（模型可见 ⟺ 落盘，S2 不变量）。
- **rc.6 会话注入约束**：本插件按 DSH 同步注入约束仅作系统提示段提供，不 append 自定义会话事件类型（session/event 面与本插件单链交叉点不延伸事件类型）——审计链在本插件内部为单账本简化，与 dsh-memento 的已知事件类型门同策略。

### D6. S3 对象布局：每记忆一对象 + 桶版本控制（详见 §3，实证自 S3 调研）
- 条目对象 `memories/{kind}/{id}.json`：GET/PUT/DELETE 粒度最小、删除即生效、冲突面最小（不同 key 互不干扰）。
- **不建 manifest 清单**：≤10k 规模无需全量遍历；日常检索按 id 直读 / 按 kind 前缀 ListObjectsV2 即可。
- 乐观并发（S3 条件写 GA）：**创建**用 `If-None-Match: *`（已存在返回 412/409）；**更新**用 HeadObject 取 ETag + `If-Match: <etag>` PUT；412/409 → 重读-合并-指数退避重试（≤3 次）。
- 桶版本控制：建议开启（防误覆盖低成本保险；单条 1-2KB 存储翻倍可忽略）。
- 生命周期：仅对删除标记/旧版本设 Expiration 清理；**不转冷存储**（Glacier 等 40KB/对象固定开销对 1-2KB 记忆对象转冷反而亏钱）。

### D7. 凭据与网络面（明确披露，与 dsh-memento「零网络零凭据」哲学分岔）
- S3 凭据：**仅环境变量** `AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/SESSION_TOKEN`（`accessKeyEnv`/`secretKeyEnv` 可改名），进程内读取，绝不落盘；`dsh-credentials` 接入列为后续。
- **非敏感配置（bucket/endpoint/region/prefix/writePolicy 等）经 DSH 官方 `ctx.settings` 缝三层解析**：schema 默认 → entry config（`cordis.patch.yml` base）→ 用户设置段（`settings.yaml` 顶层 `memory-s3:`；本插件无浏览器半侧，故无 GUI 表单入口，见 README「关于 GUI」）——凭据与配置严格分离，配置文档永不承载凭据。
- **凭据绝不进入条目字段/快照/审计**；秘密检测器（AK/SK 模式启发式）拒绝含凭据形状的写入。
- 网络面：仅出站 HTTPS 到配置的 S3 endpoint + 嵌入端点。无其他出站。插件权限声明如实披露 network/subprocess 面。

### D8. 错误处理与降级
- **领域错误码**（DOMAIN_CODES，工具层转为 `{ok:false, error:{code,message}}`；对齐 index.mjs DOMAIN_CODES）：
  `INVALID_INPUT` / `NOT_FOUND` / `SECRET_DETECTED`（秘密检测命中，含附件文本内容）/ `DENIED`（审批拒绝或不可用）/ `CONFLICT`（If-Match/If-None-Match 失败）/ `FILE_NOT_FOUND`（附件本地路径不存在）/ `FILE_TOO_LARGE`（附件超 maxFileBytes）/ `UPLOAD_REJECTED`（扩展名/魔数白名单拒绝）/ `CORRUPT_FILE`（附件下载 sha256 不符）
- **基础设施错误**（非 ok:false 路径，原样抛出）：`S3_UNAVAILABLE`（网络/5xx，retryable，指数退避 ≤3 次）/ `EMBED_FAILED`（嵌入失败，仅日志降级不阻塞写入）/ `S3_ERROR`（其余 4xx，配置错误响亮失败）
- 可重试错误（网络抖动/5xx）指数退避最多 3 次；仍失败 → 写标记 pending（骨架阶段仅日志），读走缓存降级并标注 stale。
- 加载期校验：bucket/prefix/endpoint 非法配置响亮失败（schemastery schema 层双保险）；`maxFileBytes` 非正数 / `allowedFileTypes` 空串成员同样响亮失败（SECURITY.md §8）。

### D9. 记忆模型 v2.1：五类型 + 四字段 + 反链 + 分层注入（design 定稿 docs/MODEL.md）

- **类型五类**：`preference | project | decision | history | moment`（moment = 情景记忆，Timeline：时刻/照片/纪念日；与语义三类分型对应 Tulving 三分法）。存量四类型语义不变，moment 对旧数据零影响（兼容演进）。
- **四维字段全可选**：`subject`（主体）/ `timeline`（时间线归属）/ `links`（关联条目 id）/ `locked`（锁定保护，默认 false 恒落盘，其余缺省不落盘）。save/update 工具与 ENTRY_OUTPUT 全链路支持（MODEL.md §5）。
- **locked 合并保护**：locked 条目跳过同 (type,title) 自动合并——本地查重（`#findByTitle`）与远端预检（`#findRemoteByTitle` / CONFLICT 读回）均跳过；显式 update/remove 仍过审批门（防的是模型无意自动覆盖，不是主人意志）。
- **反链索引（L1 无类型双向引用）**：条目 A 的 `links` 含 B → 本地索引记 B 的入边含 A（MODEL.md §6）。写入路径 `service.save/update` 落条目后调 `lib/backlinks.addForward`（替换语义：先清旧出链再写新边），`remove` 调 `removeForward` 清出链；索引持久化 `cacheDir/backlinks.json`（0600），损坏降级为空不阻塞启动。**不落盘条目字段、不写 S3**——S3 对象依旧只有正向声明（引用即链接，Obsidian/Zettelkasten 心智）。查询面：`service.linkedTo(id)` → `memory_s3_backlinks` 工具（读路径，无审批）；悬空引用（目标已删）容错跳过。
- **分层快照注入**（service.snapshotText，index.mjs）：三层三桶 + 预算填充：
  1. **Bonds**：`locked` 或 `preference importance≥5`（约定守护型，永不沉底），保底 `max(1, ceil(cap×0.4))` 条（40% 预算）；
  2. **Moments**：`type=moment` 按 `updatedAt` 新近（情景记忆易逝，优先呈现近期时刻）；
  3. **Facts**：其余 importance ≥ threshold 条目，按 importance 降序、同分按被引用数（图中心性信号，`backlinks.allCounts()`）。
  行尾标记：带附件 → ` 📎文件名`（48 字符截断，v0.1）；带 links → ` →关联N`（出链数，v2.1）。
- **图中心性**：被引用数是 Bonds/Facts 排序的信号（MODEL.md §8：注入分数含关系度；双链笔记"被引用数 = 注入优先级"心智）——L1 用计数，L2 规划 1-2 跳邻接摘要注入。

## 3. S3 对象布局（实证自 S3 调研子代理）

```
s3://<bucket>/<prefix>/
├── memories/
│   ├── {kind}/
│   │   └── <entry-id>.json      # 条目全文（含 embedding 数组 + 可选 attachments 元数据数组）
│   │                            # kind = preference|project|decision|history|moment
└── files/
    └── <attachmentId>           # 附件二进制（无扩展名；mime/name 在条目附件元数据）
```

**附件对象（files/ 面，v0.1 新增）**：
- **不可变**：`attachmentId` = uuid（`randomUUID`），创建走 `PutObject + If-None-Match: *`（撞键返回 412/409 → `CONFLICT`，同 id 重复上传不可能）；写入后不修改，更新语义由 detach + attach 组合表达。
- **与文件名解耦**：对象键不含用户文件名（文件名仅存元数据 `name`）→ 防路径注入、防后缀伪装；下载时从 `name` 推导扩展名（`extensionOf`），本地文件名为 `<id>.<ext>`。
- **完整性**：探测时计算 sha256 存入元数据；`getFile` 下载后重算比对，不一致 → `CORRUPT_FILE` 拒绝落盘（损坏数据不落地）。
- **脚本/可执行载荷拒绝**：白名单制（11 种扩展名），SVG 故意不在白名单（XML 可含脚本载荷，XSS 披露，见 SECURITY.md）；本地探测经 `lib/filemeta.mjs` 三层校验（扩展名白名单 + 魔法字节嗅探 + 大小上限）。

**条目附件元数据形状**（= `MemoryS3Attachment`，见 types.d.ts；结构挂条目 JSON 的 `attachments` 数组）：
```json
{
  "id": "uuid",
  "name": "photo.png",
  "mime": "image/png",
  "kind": "image",
  "size": 4096,
  "sha256": "64-hex-digest",
  "objectKey": "files/<uuid>",
  "note": "可选说明",
  "createdAt": 1789000000000
}
```

**条目对象形状**（= `MemoryS3Entry` 的 JSON 序列化，见 types.d.ts）：
```json
{
  "id": "uuid",
  "type": "moment",
  "title": "risu 的睡颜",
  "content": "2026-08-18 午后…",
  "tags": ["时刻"],
  "importance": 4,
  "source": "tool",
  "createdAt": 1789000000000,
  "updatedAt": 1789000000000,
  "recallCount": 0,
  "lastRecalled": null,
  "subject": "risu",            // 可选：主体（me | risu | us | world 或任意字符串）
  "timeline": "α-2",            // 可选：时间线归属（α-2 | β | steins-gate | 2026-08）
  "links": ["<other-entry-id>"],// 可选：关联条目 id（引用即链接；被引用方反链自动回填本地索引）
  "locked": false,              // 必序列化字段：锁定保护（默认 false；跳过同 title 自动合并）
  "embedding": [0.0023, -0.011],
  "workspaceKey": "",
  "agentKey": "",
  "attachments": [
    { "id": "uuid", "name": "photo.png", "mime": "image/png", "kind": "image",
      "size": 4096, "sha256": "64-hex-digest", "objectKey": "files/<uuid>",
      "createdAt": 1789000000000 }
  ]
}
```

> 序列化规则（lib/entry.mjs toJSON）：`locked` 恒落盘（默认 false）；`subject`/`timeline` 仅在存在时落盘；`links` 仅在非空时落盘；`backlinks` **不落条目 JSON**——由本地索引（lib/backlinks.mjs → `cacheDir/backlinks.json`）维护，不污染 S3 对象（MODEL.md §5/§6）。

**并发写协议**（条件写，无锁数据库语义）：
1. **创建**：PutObject with `If-None-Match: *`；412/409（已存在）→ 读回合并或重试
2. **更新**：HeadObject 取 ETag → PutObject with `If-Match: <etag>`；412（被并发修改）→ 重读-合并-指数退避（≤3 次）
3. **附件对象**：PutObject with `If-None-Match: *`（不可变创建）；删除走 DeleteObject（幂等，versioning 下可恢复）
4. **删除**：DeleteObject（versioning 下产生删除标记，可恢复）

**一致性**：AWS/R2/OSS 均强读后写（无需读重试补偿）；自建 MinIO 需 xfs/zfs（ext4/NFS 不保证）——文档明示。

**对象生命周期**：桶 versioning 开启；Lifecycle 仅 Expiration 清理删除标记/旧版本；不转冷存储。

## 4. 模块划分与依赖方向

```
index.mjs（唯一 DSH 依赖面：tools/systemPrompt/approval/on）
  ├── lib/s3store.mjs    ← node:http/fetch + crypto（SigV4）
  ├── lib/cache.mjs      ← node:fs + node:path
  ├── lib/embedder.mjs   ← fetch（可插拔）
  ├── lib/vector.mjs     ← 纯函数
  ├── lib/entry.mjs      ← 纯函数
  ├── lib/backlinks.mjs  ← node:fs + node:path（反链索引，本地 JSON 持久化）
  ├── lib/filemeta.mjs   ← node:fs + node:crypto（附件探测）
  ├── lib/gate.mjs       ← 纯函数
  ├── lib/audit.mjs      ← node:fs（JSONL 追加）
  └── lib/strings.mjs    ← 纯函数
```

**红线**：`lib/` 零 DSH 依赖（只 node: 内置），任何 `@deepseek-ai/*` import 只允许出现在 `index.mjs`（继承 dsh-memento 质量约定）。测试用 mock S3（内存实现 `lib/s3store` 的接口）与真实 MinIO 冒烟双轨。

## 5. 数据流

### 写路径（save）
```
memory_s3_save 工具（可选 attachments:[{path, note?}]）
  → 本地探测（lib/filemeta：扩展名白名单 + 魔数嗅探 + 大小上限；文本类内容过秘密检测）
  → MemoryS3Service.save（entry 校验 → 嵌入（异步）→ 去重预检）
  → ctx.approval.request（reason 携带全文载荷 + 附件元数据摘要，二进制不进 reason）
  → outcome === allowed-once 才继续
  → 上传附件 files/{id}（PutObject + If-None-Match: *）→ S3Store.putEntry（If-Match/If-None-Match）
  → 本地缓存更新 + audit 行（含 attachment-rollback 回滚留痕）
  → 下一会话首 assemble：冻结快照从缓存渲染注入 systemPrompt 段（附件条目行尾 📎文件名列表，48 字符截断）
```

### 附件写路径（attach / save 合并路径的附件追加）
```
memory_s3_attach 工具
  → 本地探测（同上三层校验 + 文本秘密检测）→ 构造不可变元数据（uuid id、files/{id} key、sha256）
  → ctx.approval.request（reason 含附件元数据摘要）
  → PUT files/{id}（If-None-Match: *）→ 条目附件元数据追加（If-Match 乐观锁）→ 缓存 + 审计
  → 任一步失败 → 尽力回滚已上传对象（DELETE 幂等）+ attachment-rollback 审计
```

### 附件下载路径（get_file）
```
memory_s3_get_file 工具
  → 条目缓存命中 → 附件元数据存在性校验（无 → NOT_FOUND）
  → GET files/{id}（binary 读取）→ 对象缺失 → NOT_FOUND
  → 重算 sha256 与元数据比对（不符 → CORRUPT_FILE，拒绝落盘）
  → 写入 <cacheDir>/files/<id>.<ext>（或 dir=...；文件权限 0600）
  → audit(file-retrieved) 行 → 返回本地路径与元数据
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
  → s3store.listObjects 分页（prefix memories/ + continuationToken）拉全量远端 key
  → 逐条 getObject → fromJSON 解析（单条损坏 warn + 跳过，账本可重建性优先）
  → cache.putEntry 更新本地缓存 → 分页续拉直至 token 耗尽
  → cache.setIndex({lastSync, ok:true}) + cache.setStale(false)
  → audit('sync') 行 {pulled, outcome:'ok'} → 返回 {ok, pulled, updatedAt}
失败 → cache 标 ok:false + setStale(true) + audit('sync' {outcome:'failed'})
      → 返回 {ok:false}（离线降级读缓存仍可用）
```
> 同步为**全量拉取**（listObjects 分页遍历 memories/ 前缀），不做 manifest/增量比对；每次 sync 重建缓存索引视图，由本地条目副本承担注入所需的只读投影。

### 反链数据流（v2.1：写 links → 本地反链索引 → linkedTo 查询）
```
memory_s3_save/update 写入 links（出链，替换语义）
  → service 落条目后调 lib/backlinks.addForward(entryId, links)
      （先清该条目旧出链，再写入边；自引用/坏 id 拒绝——MODEL.md §6 L1）
  → 索引同步持久化 cacheDir/backlinks.json（0600；失败降级内存态）
  → memory_s3_backlinks 工具 → service.linkedTo(id)
      （读路径无审批；悬空目标不存在于缓存则跳过——容错）
  → 快照注入读取 allCounts()（被引用数）作 Bonds/Facts 同分排序信号
  → 渲染：带出链条目行尾标记 →关联N；带附件标记 📎文件名
删除路径：service.remove 调 removeForward 清出链（目标侧悬空引用渲染容错）
```

## 6. 安全模型

| 面 | 措施 |
|---|---|
| 传输 | HTTPS 强制（S3 endpoint 与嵌入端点均为 https://） |
| 静态 | 依赖 S3 服务端加密（SSE-S3 默认，可配 SSE-KMS）；本地缓存文件权限 0600（含下载附件与 backlinks.json） |
| 凭据 | 仅环境变量/DSH 配置；不进条目/快照/审计；秘密检测器拒绝写入（含文本类附件内容） |
| 附件 | 白名单制（11 种扩展名 + 魔数嗅探一致，SVG 拒绝）；大小上限 20MB（maxFileBytes 可配）；附件二进制不进审批 reason 与审计（只进元数据摘要）；下载 sha256 校验防篡改；文件名与对象键解耦（防路径注入/后缀伪装） |
| 权限 | 最小权限 IAM/桶策略：仅单 prefix 读写（memories/* + files/*，TECH_STACK.md 附 policy 示例） |
| 治理 | 审批门不可绕过；审计三链可重建；卸载不删云上数据（文档明示） |
| 信任域 | 单 bucket+prefix 单信任域；共享 = 共享数据（README 安全边界明示） |

## 7. 选型终审（已落定，详见 TECH_STACK.md）

| 项 | 结论 | 依据 |
|---|---|---|
| S3 客户端 | **自实现最小 SigV4**（node:crypto + fetch，零依赖）；备选 minio@8.0.7；不采用 @aws-sdk/client-s3 | B 报告：19MB/26 包 vs 零依赖；5 类请求面窄可控 |
| 向量检索 | 零依赖纯内存暴力扫描（Float32Array + 预归一化）；升级路径 sqlite-vec | C 报告：10k×768 ≈ 10-40ms、30MB |
| 嵌入器 | 可插拔；默认 OpenAI 兼容端点（text-embedding-3-small，dimensions=768）；本地 Ollama /api/embed | C 报告：dsh-llm 无 embedding（实证） |
| DSH API | tools.register / approval.request / systemPrompt.section / session/event（见 §2） | A 报告 + dsh-memento 实证 |

## 8. 待补查项（实现阶段处理）

- approval/asked + approval/decided 事件载荷结构（dsh-user-approval 未读）——审计链实现时对照
- dshWorkshop.permissions 出站网络枚举的合法写法（骨架阶段声明 `network:https`，文档标注待核）
- MinIO 条件 PUT（If-Match/If-None-Match）实测——冒烟测试时验证

---

*El Psy Kongroo.*
