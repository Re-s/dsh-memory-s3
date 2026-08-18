# dsh-memory-s3 安全设计（SECURITY）

> 状态：Initiation（v0.1 draft）｜日期：2026-08-17
> 本文档是 dsh-memory-s3 的安全模型、威胁分析与最小权限实践。与 ARCHITECTURE.md §6 对应。

---

## 1. 信任边界与威胁模型

### 信任边界
```
┌──────────────────────────────┐
│ DSH Harness 进程（含本插件）  │  ← 信任：DSH 沙箱/权限体系管束
│   ├ 本地缓存目录（0600）      │
│   └ 审计账本（JSONL）         │
└──────────────┬───────────────┘
               │ HTTPS（SigV4 签名）
┌──────────────▼───────────────┐
│ S3 兼容对象存储               │  ← 部分信任：云厂商保证静态加密/访问控制，
│ s3://bucket/prefix/           │     但桶内对象对持有凭据者可见
└──────────────────────────────┘
```

### 威胁清单（STRIDE 映射）

| 威胁 | 描述 | 缓解 |
|---|---|---|
| **Spoofing**（凭据盗用） | 攻击者获得 S3 凭据 | 凭据仅环境变量/DSH 配置；最小权限 IAM；文档警示 |
| **Tampering**（篡改条目） | 攻击者改桶内条目 | 依赖 S3 访问控制 + 服务端加密；附件下载经 sha256 指纹比对防篡改（CORRUPT_FILE）；条目本身依赖 S3 完整性（不建清单，无独立主校验） |
| **Repudiation**（否认写入） | 无法证明谁写了什么 | 审计三链：审批门（`approval.request` reason 带全文写载荷）+ 审计账本（save/update/... 与 `*-denied` 行）+ 快照（会话日志可重建） |
| **Info Disclosure**（泄露） | 凭据/敏感内容写入记忆 | 秘密检测器（AK/SK/JWT/私钥模式启发式）拒绝写入（含文本类附件正文）；SSE 加密；本地缓存 0600；附件二进制不进审批/审计/session 日志（只进元数据摘要） |
| **DoS**（拒绝服务） | 桶被清空/配额耗尽 | IAM 限制单 prefix；生命周期规则仅 archive/；文档警示共享风险 |
| **Elevation**（提权） | 插件越权访问 | dshWorkshop.permissions 如实声明（network:https / credentials:env）；lib/ 零 DSH 依赖 |
| **Upload**（恶意上传） | 附件走私/超限/伪装文件 | 白名单制：扩展名 + 魔数一致 + 大小上限（§6）；SVG 拒绝（XSS） |

## 2. 凭据管理

| 项 | 策略 |
|---|---|
| 访问密钥 | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`（环境变量，进程内读取，不落盘） |
| 会话令牌 | 支持临时凭据（STS）；不持久化 |
| 区域/端点 | 区域与端点均经 settings.yaml Config 配置（region 默认 `us-east-1`、endpoint 默认 AWS） |
| 配置文件 | 不读取 `~/.aws/credentials`（骨架阶段）；`dsh-credentials` 接入为后续版本 |
| **硬规则** | 凭据绝不进入：条目字段、快照文本、审计 reason、会话日志、错误消息 |

## 3. 秘密检测器（写入时启发式扫描）

对 `save/update` 的 title/content/tags 全量扫描（`seed` 写入面规划中、当前未暴露工具），命中即拒（`SECRET_DETECTED`）；**文本类附件（txt/md/json/csv）正文同样扫描**（探测阶段即执行，见 §6.2）：

- AWS AK：`AKIA[0-9A-Z]{16}`（及 `ASIA` 临时键）
- 通用 Secret：`(secret|token|api[_-]?key|password)\s*[:=]\s*\S+`（上下文启发式）
- JWT：`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`
- PEM 私钥：`-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`
- 高熵串：长度 ≥ 32 的 base64/hex 高熵序列（**当前未实现**；`SECRET_PATTERNS` 实为 4 项：aws-access-key / jwt / pem-private-key / secret-assignment）

> 说明：这是**启发式**扫描，不是确定性检测器。文档如实披露（继承 dsh-mnemon 的诚实披露哲学）。

## 4. 最小权限（IAM / 桶策略）

### AWS IAM 策略（最小，实证自 S3 调研）

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowListBucketUnderPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-memory-bucket",
      "Condition": {
        "StringLike": { "s3:prefix": ["dsh-memory-s3/memories/*", "dsh-memory-s3/files/*"] }
      }
    },
    {
      "Sid": "AllowObjOpsMemories",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::my-memory-bucket/dsh-memory-s3/memories/*"
    },
    {
      "Sid": "AllowObjOpsFiles",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::my-memory-bucket/dsh-memory-s3/files/*"
    }
  ]
}
```

