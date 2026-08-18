# dsh-memory-s3 · v2.1 记忆模型测试问题报告

> 测试实验体报告｜2026-08-18｜范围：`npm test` 全绿 + 覆盖率达标（行 ≥90% / 分支 ≥80% / 函数 ≥90%）
> 本报告仅记录测试过程中发现/确认的实现层行为观察，不修改任何实现文件。

## 交付摘要

- **测试总数：212**（entry 40 / backlinks 10 新增 / index 57；其余 105）
- **覆盖率：行 97.65% / 分支 90.26% / 函数 94.44%**（全部达标）
- **改动文件（仅测试与测试内辅助）：**
  - `test/entry.test.mjs`（+147 行：v2.1 四字段 + moment 类型）
  - `test/index.test.mjs`（+355 行：四字段写入/更新、locked 跳过合并、反链工具、快照分层、反链持久化）
  - `test/backlinks.test.mjs`（新建，10 例：反链索引全 API + 持久化 + 容错 + 权限）

---

## 观察 1（低优先级）· update 空串清空 subject/timeline 在 S3 对象中残留空字符串键

- **位置**：`index.mjs` `#updateExisting`（`...(patch.subject !== undefined ? { subject: patch.subject } : {})`）＋ `lib/entry.mjs` `toJSON`（`if (entry.subject !== undefined)` 只判 undefined）
- **现象**：`update({subject: '', timeline: ''})` 后 `next.subject === ''`，`toJSON` 仍序列化 `"subject": ""` 落盘（`'' !== undefined`）；`fromJSON` 读回时因 trim 为空跳过 → undefined（容错掩盖残键）。
- **影响**：S3 条目对象留脏键，与 MODEL.md §5「缺省不落盘」契约不完全一致；功能影响极小（读回无感），但快照/审批载荷中会出现空串字段。
- **测试锁定方式**：按实现行为断言（`test/index.test.mjs`）：缓存态 `subject === ''`、磁盘 JSON 含空串、`fromJSON` 容错为 undefined、links 空数组则正确省略键。

> ✅ **已解决（2026-08-18）**：`index.mjs` `#updateExisting` 已改为空串 → `undefined`（`patch.subject.trim() === '' ? undefined : patch.subject`，见 index.mjs:719-720），空字符串键不再落 S3，与 MODEL.md §5「缺省不落盘」契约一致。

## 观察 2（低优先级）· backlinks.json 载入容错不过滤空字符串来源 id

- **位置**：`lib/backlinks.mjs` 构造时载入（`sources.filter((s) => typeof s === 'string')`）
- **现象**：盘面形如 `{"B": ["A", ""]}` 时载入 `Set(['A', ''])`，`getBacklinks('B')` 返回 `['', 'A']`，并随下次 persist 回写；非字符串项（如数字）会被过滤，唯独空串穿透。
- **影响**：部分损坏文件只做了半清洗；空串来源 id 在 `linkedTo` 查缓存必 miss，功能影响极小。
- **测试锁定方式**：仅锁定被过滤的非字符串项（`test/backlinks.test.mjs` 载入容错用例），未固化空串缺陷本身。

> ✅ **已解决（2026-08-18）**：`lib/backlinks.mjs` 载入路径已对来源 id 做 `trim` + `isValidLinkId` 过滤（见 lib/backlinks.mjs:55），空字符串来源 id 不再穿透、不再随下次 persist 回写。

## 观察 3（行为记录，非缺陷）· links 元素宽容 string 化

- **位置**：`normalizeEntry` 与 `backlinks.addForward`（`String(raw).trim()`）
- **现象**：数字等非字符串元素被转字符串（42 → '42'）而非拒绝；「元素必须 string」的严格语义只在 `validateEntry` / `fromJSON`（外部读回路径）生效。
- **判断**：与 tags 的 `String()` 宽容哲学一致，属有意的宽容规范化；「杂数据拒写」的严格门在写入路径未完全落地。测试中双向锁定：normalize 断言 `['1','a']` 的 string 化结果，validateEntry 断言 `links:[42]` → `INVALID_INPUT`。

---

## 结论

v2.1 能力（moment 类型、subject/timeline/links/locked 四字段、反链索引、locked 跳过合并、快照分层注入）全部有测试覆盖且按实现行为断言；未发现阻断性缺陷，三项观察均不影响正确性红线（写路径过审批、零落盘保证、容错读回）。

*El Psy Kongroo.*