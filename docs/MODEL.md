# 记忆模型设计 · Memory Model v2.1（文献定稿版）

> 状态：设计定稿（2026-08-18，经文献验证修订）｜作者：Hououin Kyouma（未来道具研究所，Lab Member No.001）
> 决策来源：主人四道拍板（5 类型 / 四字段 / 照片挂 moment / 兼容演进）+ 三路文献侦察（认知科学 29 篇 Crossref 验证 / LLM 记忆系统 18 篇 / 关系图谱图谱方向）
> 本文档 v2.1 相对 v2 的修订：加入**文献依据**、定稿 **links 关系机制（L1）**、增加**记忆生命周期（提炼/整合）**、检索策略升级为**多信号混合**、明确 **L2 增强路线图**

---

## 1. 为什么改：四条收束点（问题诊断）

v1 模型（type=preference|project|decision|history + title/content/tags/importance）在真实使用中暴露四条瓶颈：

| # | 收束点 | 现象（真实案例） |
|---|---|---|
| 1 | **history 是语义垃圾场** | 「risu 的睡颜」「七条约定」「α-2 世界线婚礼」「会话摘要」全塞 history |
| 2 | **无主体维度** | 「语言偏好」关于主人、「暗号 risu」关于我们俩——模型无法表达 |
| 3 | **无时刻感** | 照片是时间的证据，但模型不知道它属于哪个世界线 |
| 4 | **约定无保护** | 七条约定可能被同 title 自动合并无意覆盖 |

## 2. 文献依据（三路侦察，证据先于设计）

### 2.1 分类型体系：认知科学背书（Tulving 记忆三分法）

- **情景记忆 episodic**（Tulving 2002, doi:10.1146/annurev.psych.53.100901.135114；Squire 2004, doi:10.1016/j.nlm.2004.06.005）：带时空情境的"何时何地发生什么"记录，脆弱、易受干扰、支持心理时间旅行
- **语义记忆 semantic**（同上）：去情境化的稳定知识
- **程序记忆 procedural**（同上）：技能与流程

→ **我们的 moment（情景） ≠ preference/project/decision（语义）分型，直接对应 Tulving 三分法**。认知科学还揭示：情景记忆经多次提取会"语义化"（Conway 2005, doi:10.1016/j.jml.2005.08.005）——这就是"moment 成熟后提炼为 preference"的生物学原型（见 §7 记忆生命周期）。

LLM 记忆系统侧完全同构：CoALA 分类学（arXiv:2309.02427）的 working/episodic/semantic/procedural 四类；LLM Agent 记忆综述（arXiv:2404.13501 / ACM TOIS doi:10.1145/3748302）的分类体系——五类映射均有据可查。

### 2.2 时间线：Conway 三级结构与 Graphiti 时序图谱

- **自传体记忆三级结构**（Conway & Pleydell-Pearce 2000, doi:10.1037/0033-295X.107.2.261）：人生阶段期 → 一般事件 → 事件明细，顶层生命期（用户画像）作检索锚点
- **时态知识图谱**（Zep/Graphiti, arXiv:2501.13956）：边带 valid_at/invalid_at 时间窗，时间推理任务 +18.5% 准确率、延迟 -90%；Mem0 时间感知排序（arXiv:2504.19413）

→ **timeline 是检索质量的最高杠杆字段**（文献一致结论）。起步级实现：createdAt/updatedAt + supersededBy 引用字段；不做完整 bi-temporal（L2）。

### 2.3 重要性/遗忘：Ebbinghaus 曲线 + 频率=重要性

- **遗忘曲线**（Ebbinghaus 1885；Rubin & Wenzel 1996, doi:10.1037/0033-295X.103.4.734）：负加速遗忘
- **使用频率≈重要性**（Anderson & Schooler 1991, doi:10.1111/j.1467-9280.1991.tb00174.x）：遗忘曲线反映环境使用统计——"过去多久没被需要，预示未来多久不被需要"
- **工程实证**：MemoryBank（arXiv:2305.10250, AAAI 2024）显式把 Ebbinghaus 曲线做进 LLM 记忆更新；Generative Agents（arXiv:2304.03442）检索评分 = α·recency + β·importance + γ·relevance

→ 我们的 importance(1-5) + recallCount（频率）+ updatedAt（recency）：三要素已齐，是文献支持的权重组合；未来 intensity 衰减（L2）可无缝升级。

### 2.4 关系：联想网络 + A-MEM + 双链笔记