要点：**对象操作绑死 `Resource: <bucket>/<prefix>/memories/*` 与 `<bucket>/<prefix>/files/*`（附件面 v0.1 起必需）**；ListBucket 用 `s3:prefix` 条件（StringLike，两个前缀都列）。R2 用账号级 API Token（限制到具体 bucket）；MinIO 支持同语法 IAM policy，此 JSON 可直接复用。

### MinIO 等价（mc alias + policy）

```bash
mc admin policy create local memory-s3-min policy.json
mc admin user add local memory-s3 <ACCESS_KEY> <SECRET_KEY>
mc admin policy attach local memory-s3-min --user memory-s3
```

### 桶级建议
- 桶不公开（Block Public Access 全部开启）
- 服务端加密默认（SSE-S3 `AES256`；敏感场景 SSE-KMS）
- 版本控制（可选，防误删恢复）；生命周期仅针对 `archive/` 冷归档
- R2/OSS 等价配置：R2 用 API Token（读/写该桶）；OSS 用 RAM 子账号 + 单 prefix 授权

## 5. 传输与静态

| 层 | 措施 |
|---|---|
| 传输 | 强制 HTTPS（endpoint 必须以 `https://` 开头；`http://` 仅允许显式配置且告警） |
| 静态（S3） | **各平台默认静态加密即达标**（AWS SSE-S3 自动 AES-256 / R2 自动 AES-256-GCM / OSS AES256），不引入 KMS；Config `serverSideEncryption` 可选透传 |
| 静态（本地缓存） | 文件权限 0600（POSIX；win32 跳过，文档明示）；缓存内容与 S3 对象同明文（依赖 S3 侧加密） |

## 6. 附件安全（照片/文件，v0.1 新增）

附件面 = 本地文件 → S3 `files/{attachmentId}` 不可变对象 + 条目 `attachments` 元数据数组。防护设计（实现：`lib/filemeta.mjs` 探测 + `index.mjs` 服务层门控）：

### 6.1 白名单制（拒绝优先，非黑名单）

- **扩展名白名单**：`png/jpg/jpeg/gif/webp/pdf/zip/txt/md/json/csv`（大小写不敏感归一化，无点）；未知扩展名 → `UPLOAD_REJECTED`。
- **魔法字节一致性**：非文本类必须以真实魔数证实（6 个嗅探器：PNG/JPEG/GIF/WebP/PDF/ZIP 头签名）；魔数无法识别、或「扩展名先验 ≠ 魔数实测」（如 .png 里塞 PDF）一律拒绝——**扩展名伪装/走私载体被堵死**。
- **文本类特判**（txt/md/json/csv 无魔数）：扩展名白名单 + 文件头字节无 NUL（二进制型内容伪装文本即拒，UTF-16 文本首字节常含 NUL 一并拒绝——披露）。

### 6.2 大小与内容

- **大小上限**：`maxFileBytes`（默认 20MB，`FILE_TOO_LARGE` 拒绝；`>100MB` 配置时加载告警——大附件超出可靠同步的实用边界）。
- **文本类内容秘密检测**：txt/md/json/csv 正文跑 `SECRET_PATTERNS` 扫描，命中 → `SECRET_DETECTED`（拒绝写入）；二进制类无法文本扫描，**不做内容检测**（披露）。
- **SVG 拒绝**：XML 形态可内嵌脚本载荷；静态存储虽不执行，下游渲染/浏览器打开时 XSS 暴露面不可控——**故意不在白名单**（披露）。

