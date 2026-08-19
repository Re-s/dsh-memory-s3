# Changelog

本项目的所有显著变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-08-19

### Fixed

- **根治 `ctx.settings` register 的 this 绑定 bug**（fix，2026-08-19；对齐 @deepseek-ai/dsh-settings@0.1.0-rc.7 真实契约）：
  - 接入设置缝时用 `const register = settings?.register` 解构方法再调用——dsh-settings 的 `SettingsProvider.register` 内部访问 `this.registrations`，解构后 `this` 丢失（ESM 严格模式为 `undefined`），抛 `Cannot read properties of undefined (reading 'registrations')`，导致设置缝总是静默降级为 entry config
  - 改为方法调用 `settings.register(...)`（保持 `this=settings`），设置缝真正生效；用户层（`settings.yaml` 顶层 `memory-s3:` / GUI 设置页）现在可覆盖 entry config
  - 提供一个返回 `scope.get()` 的 fake settings 回归测试：旧实现下该测试失败（降级为 entry 默认），修复后通过（用户层生效）——证明测试确实捕获此 bug
- **根治接入向量嵌入后工具输出校验崩溃**（fix，2026-08-19）：
  - `save/search/backlinks/recall/list/update/remove/forget/attach/detach` 返回的条目含内部 768 维 `embedding` 向量，与公开输出 schema `ENTRY_OUTPUT(additionalProperties:false)` 冲突，工具一返回就报 `"value.entries[i].embedding" is not a declared property`
  - 新增 `toPublicEntry()` 在工具边界剔除 `embedding`（对齐 ENTRY_OUTPUT「不含 embedding 向量」的既有声明，避免 768 维浮点灌入模型上下文）；内部向量召回路径（`#filterEntries`/recall 打分）不受影响——仅公开投影剥离
  - 修复以「回归：接入后任一读工具输出都不得泄漏内部 embedding」集成测试锁定

### Added

- **真实 Ollama 集成测试**（test，2026-08-19；验证接入后当前接口上下游都符契约）：
  - `test/embedder.integration.test.mjs`：`createEmbedder`（ollama provider）直连本机 `/api/embed`，断言 768 维 Float32Array、语义相关句余弦显著高于无关句、memo 一致性与未知模型→`EMBED_FAILED`；Ollama 不可达时整文件优雅 skip
  - `test/recall.integration.test.mjs`：完整插件栈 `apply→save(#tryEmbed 落真实向量)→recall(向量+RRF)` 召回「语义相关、关键词零重合」记忆；对照组 `provider:none` 同 query 召回 0 **反证向量路径是命中原因**；`status.embedder` 反映 ollama；输出投影回归
  - `npm test` 基线 213 → **222** 全绿
- **存量记忆 embedding 回填脚本**（scripts，2026-08-19）：
  - `scripts/backfill-embeddings.mjs`：为接入前保存的无向量存量条目标算真实 768 维 embedding 写回缓存（写前 `.bak-<ts>/` 备份，幂等可重跑）；进程环境含 AWS 凭据时同步 PUT 回 S3 使 `sync` 持久
  - 已在现场对 8 条存量记忆执行，重启后 `recall` 语义召回覆盖全部条目

## [0.2.0] - 2026-08-19

### Added

- **接入 DSH 官方 `ctx.settings` 设置缝**（feat，2026-08-19；对齐 @deepseek-ai/dsh-settings 契约）：
  - 配置改为三层解析：schema 默认值 → 该插件条目配置（`cordis.patch.yml` 的 entry config，composition base 层）→ 用户设置段（`settings.yaml` 顶层 `memory-s3:`，GUI 设置页可编辑）
  - 无 settings 服务的 profile 自动回退 entry config alone（官方契约：无 provider 时插件不受影响）
  - 命名空间 `memory-s3` 以 `applies:'restart'` 注册（S3/缓存构造较重，配置变更经重启生效）
  - 新增可选依赖声明 `@deepseek-ai/dsh-settings`（optionalDependencies）

### Fixed

- **根治读路径旧缓存输出校验崩溃**（fix，2026-08-19）：
  - `memory_s3_search` / `memory_s3_list` / `memory_s3_recall` / `memory_s3_backlinks` 读路径直接返回缓存原始条目；若缓存由更早版本插件写入（缺 v2.1 的 `locked` 字段），工具输出会因 `ENTRY_OUTPUT` 声明 `locked required` 而校验失败（`missing required property "value.entries[i].locked"`）
  - 新增 `#readCachedEntry(id)` 归一化读取：经 `fromJSON`（幂等补齐默认，`locked→false` 等）保证任何读路径产物满足输出 schema；单条损坏跳过不炸读路径（与 sync 的账本可重建性哲学一致）；`search`/`list`/`recall`/`backlinks` 四读路径统一接入 + 回归测试