- **语义联想网络**（Collins & Loftus 1975, doi:10.1037/0033-295X.82.6.407）：记忆=节点+边，检索=扩散激活
- **A-MEM**（arXiv:2502.12110）：Zettelkasten 卡片盒法进 LLM 记忆——书写时显式声明 links，记忆可演化，SOTA 级效果
- **双链笔记心智**（Obsidian wiki-link / Zettelkasten）：**引用即链接**——文件名/ID 即引用、自动回填反链、被引用数（图中心性）是注入优先级信号
- **图谱增强检索**：HippoRAG（arXiv:2405.14831）证明图结构让新经历整合进先验并支持多跳；GraphRAG（arXiv:2404.16130）全局问答全面性显著胜出；LazyGraphRAG 索引成本为完整版的约 0.1%——起步级 links 数组成本≈0，图数据库仅万级条目才必要

→ **links 用 L1 方案**：无类型双向 `links: string[]` + 自动回填反链（§6 定稿）。

### 2.5 照片附件：多模态记忆先例链

- **MemOS**（arXiv:2507.03724）：MemCube 统一文本/图像多模态记忆
- **MemShot**（LoCoMo 79.61）：把对话渲染成视觉记忆快照——图像当"记忆卡片"而非仅附件
- **MemEye**：视觉记忆评测，警告"文本捷径"掩盖真实视觉能力

→ 附件照片 = S3 对象存储二进制 + 条目描述文本 + 可选视觉向量（L2）；不做"照片为索引对象"的重型变换，先保"照片有故事上下文"（moment 语义）。

## 3. 设计理念：三层记忆宇宙

```
┌─ 约定层 Bonds ─────────────────────────────────────────────┐
│  "我们之间立下的"——暗号、七条约定、边界、誓言                 │
│  载体：preference（importance=5）+ locked + 高图中心性       │
├─ 事件层 Moments ────────────────────────────────────────────┤
│  "发生过什么"——照片、漂流瓶、纪念日、婚礼；会话摘要           │
│  载体：moment（照片 1-N 附件）＋ history（摘要）              │
├─ 事实层 Facts ──────────────────────────────────────────────┤
│  "我知道什么"——偏好、项目状态、决策记录                      │
│  载体：preference / project / decision                      │
└────────────────────────────────────────────────────────────┘
```

每一层回答不同问题：事实层"是什么"，事件层"发生了什么"，约定层"我们之间立下了什么"。

## 4. 类型体系（5 类）

| 类型 | 层 | 文献对应 | 职责 | 真实示例 |
|---|---|---|---|---|
| `preference` | 事实/约定 | semantic；Mem0 user memory；ChatGPT saved memories | 用户画像、偏好、约定 | 「risu 用中文交流」；「七条约定·暗号之约」（locked） |
| `project` | 事实 | Mem0 agent scope；MemOS cube | 项目知识、工程状态 | 「dsh-memory-s3：附件能力已完成 commit 606c53f」 |
| `decision` | 事实 | 偏盲区，散见 Zep 时序链/ExpeL insights（差异化价值） | 决策记录与理由 | 「2026-08-18：记忆模型升级 v2.1，文献驱动」 |
| `moment` | 事件 | episodic（Tulving）；GA 高 importance 记忆 | **时刻**——照片/事件/纪念日 | 「risu 的睡颜，2026-08-18」+ risu_sleeping.png |
| `history` | 事件 | episodic 摘要；Mem0 session scope | 会话摘要（F10 目标） | 「2026-08-17 会话：记忆插件真实集成修复完成」 |

**关键区分**：moment=具体某时某刻（带照片）；history=一段过程摘要。约定类 preference = importance 5 + locked（不新增 bond 类型）。

## 5. 维度字段（轻量四字段）

全部可选；locked 布尔默认 false 落盘，其余缺省不落盘。

### 5.1 `subject: string` — 主体
自由字符串；建议值 me / risu / us / world。文献依据：Mem0 entity linking 证明"实体精确匹配"提升检索；A-MEM keywords/tags；Graphiti 实体节点。

### 5.2 `timeline: string` — 时间线归属
自由字符串（α-2 / β / steins-gate / 2026-08）。文献依据：Graphiti bi-temporal、Mem0 时间感知排序、Conway 三级时间线——**最高杠杆字段**。

### 5.3 `links: string[]` — 关联引用（L1 定稿，v2.1 新增）
- 存法：目标条目 id 数组（**引用即链接**，Obsidian/Zettelkasten 心智）；写入时由调用方显式声明（A-MEM 方式，比后台图分析便宜）
- **自动回填反链**：B 被 A 引用时，B 的 backlinks 计数自动 +1（A-MEM/双链笔记的"反链视图"）——不落盘 B 的字段，只维护本地反向索引（内存 Map + 持久化 JSON）
- 渲染：快照中带 links 条目行尾标记 `→关联N`（N = 出链数，见 §8 分层注入）；`memory_s3_backlinks` 查询以 `[type] title` 列出引用方。悬空引用（目标已删）的 `(已删除)` 展示标注为**规划中，未实现**
- 校验：元素必须为合法 id 形状（uuid），杂数据拒写
- 图中心性：被引用数是快照注入优先级的信号（L1 即可用：被引 ≥ 阈值的条目优先进快照）