### 6.3 静态与传输

- **对象键与文件名解耦**：`files/{attachmentId}` 键不含用户文件名（文件名只存元数据 `name`）→ 防路径注入、防后缀伪装；下载本地名 `<id>.<ext>` 由 name 推导。
- **不可变对象**：uuid 键 + `If-None-Match: *` 创建（撞键 = CONFLICT）；防同键覆盖投毒。
- **完整性**：探测时 sha256 入元数据；`get_file` 下载重算比对（不符 → `CORRUPT_FILE`，损坏/被篡改数据拒绝落盘）；落盘权限 0600。
- 静态加密同 §5：依赖 S3 服务端加密（SSE-S3/SSE-KMS）；本地下载文件与 S3 对象同明文。

### 6.4 治理边界

- **二进制不进审批与审计**：审批 reason 与审计行只含附件**元数据摘要**（id/name/mime/kind/size/sha256 前 12 位），二进制内容从不进入 reason/审计/快照/会话日志（模型可见的只有元数据）。
- 附件写操作（attach/detach/save 携附件）同样强制审批门（approve-what-you-see 原则，D2）；上传失败尽力回滚（`attachment-rollback` 审计留痕）。
- 下载为读路径，无审批；`file-retrieved` 审计行记录。

## 7. 审计与重建（S2 不变量）

- **模型可见 ⟺ 落盘**：注入快照逐字进入 `request/header.system`（会话日志）+ 审计账本 `audit(snapshot)` 行
- 写成功：落一条审计活动行（`save`/`update`/`remove`/`forget`/`attach`/`detach`，reason 全文载荷经审批门 `approval.request` 携带）→ 审计账本行
- 被拒写：`${action}-denied` 审计行（outcome 记录 rejected/cancelled/unavailable，turn 外 gate 路径的证据链）
- 召回：`audit(recalled)` 行；`auditRetentionDays` 控制保留（默认 0 = 永久，文档警告）

## 8. 加载期与运行期校验

| 阶段 | 校验 |
|---|---|
| 加载期（schemastery schema） | bucket/prefix 非空；endpoint 若配置必须以 https:// 开头；writePolicy ∈ {ask,auto,off}；非法即响亮失败 |
| 加载期（apply 显式校验） | `maxFileBytes` 必须正数，`>100MB` 告警；`allowedFileTypes` 必须为非空字符串数组；`auditRetentionDays` 非负整数 |
| 加载期（凭据探测） | 凭据缺失 → WARN 日志 + `status()` 显示 `configured: false`（插件仍加载，读走缓存/空） |
| 运行期 | S3 错误分类：可重试（5xx/网络）指数退避 ×3；4xx 配置错误响亮报错；附件探测失败为领域错误（FILE_NOT_FOUND / FILE_TOO_LARGE / UPLOAD_REJECTED / SECRET_DETECTED / CORRUPT_FILE） |

## 9. 已知边界（如实披露）

- 秘密检测器是启发式，非确定性（误报/漏报可能）
- 附件二进制不做内容扫描（仅文本类）；SVG 因 XSS 暴露面整体拒绝
- 无客户端加密（依赖 SSE；如需端到端加密需演进）
- 附件对象为不可变单写单删：无原地更新语义（更新 = detach + attach；`files/{id}` 被引用时 detach 会先删对象再清元数据，失败时条目不更新保持一致）
- 多实例并发写采用乐观锁（If-Match），last-writer-wins，冲突不自动合并
- 卸载插件不删云上数据；共享 prefix = 共享数据（信任域文档明示）
- `credentials:env` 声明意味着凭据在进程环境可见（与零凭据插件不同，需用户知情）

---

*El Psy Kongroo.*
