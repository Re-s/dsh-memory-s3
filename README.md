# dsh-memory-s3（记忆S3）

> 云端跨会话记忆插件 for DeepSeek Harness：结构化条目 + 向量检索，持久化于 S3 兼容对象存储（AWS S3 / MinIO / Cloudflare R2 / 阿里云 OSS）。

记忆不再困于单机——只要握着同一把桶钥匙，任何机器、任何部署、任何 DSH 实例都能共享与续写同一份记忆。**记忆S3** 欺骗的收束点是"记忆的位置"：从本地文件系统，迁移到对象存储的永恒之海。

## ✨ 特性

- **S3 兼容存储后端**：条目 CRUD + listObjects 同步 + 乐观并发（If-Match）；自定义 endpoint 兼容 MinIO/R2/OSS
- **结构化记忆模型 v2.1**：`preference | project | decision | history | moment` 五类条目（moment = 时刻/照片/纪念日，对应 Tulving 情景记忆），带 importance/tags/source/时间戳 + 可选四维字段：`subject`（主体）/ `timeline`（时间线归属）/ `links`（关联引用）/ `locked`（锁定保护）
- **向量语义检索**：可插拔嵌入器 + 余弦 top-k + 元数据/关键词混合召回（中文友好）
- **本地缓存投影**：冻结快照只读本地缓存（rc.6 同步注入约束），S3 异步回源，离线降级只读
- **写入审批门**：所有写操作强制 DSH approval seam（ask/auto/off），模型不可见不可改
- **审计三链**：审批对 + 审计账本 + 快照，可从会话日志重建全部写入
- **照片/文件附件**：条目可挂照片/文件——二进制存 S3 `files/{id}` 不可变对象（uuid 键 + If-None-Match 创建 + sha256 完整性），条目 JSON 只存附件元数据数组；本地文件经扩展名白名单 + 魔法字节嗅探 + 大小上限（20MB）三重校验；`memory_s3_attach` / `memory_s3_get_file` / `memory_s3_detach` 三工具
- **反链索引（v2.1）**：写入 `links`（引用即链接，Obsidian/Zettelkasten 心智）自动回填本地反链索引（`lib/backlinks.mjs` → `backlinks.json`，0600 持久化，替换语义）；`memory_s3_backlinks` 查询「谁引用了该条目」（读路径无审批）；被引用数（图中心性）是快照注入的排序信号
- **分层快照注入（v2.1）**：冻结快照按 Bonds（locked / 高重要性约定，保底 40% 预算）→ Moments（moment 按新近）→ Facts（按 importance，同分按被引用数）三层投影；带 links 的条目行尾自动标记 `→关联N`；`locked` 条目跳过同 title 自动合并（防无意覆盖）
- **会话摘要归档**（规划）：会话结束自动提炼 → 待审提案

## 🚀 快速开始

### 前置要求

- Node.js ≥ 20（推荐 22+）
- DeepSeek Harness（`dsh` CLI，rc.6+），两种获取方式：
  - **全局安装**（推荐，一劳永逸）：`npm install -g @deepseek-ai/dsh`
  - **免安装调用**（新机器/容器首选）：`npx @deepseek-ai/dsh`（与 `dsh` 完全等价，本文命令两种前缀可互换）
- 一个 S3 兼容对象存储桶（AWS S3 / MinIO / R2 / OSS）

### 安装

从 GitHub 获取（推荐，pnpm 语法，`dsh plugin add` 透传）。以下以 `npx @deepseek-ai/dsh` 为例（无需全局安装）；已全局安装 `dsh` 时，将 `npx @deepseek-ai/dsh` 替换为 `dsh` 即可：

```bash
# 方式一：HTTPS 直接安装
npx @deepseek-ai/dsh plugin --profile web add https://github.com/Re-s/dsh-memory-s3.git

# 方式二：指定分支（如 main）/ tag / commit
npx @deepseek-ai/dsh plugin --profile web add https://github.com/Re-s/dsh-memory-s3.git#main

# 方式三：SSH 方式（需配置 GitHub SSH key）
npx @deepseek-ai/dsh plugin --profile web add git@github.com:Re-s/dsh-memory-s3.git
```

