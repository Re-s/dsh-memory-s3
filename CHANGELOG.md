# Changelog

本项目的所有显著变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 规划中（Initiation 完成）

- 需求分析定稿（docs/requirements.md）
- 技术选型终审（docs/TECH_STACK.md）：自实现 SigV4 / 每记忆一对象 / 零依赖向量
- 架构设计定稿（docs/ARCHITECTURE.md）
- 安全设计（docs/SECURITY.md）

## [0.1.0] - 未发布

### Added

- 项目骨架与全套文档（README/CONTRIBUTING/CHANGELOG/LICENSE/.editorconfig/.gitignore/.prettierrc）
- 纯逻辑核心：`lib/entry.mjs`（条目模型 + 秘密检测）、`lib/vector.mjs`（余弦 top-k）、`lib/cache.mjs`（LRU 缓存）、`lib/audit.mjs`（审计账本）、`lib/gate.mjs`（审批 reason 编解码）、`lib/strings.mjs`（en/zh 词表）——57 测试全绿
- S3 存储层与插件入口（进行中）：`lib/sigv4.mjs` / `lib/s3store.mjs` / `lib/embedder.mjs` / `index.mjs`
