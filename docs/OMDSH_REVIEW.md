# OMDSH REVIEW — dsh-memory-s3 审查记录

> 状态：骨架阶段（Initiation + 部分 Development）｜日期：2026-08-17（附件能力增补 2026-08-18；记忆模型 v2.1 增补 2026-08-18）
> 本文档如实记录 dsh-memory-s3 在各维度上的完成情况与未做项（诚实披露，不夸大）。

---

## 1. 包结构与安装

| 项 | 状态 | 说明 |
|---|---|---|
| package.json | ✅ | name/version/type/main/exports/files/dsh/dshWorkshop/peerDependencies 齐备 |
| cordis.patch.yml | ✅ | `- insert: [{id: memory-s3, name: dsh-memory-s3}]` |
| dshWorkshop.permissions | ⚠️ | `network:https` 与 `credentials:env` 为骨架声明，**出站网络枚举合法值待对照 OMDSH 规范核验** |
| compatibility.dshVersions | ✅ | `["0.1.0-rc.6"]`（对齐 dsh-memento） |
| 真实安装验证 | ✅ 预检通过（2026-08-18） | profile 为 **link 方式**（`node_modules/dsh-memory-s3 → ../../../../Documents/DSHWK/dsh-memory-s3`）——磁盘已是最新 v2.1 代码；加载预检通过（13 工具/服务方法/反链挂接/快照段）；真实 cordis 配置（dsh-mem/obj.seq.ink/prefix 空/auto/none）经 Config schema 编译通过。**完整激活待 DSH 重启**（重启会断开当前会话，由用户择时） |

## 2. 功能完成度

| 模块 | 状态 | 测试 |
|---|---|---|
| lib/entry.mjs（条目模型 + 秘密检测 + 附件元数据 + v2.1 四字段 subject/timeline/links/locked） | ✅ 完成 | 30+ 例（含附件元数据校验/规范化）；**v2.1 四字段断言已由子代理补入**（TYPES 5 类型 / toJSON 字段计数等） |
| lib/backlinks.mjs（反链索引：内存 Map + backlinks.json 0600 持久化 + 替换语义 + 悬空容错） | ✅ 实现完成 | **专测 test/backlinks.test.mjs 已建 7 例**（addForward 替换语义 / 自引用忽略 / allCounts / 0600 / 损坏容错；removeForward 1 例断言迭代中） |
| lib/filemeta.mjs（附件探测：白名单/魔数/大小/sha256） | ✅ 完成 | 专测 `test/filemeta.test.mjs`（306 行：各类型真实魔数文件、白名单拒绝、大小限制、目录/空路径、扩展名↔魔数一致性、文本 NUL 拒绝、sniffMime/extensionOf/formatBytes） |
| lib/vector.mjs（余弦 top-k） | ✅ 完成 | 11 例（含 10k×768 性能冒烟 26-35ms） |
| lib/cache.mjs（LRU + 索引持久化） | ✅ 完成 | 11 例 |
| lib/audit.mjs（审计账本 JSONL） | ✅ 完成 | 10 例 |
| lib/gate.mjs（审批 reason 编解码） | ✅ 完成 | 9 例 |
| lib/strings.mjs（en/zh 词表） | ✅ 完成 | （经 index 使用验证） |
| lib/sigv4.mjs（SigV4 签名器） | ✅ 完成 | 15 例 |
| lib/s3store.mjs（S3 客户端，mock fetch；files/ 附件对象 + If-None-Match + binary GET） | ✅ 完成 | 8+ 例（含 fileKeyOf 布局与附件对象校验） |
| lib/embedder.mjs（嵌入器，mock fetch） | ✅ 完成 | 8 例 |
| index.mjs（插件入口：服务/工具/注入/审批；13 工具含附件三工具 + memory_s3_backlinks + 分层快照注入 + locked 合并保护） | ✅ 实现完成 | 50 例（mock ctx + mock fetch 集成）；**工具计数 12→13 / 分层注入 / locked / 反链挂钩断言由子代理收尾中** |
| 覆盖率（lib/ 全模块） | ✅ 行 96.07% / 分支 87.80% / 函数 95.50% | 远超门 80/75/80 |

