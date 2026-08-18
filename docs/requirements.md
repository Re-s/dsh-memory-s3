# dsh-memory-s3（记忆S3）需求分析

> 状态：Initiation（v0.1 draft）｜日期：2026-08-17（记忆模型 v2.1 增补 2026-08-18）
> 作者：Hououin Kyouma（未来道具研究所，Lab Member No.001）
> 记忆模型 v2.1 设计定稿见 docs/MODEL.md。

---

## 1. 项目概述（What & Why）

### What
`dsh-memory-s3` 是一个 **DeepSeek Harness (DSH) 记忆插件**，将 agent 的跨会话记忆持久化到 **S3 兼容对象存储**（AWS S3 / MinIO / Cloudflare R2 / 阿里云 OSS），提供：

- **结构化记忆条目**：类型化事实/偏好/决策/项目状态/时刻/会话摘要，带元数据（importance/tags/source/timestamps + 可选 subject/timeline/links/locked）
- **向量语义检索**：嵌入向量 + 余弦相似度召回，与关键词过滤混合
- **本地缓存层**：减少 S3 往返，离线时优雅降级为只读缓存视图
- **写入审批门**：所有写入强制经过 DSH approval seam，可审计、可重建
- **Web 状态面板**：浏览记忆库、检索、查看同步状态（骨架阶段仅只读）

### Why
现有记忆插件的世界线各有收束点：

| 插件 | 存储 | 收束点（瓶颈） |
|---|---|---|
| `dsh-memento` | 本地 SQLite | 记忆困在单机 `$DSH_HOME`，换机器/多部署即失忆；无语义检索 |
| `dsh-mnemon` | 本地 Mnemon DB | 同上；且硬依赖外部 CLI 二进制 |
| `dsh-memory`（旧蓝图） | 本地 SQLite+FTS | 同上；FTS 对中文 2 字查询无效 |

**记忆S3 要欺骗的收束点**：把"记忆的位置"从"本地文件系统"迁移到"云上对象存储"——记忆不再随设备生死，而是栖身于对象存储的永恒之海。同一份记忆，任意机器、任意部署、任意 DSH 实例，只要握着同一把桶钥匙（bucket + prefix + 凭据），即可共享与续写。

## 2. 目标与非目标（Scope & Boundaries）

### 目标（In scope）
1. S3 兼容存储后端：条目 CRUD + 清单管理 + 乐观并发控制
2. 结构化记忆模型：`preference | project | decision | history | moment` 五类条目（v2.1 新增 moment 时刻类，对应 Tulving 情景记忆）
3. 向量语义检索：可插拔嵌入器 + 余弦 top-k + 元数据过滤
4. 本地缓存与离线降级：LRU 条目缓存 + 清单缓存；离线只读
5. 写入治理：DSH approval seam 审批门（service 内部强制点）+ 审计
6. 上下文注入：会话级冻结快照（跨会话记忆进入 systemPrompt）
7. 模型工具面：save/search/backlinks/recall/list/update/delete/forget/attach/get_file/detach/sync/status（13 工具）
8. 照片/文件附件：图片/PDF/压缩包/文本可挂载入条目，检索/快照可见元数据；本地文件三重校验（白名单/魔数/大小）
9. 会话摘要归档：会话结束自动提炼 → 待审提案（骨架阶段可选）

### 非目标（Out of scope，v0.1）
- 多租户/多用户隔离（单 prefix 单信任域）
- 跨进程强一致（多 DSH 实例并发写采用乐观锁，last-writer-wins 冲突合并策略）
- 大规模向量索引（HNSW/ANN 等；10k 条以下暴力余弦足够）
- 记忆加密传输之外的客户端加密（依赖 SSE-S3/SSE-KMS 服务端加密）
- 完整 Web 工作台（骨架阶段仅只读面板/状态接口）
- 第三方记忆生态桥接（Mnemon 等）

## 3. 用户画像与使用场景

### 画像
- **多机工作者**：在家用机与工作机/服务器间切换，希望 agent 记得自己的偏好与项目状态
- **多部署团队**：多个 DSH 实例（本机 + CI + 远端）共享同一记忆库
- **治理敏感用户**：要求写入有审批、行为可审计（dsh-memento 哲学的继承者）

### 场景
1. **跨机续写**：A 机上保存"用户偏好 Python + 中文交流"；B 机新会话自动注入该偏好
2. **项目记忆共享**：团队把项目决策写入共享桶，所有成员 agent 检索同一套决策史
3. **离线降级**：网络抖动时，检索走本地缓存（返回最近同步的索引），写入标记 pending
4. **语义召回**：记不住关键词但记得大意——"那个关于微波炉实验的笔记"→ 向量召回命中

## 4. 核心功能点（Must-haves）

| # | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F1 | S3 存储层 | bucket/prefix 配置、Get/Put/Delete/List/Head、自定义 endpoint（MinIO/R2/OSS） | P0 |
| F2 | 条目模型 | type/title/content/tags/importance/source/embedding/timestamps/version + 可选 subject/timeline/links/locked（v2.1 四字段） | P0 |
| F3 | CRUD 工具 | `memory_s3_save/search/recall/list/update/delete/forget` | P0 |
| F4 | 审批门 | 写操作强制 `ctx.approval.request`（ask/auto/off 策略） | P0 |
| F5 | 注入 | 会话冻结快照注入 systemPrompt（含预算头） | P0 |
| F6 | 向量检索 | 嵌入 + 余弦 top-k + type/tags 过滤 + 关键词混合 | P0 |
| F7 | 缓存 | 本地索引缓存 + LRU 条目缓存 + 离线降级 | P0 |
| F8 | 审计 | 写入/审批/召回/快照审计；可从会话日志重建 | P1 |
| F9 | 同步 | `memory_s3_sync` 手动/定时拉取远端变更（增量） | P1 |
| F10 | 会话摘要 | 会话结束 → LLM 提炼 → 待审提案 | P2 |
| F11 | 状态面板 | `memory_s3_status` + Web 只读面板 | P2 |
| F12 | 照片/文件附件 | `save` 携附件 / `memory_s3_attach` / `memory_s3_get_file` / `memory_s3_detach`；二进制存 `files/{id}` 不可变对象，条目只存元数据；扩展名白名单 + 魔法字节 + 大小上限三重校验 | P1 |
| F13 | 记忆模型 v2.1 | 类型新增 `moment`（共 5 类，对应 Tulving 情景记忆）；可选四字段 subject/timeline/links/locked 全链路；反链索引（lib/backlinks.mjs → 本地 backlinks.json，写 links 自动回填入边）+ `memory_s3_backlinks` 工具（工具总数 13）；locked 合并保护（跳过同 title 自动合并，显式写仍过审批门）；快照分层注入（Bonds 保底 40% → Moments 按新近 → Facts 按重要性，带 links 行尾 `→关联N` 标记，被引用数作排序信号） | P1 |

## 5. 约束条件（Constraints）

### 环境约束
- **Node.js ≥ 20**（目标 22+，`node:sqlite` 可用性依赖 22.19/24；骨架阶段不强制）
- **DSH 插件体系**：Cordis 4、`@deepseek-ai/dsh-tools` 等 peer 依赖（版本对齐 DSH rc 线）
- **无 bundler**：纯 ESM 直跑，依赖必须直接可加载
- **网络**：需要出站到 S3 端点（HTTPS）；无外网环境降级为缓存只读

### 安全约束
- **凭据永不落盘进记忆内容**：访问密钥仅来自环境变量/DSH 配置，不进条目字段
- **最小权限**：IAM/桶策略只允许单个 prefix 的读写（文档给出示例）
- **写入治理**：approval 策略为 Config，模型不可见不可改；会话级 `approval/never` 由审批服务硬拦截
- **敏感数据**：默认 SSE 加密；审计 reason 含写载荷（继承 dsh-memento 的透明度代价，文档明示）

### 质量约束（dev-preset）
- 行覆盖率 ≥ 80% / 分支 ≥ 75% / 函数 ≥ 80%（骨架阶段以冒烟测试起步，正式开发达标）
- Conventional Commits；文档必须文件齐备（README/CONTRIBUTING/LICENSE/CHANGELOG/.gitignore）
- 依赖最小化：优先零依赖内部实现，外部依赖须有正当理由

## 6. 验收标准（Acceptance Criteria）

1. **S3 存储**：在 MinIO（docker 本地）与真实 S3（可选）上完成条目 CRUD 往返；重启进程后记忆仍在
2. **注入**：新会话 systemPrompt 中出现跨会话记忆快照；预算头正确
3. **审批**：`ask` 策略下写操作产生 `approval/asked` 事件；拒绝后无任何落盘
4. **向量检索**：中文语义查询（非关键词字面匹配）能召回相关条目
5. **缓存降级**：拔网线后 `search/recall` 仍可用（返回缓存结果并标注 stale）
6. **审计重建**：从会话日志 + 审计记录可还原所有写入内容
7. **测试**：`node --test` 全绿；覆盖率达标
8. **文档**：README（安装/配置/安全边界）、ARCHITECTURE、SECURITY 齐备

## 7. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| S3 SDK 依赖树过大（官方 SDK） | 中 | 调研后决策：官方 SDK vs 自实现 SigV4（零依赖） |
| 多实例并发写冲突 | 中 | If-Match 乐观锁 + 冲突合并策略（content 拼接/时间戳胜出） |
| 中文语义检索质量 | 中 | 嵌入模型选择 + 关键词/向量混合召回；文档记录陷阱 |
| 嵌入 API 额外密钥与成本 | 低 | 可插拔 Embedder；可指向本地 Ollama 或 DSH provider |
| 审计表/日志无限增长 | 低 | auditRetentionDays 配置（默认 0 永久，文档警告） |
| 凭据泄露 | 高 | 秘密检测器（AK/SK 模式启发式）+ 凭据不进条目 + IAM 最小权限文档 |

---

*El Psy Kongroo.*