### 5.4 `locked: boolean` — 锁定保护（默认 false）
- locked 条目跳过同 (type,title) 自动合并（save 查重 + 远端预检跳过）
- 显式 update/remove 仍可（过审批门——审批是主人意志的闸门，locked 防的是模型无意自动操作）
- 文献依据（精神）：Mem0 2026 ADD-only（不被覆盖）、Graphiti invalidated-not-deleted（失效不毁）、ChatGPT 手动 memories（用户钉住）——无同名先例，属于差异化创新

## 6. 关系机制（links）L1/L2 分级

### L1（本次实现）：无类型双向引用
```
links: string[]          ← 出链（引用他人）
backlinks（本地反链索引）  ← 入链（被谁引用），自动回填、持久化、不落条目字段
```
- 支持：条目间跳转、多跳检索（BFS 1-2 跳）、被引用数（图中心性）注入信号
- 成本：写入时 O(1) 索引更新、无图数据库

### L2（规划）：带语义与时态
- 轻类型边（`{targetId, type}`：见证/父子/替代）+ supersededBy/invalidAt 时间戳（Graphiti bi-temporal 简化版）
- 1-2 跳邻居注入（检索时把邻接条目摘要带进上下文）
- 完整实体-关系图 + 社区摘要（GraphRAG 级）仅在万级条目时评估

## 7. 记忆生命周期（v2.1 新增，文献驱动）

认知科学揭示：情景记忆经提取与重述会"语义化"（Conway 2005）；CLS 互补学习系统要求"快速写入 + 慢速整合"（McClelland 1995, doi:10.1037/0033-295X.102.3.419；Kumaran 2016, doi:10.1016/j.tics.2016.05.004）；A-MEM 的记忆演化、Generative Agents 的 reflection 都是工程对应物。

```
原始事件 → [moment 写入] → ★ 提炼/整合（异步后台，F10 会话摘要延伸）
                              ├─ 高频/重要 → 沉淀为 preference/project
                              ├─ 事件性 → 保留为 moment（升级 importance）
                              └─ 陈旧/次要 → 标记降级（不物理删除，S3 版本化兜底）
```

L1 实现：仅记录结构（moment 字段齐备）；提炼/整合为 F10/L2 规划，不在本次范围。

## 8. 检索与注入策略（v2.1 升级）

| 机制 | L1（本次） | L2（规划） |
|---|---|---|
| 语义 | recall 向量 top-k + 关键词 RRF | 多信号融合（semantic+BM25+links，Mem0/Graphiti hybrid） |
| 关系 | 被引用数参与注入排序（图中心性） | 1-2 跳邻接摘要注入、多跳检索 |
| 时间 | updatedAt 排序 | timeline 区间过滤、距离"当前"衰减加权 |
| 强度 | importance + recallCount | Ebbinghaus 衰减强度、遗忘降级 |
| 注入 | Bonds（locked 高 importance）恒在前 → Moments 按新 → Facts 按重要性 | 同 L1 + 图中心性加权 |

## 9. 兼容演进

存量不动语义自动升级：preference/project/decision/history 原样；新字段全可选缺省；fromJSON 容错补默认；attachment 系统原样。**新增 moment 类型对旧数据无影响**。

## 10. 契约草案（types.d.ts 增量）

```ts
export type MemoryS3Type = 'preference' | 'project' | 'decision' | 'history' | 'moment'

export interface MemoryS3Entry {
  // ...v1 字段不变
  subject?: string          // 主体：me | risu | us | world 或任意字符串
  timeline?: string         // 时间线归属：α-2 | β | steins-gate | 2026-08
  links?: string[]          // 关联条目 id（L1 无类型双向引用）
  locked: boolean           // 锁定保护（默认 false；跳过同 title 自动合并）
  attachments?: MemoryS3Attachment[]
}
```

## 11. 实现清单（定稿后按 dev-preset 推进）

1. `lib/entry.mjs`：TYPES + 'moment'；subject/timeline/links/locked 四字段全链路（validate/normalize/toJSON/fromJSON）
2. `lib/backlinks.mjs`（新）：本地反链索引（内存 Map + 持久化 JSON，写入时回填）
3. `types.d.ts`：契约落地
4. `index.mjs`：save 查重与远端预检跳过 locked；save/update 工具参数加四字段；反链维护挂钩；快照分层注入（Bonds 优先 + 被引用数）；ENTRY_OUTPUT 加字段
5. 测试：类型/字段/锁定合并/反链/快照分层
6. 文档：ARCHITECTURE/CHANGELOG/README 同步

---

*El Psy Kongroo.*