# Changelog

本项目的所有显著变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
