# OMDSH REVIEW — dsh-memory-s3 审查记录

> 状态：骨架阶段（Initiation + 部分 Development）｜日期：2026-08-17
> 本文档如实记录 dsh-memory-s3 在各维度上的完成情况与未做项（诚实披露，不夸大）。

---

## 1. 包结构与安装

| 项 | 状态 | 说明 |
|---|---|---|
| package.json | ✅ | name/version/type/main/exports/files/dsh/dshWorkshop/peerDependencies 齐备 |
| cordis.patch.yml | ✅ | `- insert: [{id: memory-s3, name: dsh-memory-s3}]` |
| dshWorkshop.permissions | ⚠️ | `network:https` 与 `credentials:env` 为骨架声明，**出站网络枚举合法值待对照 OMDSH 规范核验** |
| compatibility.dshVersions | ✅ | `["0.1.0-rc.6"]`（对齐 dsh-memento） |
| 真实安装验证 | ⏳ 未做 | 需 `dsh plugin --profile web add "link:..."` + profile 重启；用户环境待办 |

## 2. 功能完成度

| 模块 | 状态 | 测试 |
|---|---|---|
| lib/entry.mjs（条目模型 + 秘密检测） | ✅ 完成 | 20 例 |
| lib/vector.mjs（余弦 top-k） | ✅ 完成 | 11 例（含 10k×768 性能冒烟 26-35ms） |
| lib/cache.mjs（LRU + 索引持久化） | ✅ 完成 | 11 例 |
| lib/audit.mjs（审计账本 JSONL） | ✅ 完成 | 10 例 |
| lib/gate.mjs（审批 reason 编解码） | ✅ 完成 | 9 例 |
| lib/strings.mjs（en/zh 词表） | ✅ 完成 | （经 index 使用验证） |
| lib/sigv4.mjs（SigV4 签名器） | ✅ 完成 | 15 例 |
| lib/s3store.mjs（S3 客户端，mock fetch） | ✅ 完成 | 8 例 |
| lib/embedder.mjs（嵌入器，mock fetch） | ✅ 完成 | 8 例 |
| index.mjs（插件入口：服务/工具/注入/审批） | ✅ 完成 | 13 例（mock ctx + mock fetch 集成） |
| 覆盖率（lib/ 全模块） | ✅ 行 96.07% / 分支 87.80% / 函数 95.50% | 远超门 80/75/80 |

## 3. 安全维度（OMDSH 审查面）

| 面 | 声明/状态 | 说明 |
|---|---|---|
| network | https（出站到 S3 + 嵌入端点） | 与 dsh-memento 的 network:none 哲学分岔，如实声明 |
| subprocess / shell / python | none | 无子进程面 |
| credentials | env | 仅环境变量读取，不落盘 |
| 秘密检测器 | 启发式（AKIA/JWT/PEM/口令） | 文档披露非确定性（docs/SECURITY.md §3） |
| 凭据纪律 | 凭据不进条目/快照/审计 | lib/entry.mjs 强制检测 |

## 4. 诚实披露的未做项（骨架阶段）

- [x] **真实 S3/MinIO 集成冒烟**：✅ **已于 2026-08-17 在真实 RustFS 端点完成**（`https://obj.seq.ink/`，bucket `dsh-mem`）——`scripts/smoke-rustfs.mjs` 9/9 全过：ListBuckets / PUT If-None-Match 创建 / 重复 PUT→CONFLICT / GET / HEAD / If-Match 更新 / 错误 If-Match→CONFLICT / ListObjectsV2 / DELETE / 删除后 404。**自实现 SigV4 签名在真实 S3 兼容端点验证通过**
- [x] **SigV4 官方向量离线验证**：✅ 由真实端点验签替代（离线向量源受限，真实端点验证更具说服力）
- [ ] **DSH 真实 profile 安装**：需 `dsh plugin add` + 重启
- [ ] 审批事件载荷结构核验（dsh-user-approval 未读）
- [ ] dshWorkshop 出站网络枚举核验
- [ ] Web 只读面板（client.js）——骨架阶段未做
- [ ] 会话摘要自动归档（P2 功能）
- [ ] 离线写入队列重放（骨架仅记录 pending）

## 5. 验证方法注记

- 纯逻辑层：`node --test` 61 例全绿（~360ms）+ 覆盖率报告
- S3 层：mock fetch 测试（不真实连网）
- 真实世界线验证：用户环境 MinIO（docker）或真实 S3 桶 + `dsh plugin add`

---

*El Psy Kongroo.*
