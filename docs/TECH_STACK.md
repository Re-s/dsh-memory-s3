# dsh-memory-s3 技术选型（TECH_STACK）

> 状态：Initiation（v0.1 draft）｜日期：2026-08-17
> 选型依据：三路并行调研（DSH 插件 API / S3 客户端 / 向量与嵌入）+ dsh-memento 参考实现 + dev-preset 决策规则。

---

## 1. 语言与运行时

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | **JavaScript（纯 ESM）** | 与 dsh-memento 同风格：无构建步骤，`index.mjs`/`lib/` 即发布产物；插件不经 bundler |
| 运行时 | Node.js ≥ 20（目标 22+） | DSH rc.6 生态；`node:test` 内置测试 |
| 类型 | `.d.ts` 声明合并（tsc --checkJs 可选门） | 零构建类型契约，`ctx.memoryS3` 服务面类型化 |
| 构建 | **无** | Cordis 插件直跑，无编译 |

## 2. DSH 插件接口（实证自子代理 A 报告 + dsh-memento）

| 面 | 用法 | 要点 |
|---|---|---|
| 入口 | `export const name/inject` + `export function apply(ctx, config)` | `enabled:false` 整体 return；注册即 effect |
| 工具 | `ctx.tools.register(defineTool({...}))` | `output.schema` 必填、全链 `additionalProperties:false`；parameters 用 per-property `required:true`；`execute` 以 `exec.signal.throwIfAborted()` 开头 |
| 审批 | `ctx.approval.request({agent, toolName, reason, callId, signal})` | 唯一放行 `'allowed-once'`；answerer 注册 `{prepend:true}`；reason 带完整载荷 |
| 注入 | `ctx.systemPrompt.section({name, order, text})` | **提供者必须同步**（rc.6 不 await）→ 快照走本地缓存投影；order=-50 |
| 会话事件 | `ctx.on('session/event', (session, event))` | 自定义事件 append 前过 `KNOWN_SESSION_EVENT_TYPES.has()` 门 |
| Web | `ctx.get('webServer')` + `withService` 可选注册 | headless 自动跳过 |
| LLM | `ctx.llm.stream(GenerateOptions)` + `BlockAssembler` | 仅 P2 会话摘要用；**无 embedding 能力（实证）** |

## 3. S3 客户端（实证自子代理 B 报告，终审已定）

| 方案 | 体积（依赖树实测） | 结论 |
|---|---|---|
| 自实现最小 SigV4（fetch + crypto） | **零依赖** | ✅ **采用**：5 类请求（Get/Put/ListV2/Delete/Head）面窄、对象极小（1-2KB 单次 PutObject）、条件写只透传请求头；风险集中在 query 排序与 region/host 映射，冒烟测试覆盖四平台 |
| `minio@8.0.7` | 16 MB / 34 包 | 次选：ESM 官方构建；条件写需经 `metaData` hack（未实测） |
| `@aws-sdk/client-s3@3.1111.0` | **19 MB / 26 包** | ❌ 不采用：与零依赖哲学相悖；除非未来需分块上传/多区域签名再升级 |

**关键 API 事实（实证）**：
- AWS SDK named imports 在纯 Node ESM 下可用（实测 import 81ms）——但体积否决
- S3 条件写 GA：`If-None-Match: *`（创建，412/409）+ `If-Match`（更新）；无额外费用
- R2 需 `region=auto`；MinIO/自建 `us-east-1` 占位；OSS 用 region 匹配 endpoint
- 一致性：AWS/R2/OSS 强读后写；MinIO 需 xfs/zfs（ext4/NFS 不保证）
- 加密：四平台默认静态加密均达标（AWS SSE-S3 自动 / R2 AES-256 自动 / OSS AES256），**不引入 KMS**

## 4. 向量检索（实证自子代理 C 报告）

| 项 | 选择 | 理由 |
|---|---|---|
| 索引 | **零依赖纯内存暴力扫描**（Float32Array + 预归一化 + 余弦 top-k） | 10k×768 维 ≈ 10–40ms/查询、~30MB 内存；精确无召回损失；零安装零编译 |
| 升级路径 | sqlite-vec（选装） | 免编译、官方支持 node:sqlite（`{allowExtension:true}` + `sqliteVec.load(db)`）、vec0 支持 KNN+元数据 WHERE 一体过滤 |
| 持久化 | 条目 JSON 为真相源；检索索引内存重建（启动时重灌 ~秒级）；升级时可落独立 SQLite | 避免双写；语义「条目即真相」 |