- **根治 `cannot get property "settings" without inject` 启动崩溃**（fix，2026-08-19）：
  - `ctx.settings` 是 cordis 注入式服务，直接 `ctx.settings?.register` 会在未挂载 settings 的 profile（如 headless）抛错导致插件树启动失败
  - 改为经 cordis 反射层可选获取 `ctx.reflect.get('settings', false)`（服务未挂载返回 `undefined` 而非抛错），任何设置缝异常都降级为用 entry config——settings 未挂载时插件以 entry config 正常启用、绝不崩/绝不挂起；已挂载时注册命名空间、可在 GUI 设置页补配置

### Changed（docs，2026-08-19）

- **README/ARCHITECTURE/SECURITY/OMDSH_REVIEW 配置通道同步**：环境变量引导补全（S3 凭据 + 向量嵌入 `OPENAI_API_KEY`）；凭据只走环境变量、非敏感配置经官方 `ctx.settings` 缝三层解析、二者严格分离；废弃 `plugins.memory-s3` 子段写法

## [Unreleased]

### Added

- **记忆模型 v2.1 升级**（feat，2026-08-18；设计定稿 docs/MODEL.md）：
  - 类型新增 `moment`（共 5 类：preference/project/decision/history/moment，对应 Tulving 情景记忆——时刻/照片/纪念日）——存量四类型语义不动，moment 对旧数据零影响（兼容演进）
  - 条目新增可选四字段：`subject`（主体）/ `timeline`（时间线归属）/ `links`（关联引用）/ `locked`（锁定保护，默认 false 恒落盘，其余缺省不落盘）——validate/normalize/toJSON/fromJSON 全链路 + types.d.ts 契约落地（lib/entry.mjs）
  - 新模块 `lib/backlinks.mjs`：反链索引（内存 Map + `backlinks.json` 0600 持久化，替换语义，写入时自动回填）——被引用的反链**不落条目字段、不写 S3 对象**（引用即链接，Obsidian/Zettelkasten 心智）
  - 新工具 `memory_s3_backlinks`：查询「谁引用了该条目」（读路径无审批，读本地索引）——**工具总数 12 → 13**；对应服务方法 `service.linkedTo(id)`
  - **locked 合并保护**：locked 条目跳过同 (type,title) 自动合并（本地查重 + 远端预检 + CONFLICT 读回均跳过）；显式 update/remove 仍过审批门——审批是主人意志的闸门，locked 防的是模型无意自动覆盖
  - **快照分层注入**：冻结快照按 Bonds（locked / preference importance≥5，保底 40% 预算）→ Moments（moment 按新近）→ Facts（importance 降序、同分按被引用数/图中心性）三层投影；带 links 条目行尾自动标记 `→关联N`
  - `memory_s3_save` / `memory_s3_update` 工具参数新增 subject/timeline/links/locked（links 替换语义；更新时反链索引自动刷新）

### Changed（docs，2026-08-18）

- **OMDSH 安装验证记录**（commit 28dac24）：docs/OMDSH_REVIEW.md 补真实 link 安装预检通过结论
- **README 环境变量代码围栏修复**（commit 23ccc2d）：补上未闭合的代码围栏，修复块格式化

### 规划中（Initiation 完成）

- 需求分析定稿（docs/requirements.md）
- 技术选型终审（docs/TECH_STACK.md）：自实现 SigV4 / 每记忆一对象 / 零依赖向量
- 架构设计定稿（docs/ARCHITECTURE.md）
- 安全设计（docs/SECURITY.md）

## [0.1.1] - 2026-08-18

### Added