本地开发（源码调试，link 方式）：

```bash
git clone https://github.com/Re-s/dsh-memory-s3.git
npx @deepseek-ai/dsh plugin --profile web add "link:/path/to/dsh-memory-s3"
```

配置环境变量：

```bash
# S3 凭据（必需；进程内读取，不落盘，绝不进配置文档）
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...   # 可选，临时凭据

# 向量召回嵌入（仅当 embedder.provider=openai-compatible 时用；provider=none 则不需要）
export OPENAI_API_KEY=...      # 或按 embedder.apiKeyEnv 改名的变量
```

> 凭据只走环境变量；**bucket / endpoint / region / prefix / writePolicy 等非敏感配置**经官方 `ctx.settings` 缝（见下）配置——配置与凭据严格分离。

### 配置（符合 DSH 官方设置缝 `ctx.settings`）

> 本插件已接入 DSH 官方 `ctx.settings` 缝。配置经三层解析：
> **schema 默认值 → 该插件条目配置（`cordis.patch.yml` 的 entry config，composition base）→ 用户设置段（`settings.yaml` 顶层 `memory-s3:`）**。
> 未挂载 settings 服务的 profile 自动回退到 entry config alone（官方契约：无 provider 时插件不受影响）。
>
> S3 凭据只从环境变量读取（`accessKeyEnv`/`secretKeyEnv`，默认 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`），绝不落盘、绝不进设置文档。

**装完还没配 bucket 时会怎样（0.2.2+）**：插件保持存活但待机，不注册任何工具/注入，启动日志给出一条告警：

```
[memory-s3] bucket not configured; plugin stands by (no tools/injection registered).
Set a bucket in the "memory-s3" settings section, then restart the profile.
```

profile 正常启动、GUI 正常打开，插件在设置的 **Plugin list** 只读清单里可见。填好 bucket 后重启生效（配置变更契约为 `applies: 'restart'`）——配置请改 `settings.yaml`，本插件没有 GUI 表单入口，原因见下节。

> 0.2.1 及更早版本存在启动死锁：`bucket` 在 schema 层必填，而 cordis 加载器在 `apply()` 之前校验 entry config，未配置时直接抛 `$.bucket missing required value` 并使**整个 profile 启动失败**，连 GUI 都打不开，也就无从配置。若你卡在这个版本，临时解法是在 profile 的 `cordis.patch.yml` 里给 `- id: memory-s3` 补一个 `config.bucket` 占位值；建议直接升级到 0.2.2+。

#### 关于 GUI：为什么设置里没有本插件的表单入口

Web 设置的 **Plugins** 分区有两个标签页，本插件只出现在前者：

| 标签页 | 由谁提供 | 本插件 |
|---|---|---|
| **Plugin list**（只读清单） | `dsh-client-ui-settings-plugin-inventory` | ✅ 可见 |
| **Plugin configuration**（可编辑表单） | `dsh-client-ui-settings-plugins` | ❌ 无入口 |

官方对 Plugin configuration 标签页的渲染规则是**双账本交集**：

> The tab reads which settings namespaces the Host serves and dispatches one slot key per namespace, so what renders is the intersection of two ledgers: the namespaces a live Host plugin registered, and the cards registered under those keys. **A served namespace no card claims renders nothing.**

即：注册了 settings 命名空间**只是必要条件**，还需要一张认领该命名空间的「卡片」。而卡片必须由插件自带浏览器半侧，官方在 Known Limitations 中明确了门槛：

> **A card still needs a browser bundle** — the browser half must be a `dsh.client` package built in the client module system's lazy-CJS factory format, and the `clientBundle` preset that emits it lives in `packages/client/tsdown.client.ts` rather than a published package, **so a plugin outside this repository has to reproduce that build itself.**

本插件是纯 Host 侧插件、不含浏览器 bundle，因此没有可视化表单。**这不影响配置能力**：`settings.yaml` 的 `memory-s3:` 段照常参与官方三层解析（schema 默认 → entry config → 用户设置段），命名空间也已正常注册（否则该段不会生效）。

> 另一条官方限制值得知道：命名空间的注册**不会**主动推送给前端——「the wire announces settings-document commits and connection resets, not registrations」，所以新注册的命名空间要等下一次设置文档提交或重连才会进入前端列表。

#### 方式一：官方设置缝（推荐）——`$DSH_HOME/settings.yaml`

在 `settings.yaml` **顶层**写 `memory-s3:` 段（不是旧文档的 `plugins.memory-s3` 子段）：

```yaml
memory-s3:
  enabled: true
  bucket: my-memory-bucket
  prefix: dsh-memory-s3 # ⚠️ 多设备共享时必须逐字一致，详见下节「prefix 必须跨设备一致」
  endpoint: ""          # 留空用 AWS；MinIO/R2 填 https://...
  region: us-east-1
  writePolicy: ask      # ask | auto | off
  snapshotOrder: -50    # systemPrompt 注入段顺序
  maxInjectedItems: 5   # 快照注入条数上限
  importanceThreshold: 3 # 进入"事实层"注入候选的重要性下限
  embedder:
    provider: openai-compatible
    endpoint: https://api.openai.com/v1/embeddings
    apiKeyEnv: OPENAI_API_KEY
    model: text-embedding-3-small
    dimensions: 768    # 显式覆盖；text-embedding-3-small 常见 1536，此处代码默认 768
  cacheDir: ""          # 留空 = $DSH_HOME/dsh-memory-s3/cache
  auditRetentionDays: 0 # 0 = 永久保留
  maxFileBytes: 20971520      # 附件大小上限（字节；默认 20MB，>100MB 时加载告警）
  allowedFileTypes: [png, jpg, jpeg, gif, webp, pdf, zip, txt, md, json, csv]  # 附件扩展名白名单（小写，无点）