**性能估算**（10k 条全扫，保守值）：

| 维度 | 耗时 | 内存 |
|---|---|---|
| 128 | ~2–7 ms | 5.1 MB |
| 384 | ~5–20 ms | 15.4 MB |
| 768 | ~10–40 ms | 30.7 MB |
| 1536 | ~20–80 ms | 61.4 MB |

## 5. 嵌入器（实证自子代理 C 报告）

| 项 | 选择 |
|---|---|
| 接口 | **可插拔 Embedder**：`embed(text) → Float32Array` |
| 默认实现 | **OpenAI 兼容 `/embeddings` 端点**（`text-embedding-3-small`，`dimensions: 768`），零依赖 fetch |
| 本地实现 | **Ollama `/api/embed`**（`nomic-embed-text` 768 维），零依赖 fetch |
| 维度 | **768 默认**（精度/内存/计算平衡；3-small 与多数本地模型自然支持） |
| 降级 | 嵌入器不可用时：`search`（关键词子串）仍可用；`recall` 返回 `embedder: 'none'` 状态与提示 |

**请求/响应形状**（OpenAI 兼容）：
```jsonc
// POST {baseUrl}/embeddings
{ "model": "text-embedding-3-small", "input": "...", "dimensions": 768, "encoding_format": "float" }
// 200
{ "object": "list", "data": [{ "object": "embedding", "index": 0, "embedding": [0.0023, ...] }], "usage": { "prompt_tokens": 24, "total_tokens": 24 } }
```

## 6. 混合检索策略（实证自子代理 C 报告）

```
recall(query, {type, tags, importanceMin}, k=10)
  1. 向量召回：embed(query) → 暴力 top-k×10（过滤条件扫描时应用）
  2. 关键词召回：LIKE '%子串%'（中文短词兜底；10k 全扫 ms 级）
  3. RRF 合并：score += w/(60+rank)，向量 w=1.0，关键词 w=0.7
  4. 返回 top-k，标注 stale（离线缓存视图）
```
- 高选择性过滤（importanceMin/type 缩到 ~1k）先过滤再向量；低选择性先向量后过滤
- **不引入中文分词器**（10k 规模收益极低；unicode61 对 CJK 不可用、trigram 需 ≥3 字符，实证）

## 7. 存储与一致性（架构层，详见 ARCHITECTURE.md §3）

| 项 | 选择 |
|---|---|
| 真相源 | S3 对象：`memories/{kind}/{id}.json`（每记忆一对象） |
| 清单 | **不建 manifest**（≤10k 规模无需全量遍历） |
| 本地缓存 | 索引 JSON + 条目 LRU（内存/磁盘 0600） |
| 一致性 | 条件写：`If-None-Match: *` 创建 / HeadObject+`If-Match` 更新；412/409 指数退避重试 |
| 版本控制 | 桶 versioning 开启（防误覆盖）；Lifecycle 仅 Expiration 清理 |
| 加密 | 各平台默认静态加密（不引入 KMS） |

## 8. 已确认的选型（原待定项，全部落定）

- [x] S3 客户端：自实现最小 SigV4（零依赖）
- [ ] 网络权限声明枚举值（dshWorkshop.permissions；骨架阶段 `network:https`，实现时对照 OMDSH 规范核验）
- [ ] approval/asked + approval/decided 事件载荷结构（dsh-user-approval 未读；审计链实现时对照）

## 9. 工具链（dev-preset Setup 阶段）

| 工具 | 配置 | 状态 |
|---|---|---|
| 编辑器 | `.editorconfig` | ✅ |
| 格式化 | `.prettierrc.json` | ✅ |
| Lint | （骨架阶段省略；正式开发可加 eslint） | 待定 |
| 测试 | `node --test`（`test/*.test.mjs`） | 计划 |
| 覆盖率 | `node --test --experimental-test-coverage` | 计划 |
| 提交 | Conventional Commits | 约定 |

---

*El Psy Kongroo.*