- **照片/文件附件能力**（feat）：`memory_s3_save` 新增 `attachments: [{path, note?}]` 参数；新增 `memory_s3_attach` / `memory_s3_get_file` / `memory_s3_detach` 三工具（工具总数 9 → 12）
- **附件对象布局 `files/{attachmentId}`**：二进制存 S3 不可变对象（uuid 键 + `If-None-Match: *` 创建 + sha256 元数据校验），条目 JSON 只存附件元数据数组 `attachments`（id/name/mime/kind/size/sha256/objectKey/note/createdAt）
- **本地文件三重校验**（新模块 `lib/filemeta.mjs`）：扩展名白名单 + 魔法字节嗅探（扩展名先验与魔数一致，不一致即拒）+ 大小上限；文本类（txt/md/json/csv）内容过秘密检测（SECRET_DETECTED）；SVG 不在白名单（XSS 披露）
- **新配置**：`maxFileBytes`（默认 20MB，>100MB 加载告警）/ `allowedFileTypes`（默认 png/jpg/jpeg/gif/webp/pdf/zip/txt/md/json/csv）
- **附件安全面**：附件二进制不进审批 reason 与审计（只进元数据摘要）；下载走 sha256 校验（不符 → CORRUPT_FILE 拒绝落盘）；`get_file` 文件权限 0600；审计新增 `attachment-rollback` / `file-retrieved` 行
- **快照注入增强**：带附件条目行尾追加 `📎文件名列表`（48 字符截断）
- **函数调用日志**：`DSH_MEMORY_S3_DEBUG` 门控 trace 级 JSON 结构化日志（dev-preset function_tracing，生产默认关闭）
- **真实端点冒烟脚本**：`scripts/smoke-attachments.mjs`（附件链路 7 步：探测 → If-None-Match 创建 → CONFLICT → binary 往返 → sha256 → 条目元数据回读 → 清理；凭据走 `RUSTFS_*` 环境变量，待用户环境执行）

### Changed

- 安装方式：支持从 GitHub 获取（`dsh plugin add https://github.com/Re-s/dsh-memory-s3.git`）；命令前缀兼容全局 `dsh` 与免安装 `npx @deepseek-ai/dsh`，本地 `link:` 方式保留为开发选项（README §安装）

### Fixed（真实 DSH 会话复验暴露，2026-08-18）

- **`memory_s3_forget` 反馈文案**：render 原用 `importance >= 0`（恒真）导致无论 `forgotten:true/false` 都显示 "injection suppressed"——改为读取调用参数，`forgotten:false` 正确回显 "restored"；render 断言（suppressed/restored/default 三态）补入测试
- **工具输出 schema 错误路径**（commit 4967b1c）：error-path 返回值补 `ok:false` 形状，满足 dsh-tools 输出校验

## [0.1.0] - 未发布

> 未独立发布：0.1.0 内容随 0.1.1 一并发布（0.1.1 为首次正式 release）。

### Added

- 项目骨架与全套文档（README/CONTRIBUTING/CHANGELOG/LICENSE/.editorconfig/.gitignore/.prettierrc）
- 纯逻辑核心：`lib/entry.mjs`（条目模型 + 秘密检测）、`lib/vector.mjs`（余弦 top-k）、`lib/cache.mjs`（LRU 缓存）、`lib/audit.mjs`（审计账本）、`lib/gate.mjs`（审批 reason 编解码）、`lib/strings.mjs`（en/zh 词表）
- S3 存储层：`lib/sigv4.mjs`（最小 SigV4 签名器，零依赖）、`lib/s3store.mjs`（条件写 + 指数退避 + ListObjectsV2）
- 嵌入器：`lib/embedder.mjs`（OpenAI 兼容 / Ollama / none 三 provider 可插拔）
- 插件入口：`index.mjs`（MemoryS3Service + 9 工具 + 同步快照注入 + 审批 answerer + session/event 桥）
- 类型契约：`types.d.ts`（ctx.memoryS3 声明合并）
- 测试：8 个文件 105 例全绿（覆盖率行 96.07% / 分支 87.80% / 函数 95.50%）
- **真实端点验签**：`scripts/smoke-rustfs.mjs`——2026-08-17 在 RustFS（https://obj.seq.ink/，bucket dsh-mem）9/9 全过，SigV4 签名与条件写在真实 S3 兼容端点验证通过

### Fixed（真实 DSH 会话验证暴露，2026-08-17）

- **cache 条目磁盘持久化**：`entries/<id>.json`（0600）+ 懒加载回源 + `deleteEntry`——修复新进程缓存热层为空导致快照注入失效（跨进程记忆复活）
- **save 远端预检去重**：缓存空时 listObjects 同 type 前缀 + 匹配 title → merged——修复清缓存后 save 创建同 title 重复条目
- **启动预热 sync**：插件加载即后台拉取（不阻塞）——新会话首启即可注入记忆
- **remove 同步清缓存磁盘**：删除条目不再在新进程回源复活（幽灵条目）
- **s3store.listObjects 404 容错**：RustFS 对不存在 prefix 返回 404（AWS 返回空列表）——行为差异兼容层
- **package.json 移除未实现的 `dsh.client` 声明**：真实启动被 client-modules 组合器拒绝
- 测试增至 **111 例全绿**