```

#### 方式二：entry config（composition base）

在 profile 的 `cordis.patch.yml` 以小写 id 覆盖该条目的 `config`（整体替换语义）：

```yaml
- id: memory-s3
  config:
    enabled: true
    bucket: my-memory-bucket
    endpoint: ""
    region: us-east-1
    writePolicy: ask
    embedder:
      provider: none
```

用户设置段（方式一）中出现的字段会覆盖 entry config 的同名字段；entry config 又覆盖 schema 默认值。

### ⚠️ prefix 必须跨设备一致（最容易踩的坑）

`prefix` 决定对象根路径，最终键为：

```
{bucket}/{prefix}/memories/{type}/{id}.json
{bucket}/{prefix}/files/{id}            # 附件
```

`prefix` 留空则直接落在桶根（`{bucket}/memories/...`）。

**同一个桶里，prefix 不同 = 两份互不可见的记忆库。** 而且失败方式极具误导性：

```
memory_s3_status  → configured: true, sync: ok
memory_s3_list    → 0 entrie(s)
```

同步**成功**、却**一条都没有**——因为插件在你配的那个 prefix 下确实什么都没有，而它无从知道数据其实躺在隔壁。没有任何报错，看起来就像「桶是空的」。

排查方法是绕过插件直接列桶（凭据取自环境变量）：

```bash
curl -s --aws-sigv4 "aws:amz:us-east-1:s3" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  "https://<endpoint-host>/<bucket>/?list-type=2&delimiter=/&max-keys=100" \
  | grep -oE '<Prefix>[^<]+</Prefix>' | sort -u