> 🧪 **测试套件（2026-08-18 实时态势，测试子代理并行补齐中）**：`node --test` **203 例中 200 通过 / 3 失败**。已补齐：entry.test.mjs（moment 类型 / 四字段 toJSON 断言，含 locked 计数）+ 新增 `test/backlinks.test.mjs`（addForward 替换语义 / 自引用忽略 / allCounts / 0600 / 损坏容错 7 例）。仍挂 3 例：`removeForward：清空该条目的出链`（test/backlinks.test.mjs:85，断言期望与实现语义「删除条目即清其出链」不一致，子代理迭代中）、`apply 注册九工具`（test/index.test.mjs:152，工具计数 12→13 未同步）、`全部工具 render 回调可执行`（test/index.test.mjs:1033，同上）。**v2.1 新增行为断言覆盖中，子代理收尾后按本表复核。**

> **记忆模型 v2.1 状态（2026-08-18）**：实现完成（design 定稿 docs/MODEL.md）——五类型 + subject/timeline/links/locked 四字段全链路（lib/entry.mjs）、反链索引（lib/backlinks.mjs + index.mjs 挂钩）、`memory_s3_backlinks` 工具（13 工具）、locked 合并保护、分层快照注入（Bonds 40% → Moments → Facts + `→关联N` 标记）。**测试同步由并行子代理进行中，复核待其收尾。**

## 3. 安全维度（OMDSH 审查面）

| 面 | 声明/状态 | 说明 |
|---|---|---|
| network | https（出站到 S3 + 嵌入端点） | 与 dsh-memento 的 network:none 哲学分岔，如实声明 |
| subprocess / shell / python | none | 无子进程面 |
| credentials | env | 仅环境变量读取，不落盘 |
| 秘密检测器 | 启发式（AKIA/JWT/PEM/口令） | 文档披露非确定性（docs/SECURITY.md §3） |
| 附件面 | 白名单制 + 魔数嗅探 + 大小上限；二进制不进审批/审计 | 文本类附件内容同样过秘密检测；SVG 拒绝（XSS 披露，docs/SECURITY.md §6） |
| 凭据纪律 | 凭据不进条目/快照/审计 | lib/entry.mjs 强制检测 |

## 4. 诚实披露的未做项（骨架阶段）

- [x] **真实 S3/MinIO 集成冒烟**：✅ **已于 2026-08-17 在真实 RustFS 端点完成**（`https://obj.seq.ink/`，bucket `dsh-mem`）——`scripts/smoke-rustfs.mjs` 9/9 全过：ListBuckets / PUT If-None-Match 创建 / 重复 PUT→CONFLICT / GET / HEAD / If-Match 更新 / 错误 If-Match→CONFLICT / ListObjectsV2 / DELETE / 删除后 404。**自实现 SigV4 签名在真实 S3 兼容端点验证通过**
- [ ] **记忆模型 v2.1 测试收尾（并行子代理进行中）**：moment 类型 / 四字段全链路 / locked 合并保护 / 反链索引（test/backlinks.test.mjs 已建 7 例，removeForward 断言迭代中）/ 分层快照注入 / index 工具计数 12→13——收尾后全量复核本表
- [ ] **代码注释滞后**：`index.mjs` 内 `memory_s3_save` 工具 description 文本仍写「type ∈ preference|project|decision|history」（参数 enum 已含 moment）——代码侧注释滞后，待测试子代理顺手修正（文档升级不修改 .mjs/.d.ts，如实披露）
- [ ] **附件真实端点冒烟**：`scripts/smoke-attachments.mjs` 已就绪（7 步链路：probeFile → If-None-Match 创建 → CONFLICT → binary 往返 → sha256 → 条目元数据回读 → 清理），**待用户环境凭据（RUSTFS_AK/SK/BUCKET）执行**（单元/集成层已由 test/*.test.mjs 覆盖，缺的是真实端点验证）
- [x] **SigV4 官方向量离线验证**：✅ 由真实端点验签替代（离线向量源受限，真实端点验证更具说服力）
- [x] **DSH 真实 profile 安装**：link 方式已确认 + 加载预检通过（2026-08-18）；激活待重启
- [ ] 审批事件载荷结构核验（dsh-user-approval 未读）
- [ ] dshWorkshop 出站网络枚举核验
- [ ] Web 只读面板（client.js）——骨架阶段未做
- [ ] 会话摘要自动归档（P2 功能）
- [ ] 离线写入队列重放（骨架仅记录 pending）

## 5. 验证方法注记

- 纯逻辑层：`node --test` **203 例（实时态势：200 过 / 3 挂——子代理并行补齐中，见 §2 注记）** + 覆盖率报告
- S3 层：mock fetch 测试（不真实连网）；附件对象层走同一协议（fileKeyOf + If-None-Match + binary GET）
- 真实世界线验证：用户环境 MinIO（docker）或真实 S3 桶 + `dsh plugin add`；附件链路另见 `scripts/smoke-attachments.mjs`

---

*El Psy Kongroo.*
