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
| **Tampering**（篡改条目） | 攻击者改桶内条目 | 依赖 S3 访问控制 + 服务端加密；manifest checksum 可检测（骨架阶段记录，不校验） |
| **Repudiation**（否认写入） | 无法证明谁写了什么 | 审计三链：approval/asked+decided + 审计账本 + 快照（会话日志可重建） |
| **Info Disclosure**（泄露） | 凭据/敏感内容写入记忆 | 秘密检测器（AK/SK/JWT/私钥模式启发式）拒绝写入；SSE 加密；本地缓存 0600 |
| **DoS**（拒绝服务） | 桶被清空/配额耗尽 | IAM 限制单 prefix；生命周期规则仅 archive/；文档警示共享风险 |
| **Elevation**（提权） | 插件越权访问 | dshWorkshop.permissions 如实声明（network:https / credentials:env）；lib/ 零 DSH 依赖 |

## 2. 凭据管理

| 项 | 策略 |
|---|---|
| 访问密钥 | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`（环境变量，进程内读取，不落盘） |
| 会话令牌 | 支持临时凭据（STS）；不持久化 |
| 区域/端点 | `AWS_REGION`；自定义 endpoint（MinIO/R2/OSS）经 Config 或 `MEMORY_S3_ENDPOINT` |
| 配置文件 | 不读取 `~/.aws/credentials`（骨架阶段）；`dsh-credentials` 接入为后续版本 |
| **硬规则** | 凭据绝不进入：条目字段、快照文本、审计 reason、会话日志、错误消息 |

## 3. 秘密检测器（写入时启发式扫描）

对 `save/update/seed` 的 title/content/tags 全量扫描，命中即拒（`SECRET_DETECTED`）：

- AWS AK：`AKIA[0-9A-Z]{16}`（及 `ASIA` 临时键）
- 通用 Secret：`(secret|token|api[_-]?key|password)\s*[:=]\s*\S+`（上下文启发式）
- JWT：`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`
- PEM 私钥：`-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`
- 高熵串：长度 ≥ 32 的 base64/hex 高熵序列（骨架阶段可选，避免误伤）

> 说明：这是**启发式**扫描，不是确定性检测器。文档如实披露（继承 dsh-mnemon 的诚实披露哲学）。

## 4. 最小权限（IAM / 桶策略）

### AWS IAM 策略（最小）

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::my-memory-bucket",
        "arn:aws:s3:::my-memory-bucket/dsh-memory-s3/*"
      ],
      "Condition": {
        "StringEquals": { "s3:prefix": ["dsh-memory-s3/"] }
      }
    }
  ]
}
```

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
| 静态（S3） | SSE-S3 默认；Config `serverSideEncryption: 'AES256' \| 'aws:kms'` |
| 静态（本地缓存） | 文件权限 0600（POSIX；win32 跳过，文档明示）；缓存内容与 S3 对象同明文（依赖 S3 侧加密） |

## 6. 审计与重建（S2 不变量）

- **模型可见 ⟺ 落盘**：注入快照逐字进入 `request/header.system`（会话日志）+ 审计账本 `audit(snapshot)` 行
- 写：`approval/asked`（reason 全文载荷）→ `approval/decided` → 审计账本行
- 被拒写：`*-denied` 审计行（turn 外 gate 路径的证据链）
- 召回：`audit(recalled)` 行；`auditRetentionDays` 控制保留（默认 0 = 永久，文档警告）

## 7. 加载期与运行期校验

| 阶段 | 校验 |
|---|---|
| 加载期（schemastery schema） | bucket/prefix 非空；endpoint 若配置必须以 https:// 开头；writePolicy ∈ {ask,auto,off}；非法即响亮失败 |
| 加载期（凭据探测） | 凭据缺失 → WARN 日志 + `status()` 显示 `configured: false`（插件仍加载，读走缓存/空） |
| 运行期 | S3 错误分类：可重试（5xx/网络）指数退避 ×3；4xx 配置错误响亮报错 |

## 8. 已知边界（如实披露）

- 秘密检测器是启发式，非确定性（误报/漏报可能）
- 无客户端加密（依赖 SSE；如需端到端加密需演进）
- 多实例并发写采用乐观锁（If-Match），last-writer-wins，冲突不自动合并
- 卸载插件不删云上数据；共享 prefix = 共享数据（信任域文档明示）
- `credentials:env` 声明意味着凭据在进程环境可见（与零凭据插件不同，需用户知情）

---

*El Psy Kongroo.*
