# dsh-memory-s3（记忆S3）

> 云端跨会话记忆插件 for DeepSeek Harness：结构化条目 + 向量检索，持久化于 S3 兼容对象存储（AWS S3 / MinIO / Cloudflare R2 / 阿里云 OSS）。

记忆不再困于单机——只要握着同一把桶钥匙，任何机器、任何部署、任何 DSH 实例都能共享与续写同一份记忆。**记忆S3** 欺骗的收束点是"记忆的位置"：从本地文件系统，迁移到对象存储的永恒之海。

## ✨ 特性

- **S3 兼容存储后端**：条目 CRUD + manifest 清单 + 乐观并发（If-Match）；自定义 endpoint 兼容 MinIO/R2/OSS
- **结构化记忆模型**：`preference | project | decision | history` 四类条目，带 importance/tags/source/时间戳
- **向量语义检索**：可插拔嵌入器 + 余弦 top-k + 元数据/关键词混合召回（中文友好）
- **本地缓存投影**：冻结快照只读本地缓存（rc.6 同步注入约束），S3 异步回源，离线降级只读
- **写入审批门**：所有写操作强制 DSH approval seam（ask/auto/off），模型不可见不可改
- **审计三链**：审批对 + 审计账本 + 快照，可从会话日志重建全部写入
- **照片/文件附件**：条目可挂照片/文件——二进制存 S3 `files/{id}` 不可变对象（uuid 键 + If-None-Match 创建 + sha256 完整性），条目 JSON 只存附件元数据数组；本地文件经扩展名白名单 + 魔法字节嗅探 + 大小上限（20MB）三重校验；`memory_s3_attach` / `memory_s3_get_file` / `memory_s3_detach` 三工具
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

配置环境变量（S3 凭据）：
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
export MEMORY_S3_BUCKET=my-memory-bucket
export MEMORY_S3_PREFIX=agent/memory   # 可选，默认 dsh-memory-s3
export MEMORY_S3_ENDPOINT=...          # 可选，MinIO/R2 等自定义端点
```

### 配置（$DSH_HOME/settings.yaml）

```yaml
plugins:
  memory-s3:
    bucket: my-memory-bucket
    prefix: agent/memory
    endpoint: ""          # 留空用 AWS；MinIO/R2 填 https://...
    region: us-east-1
    writePolicy: ask      # ask | auto | off
    embedder:
      provider: openai-compatible
      endpoint: https://api.openai.com/v1/embeddings
      apiKeyEnv: OPENAI_API_KEY
      model: text-embedding-3-small
      dimensions: 1536
    injection:
      enabled: true
      maxItems: 5
      importanceThreshold: 3
    cacheDir: ""          # 留空 = $DSH_HOME/dsh-memory-s3/cache
    auditRetentionDays: 0 # 0 = 永久保留
    maxFileBytes: 20971520      # 附件大小上限（字节；默认 20MB，>100MB 时加载告警）
    allowedFileTypes: [png, jpg, jpeg, gif, webp, pdf, zip, txt, md, json, csv]  # 附件扩展名白名单（小写，无点）
```

### 使用

```
# 模型工具
memory_s3_save     保存一条记忆（过审批门；可携附件 attachments:[{path, note?}]）
memory_s3_search   关键词检索
memory_s3_recall   语义召回
memory_s3_list     列表/过滤
memory_s3_update   更新（过审批门）
memory_s3_delete   删除（过审批门）
memory_s3_forget   抑制自动注入而不删除
memory_s3_attach   给已有条目挂附件（过审批门）
memory_s3_get_file 下载附件到本地（无审批，sha256 校验）
memory_s3_detach   移除附件（过审批门，删 S3 对象 + 条目元数据）
memory_s3_sync     手动同步 S3 增量
memory_s3_status   状态视图

# 命令行
/memory-s3 status|sync
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
│   ├── entry.mjs      # 条目模型校验/序列化（含附件元数据）
│   ├── filemeta.mjs   # 附件探测：魔法字节 / 扩展名白名单 / 大小上限 / sha256
│   ├── gate.mjs       # 审批门策略封装
│   ├── audit.mjs      # 审计账本（JSONL）
│   └── strings.mjs    # 词表（en/zh）
├── docs/              # requirements / TECH_STACK / ARCHITECTURE / SECURITY / OMDSH_REVIEW
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
- **共享即共享数据**：同一 bucket+prefix 的所有 DSH 实例共享记忆；先建立信任边界
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
