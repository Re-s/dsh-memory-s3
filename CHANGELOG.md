# Changelog

本项目的所有显著变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

### 规划中（Initiation 完成）

- 需求分析定稿（docs/requirements.md）
- 技术选型终审（docs/TECH_STACK.md）：自实现 SigV4 / 每记忆一对象 / 零依赖向量
- 架构设计定稿（docs/ARCHITECTURE.md）
- 安全设计（docs/SECURITY.md）

## [0.1.0] - 未发布

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
