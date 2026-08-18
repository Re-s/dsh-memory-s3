# Contributing

欢迎参与 dsh-memory-s3（记忆S3）的开发。本仓库遵循 dev-preset 六阶段作战流程与质量规范。

## 开发环境

- Node.js ≥ 20（推荐 22+）
- DSH 插件调试：`dsh plugin --profile web add "link:/path/to/dsh-memory-s3"`
- 本地 S3 冒烟：Docker 跑 MinIO（`docker run -p 9000:9000 minio/minio server /data`）

## 命令

```sh
npm test              # node --test 跑 test/*.test.mjs
npm run coverage      # 覆盖率报告（目标：行 ≥80% / 分支 ≥75% / 函数 ≥80%）
```

## 提交规范（Conventional Commits）

- `feat:` 新功能
- `fix:` 修复
- `docs:` 文档
- `refactor:` 重构
- `test:` 测试
- `chore:` 杂项

一个逻辑变更一个 commit；提交前 `npm test` 全绿、`git diff --cached --check` 无空白错误。

## 架构红线（继承 dsh-memento 质量约定）

1. **`lib/` 零 DSH 依赖**：只依赖 node: 内置模块；任何 `@deepseek-ai/*` import 只允许出现在 `index.mjs`
2. **审批门不可绕过**：写路径强制点位于 Service 写方法内部（`ctx.approval.request`），不在工具层；`writePolicy` 是 Config，模型不可见不可改
3. **模型可见 ⟺ 落盘**：注入快照文本可自会话日志重建（request/header.system + 审计行 + 审批 reason）
4. **失败要大声**：结构化错误码（领域码见 ARCHITECTURE.md D8：`INVALID_INPUT`/`NOT_FOUND`/`SECRET_DETECTED`/`DENIED`/`CONFLICT`/`FILE_NOT_FOUND`/`FILE_TOO_LARGE`/`UPLOAD_REJECTED`/`CORRUPT_FILE`；基础设施码 `S3_UNAVAILABLE`/`EMBED_FAILED`/`S3_ERROR`），绝不静默吞错
5. **凭据纪律**：凭据绝不进入条目/快照/审计/日志；秘密检测器拒绝含凭据形状的写入
6. **rc.6 会话事件门**：自定义事件 append 前必须过 `KNOWN_SESSION_EVENT_TYPES.has()`；不要取消该门
7. **同步注入约束**：systemPrompt 提供者必须同步（rc.6 不 await）——快照只从本地缓存投影渲染，S3 异步回源
8. 测试用合成数据，永不掺真实用户记忆；复用他人代码标注出处（THIRD_PARTY_NOTICES.md）

## 行为变更

行为变更需同步更新：README.md（配置表/安全边界）、ARCHITECTURE.md（设计决策）、CHANGELOG.md、test/。