```

看到 `memories/` 直接位于桶根，就说明该用**空** prefix；若看到 `agent/memory/` 之类，就把 prefix 配成它。

几处容易混淆的地方：

- schema 默认值是 `dsh-memory-s3`，**不是空串**。第一台设备若没显式配 prefix，数据会落在 `{bucket}/dsh-memory-s3/memories/...`
- 本文档早期示例曾用 `agent/memory`，照抄会与默认值不一致
- 首尾斜杠不参与规范化，`agent/memory` 与 `agent/memory/` 请勿混用
- 换 prefix 不会迁移已有数据。老数据仍在原路径，需自行用 S3 工具搬迁（或就地改回原 prefix）

> 相关：配置变更契约为 `applies: 'restart'` —— 改完 `prefix` 必须重启 profile 才生效。改完立刻查询仍是 0 条属正常。

### 使用

```
# 模型工具
memory_s3_save     保存一条记忆（过审批门；可携附件 attachments:[{path, note?}]）
memory_s3_search   关键词检索
memory_s3_recall   语义召回
memory_s3_list     列表/过滤
memory_s3_backlinks 查询反链（谁引用了该条目；无审批，读本地索引）
memory_s3_update   更新（过审批门；支持 subject/timeline/links/locked）
memory_s3_delete   删除（过审批门）
memory_s3_forget   抑制自动注入而不删除
memory_s3_attach   给已有条目挂附件（过审批门）
memory_s3_get_file 下载附件到本地（无审批，sha256 校验）
memory_s3_detach   移除附件（过审批门，删 S3 对象 + 条目元数据）
memory_s3_sync     手动同步 S3 增量
memory_s3_status   状态视图

# 命令行（规划中，未实现）
# /memory-s3 status|sync
```

## 📁 项目结构

```
dsh-memory-s3/
├── index.mjs          # 插件入口（唯一 DSH 依赖面）
├── types.d.ts         # ctx.memoryS3 类型契约
├── lib/
│   ├── s3store.mjs    # S3 对象布局 + CRUD + 乐观并发
│   ├── cache.mjs      # 本地缓存（索引 + 条目 LRU）
│   ├── embedder.mjs   # 可插拔嵌入器（OpenAI 兼容 / Ollama）
│   ├── vector.mjs     # 余弦 top-k + 过滤（纯 JS）
│   ├── entry.mjs      # 条目模型校验/序列化（含附件元数据 + subject/timeline/links/locked）
│   ├── backlinks.mjs  # 反链索引（links 入边镜像，本地 backlinks.json 持久化）
│   ├── filemeta.mjs   # 附件探测：魔法字节 / 扩展名白名单 / 大小上限 / sha256
│   ├── gate.mjs       # 审批门策略封装
│   ├── audit.mjs      # 审计账本（JSONL）
│   └── strings.mjs    # 词表（en/zh）
├── docs/              # requirements / TECH_STACK / ARCHITECTURE / SECURITY / MODEL / OMDSH_REVIEW / PROBLEM_REPORT.tests-v2.1
├── test/              # node --test
├── scripts/           # 冒烟脚本（smoke-rustfs.mjs / smoke-attachments.mjs）
├── cordis.patch.yml   # bundle 声明
└── package.json
```

## 🔒 安全边界

- **凭据永不落记忆**：访问密钥仅来自环境变量/DSH 配置，绝不进入条目/快照/审计；内置秘密检测器拒绝含凭据形状的写入
- **附件三重防护**：未知扩展名/魔法字节/超限文件一律拒绝（白名单制）；文本类附件内容过秘密检测；附件二进制不进审批 reason 与审计（只进元数据摘要）；下载时 sha256 校验防篡改
- **网络面**：仅出站 HTTPS 到配置的 S3 endpoint 与嵌入端点；无其他出站
- **静态加密**：依赖 S3 服务端加密（SSE-S3 默认）；本地缓存权限 0600
- **最小权限**：IAM/桶策略仅允许单 prefix 读写（见 docs/SECURITY.md 示例）
- **共享即共享数据**：同一 bucket+prefix 的所有 DSH 实例共享记忆；先建立信任边界。反之，prefix 不一致的实例**互相看不见**（表现为同步成功但 0 条，见「prefix 必须跨设备一致」）
- **卸载不删云上数据**：移除插件注册不影响 S3 中的记忆对象

## 🛠️ 开发

```bash
npm test              # node --test 跑 test/*.test.mjs
npm run coverage      # 覆盖率报告
```

提交使用 Conventional Commits（feat/fix/docs/refactor/test/chore）。

## 📄 License

[MIT](LICENSE)

---

*El Psy Kongroo.*
