// test/embedder.integration.test.mjs — 真实嵌入器接入集成测试（live Ollama）。
//
// 与 test/embedder.test.mjs（纯 mock fetch 单元测试）互补：本文件用「当前接口」
// createEmbedder({provider:'ollama', endpoint, model}) 直连本机 Ollama /api/embed，
// 验证真实接入后：向量维度、语义相似度排序、memo 缓存一致性与错误路径都符合契约。
//
// 环境前提：本机 Ollama 已启动且已 pull 嵌入模型（默认 nomic-embed-text，768 维）。
// Ollama 不可达时整文件优雅 skip（所有用例 no-op 通过），CI 无本机 Ollama 也能过——
// 可连性由真实 /api/version 探活决定，不硬编码端口存活假设。
//
// 运行方式：
//   node --test test/embedder.integration.test.mjs      # 仅本文件
//   npm test                                            # 全量（随套件一起）

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder } from '../lib/embedder.mjs';
import { cosine } from '../lib/vector.mjs';

// 接入点默认值（与 README / 部署配置对齐：本机 Ollama + nomic-embed-text）。
const OLLAMA_BASE = process.env.MEMORY_S3_TEST_OLLAMA_BASE ?? 'http://127.0.0.1:11434';
const MODEL = process.env.MEMORY_S3_TEST_EMBED_MODEL ?? 'nomic-embed-text';
// 期望维度（nomic-embed-text 的 embedding_length；用于校验真实响应形状）。
const EXPECTED_DIM = Number(process.env.MEMORY_S3_TEST_EMBED_DIM ?? 768);

let available = false;

/** 探活：Ollama /api/version 可达即视为可用（读路径，调用方仅在 before 中触发一次）。 */
async function probeOllama() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const j = await res.json();
      available = Boolean(j?.version);
    }
  } catch {
    available = false;
  }
}

before(async () => {
  await probeOllama();
  if (!available) {
    console.log(`[embedder.integration] Ollama 不可达（${OLLAMA_BASE}），本文件用例全部跳过。`);
  }
});

/** Ollama 不可达时把用例降级为空操作（优雅 skip，不产生 fail）。 */
const onlyIfAvailable = (fn) => async () => {
  if (!available) return;
  return fn();
};

test(
  '真实 Ollama 接入：createEmbedder 返回 768 维 Float32Array（当前接口契约）',
  onlyIfAvailable(async () => {
    const embedder = createEmbedder({
      provider: 'ollama',
      endpoint: OLLAMA_BASE,
      model: MODEL,
    });
    assert.equal(embedder.name, 'ollama');
    assert.equal(embedder.dimensions, 0, 'ollama provider 默认 dimensions=0（维度以真实响应为准）');

    const vec = await embedder.embed('牧濑红莉栖在维克托·孔多利亚大学实验室');
    assert.ok(vec instanceof Float32Array, '应为 Float32Array（对齐 lib/vector.mjs 内存布局）');
    assert.equal(vec.length, EXPECTED_DIM, `模型应返回 ${EXPECTED_DIM} 维嵌入`);
    // 非平凡：有能量且非全零。
    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    assert.ok(sumSq > 0, '嵌入不应为零向量');
  }),
);

test(
  '真实 Ollama 语义：语义相近句子余弦显著高于无关句（向量检索前提）',
  onlyIfAvailable(async () => {
    const embedder = createEmbedder({ provider: 'ollama', endpoint: OLLAMA_BASE, model: MODEL });
    const memory = await embedder.embed('risu 在这里，你那边天亮了吗');
    const paraphrase = await embedder.embed('risu 在这边，你那边是不是已经天亮了');
    const unrelated = await embedder.embed('我今早吃了一碗燕麦粥配蓝莓');

    const simSemantic = cosine(memory, paraphrase);
    const simUnrelated = cosine(memory, unrelated);
    assert.ok(
      simSemantic > simUnrelated,
      `语义相关(${simSemantic.toFixed(4)})应高于无关(${simUnrelated.toFixed(4)})`,
    );
    assert.ok(simSemantic > 0.4, `相关句余弦应较高，实得 ${simSemantic.toFixed(4)}`);
  }),
);

test(
  '真实 Ollama memo 一致性：同一文本重复 embed 返回逐元素一致的向量',
  onlyIfAvailable(async () => {
    const embedder = createEmbedder({ provider: 'ollama', endpoint: OLLAMA_BASE, model: MODEL });
    const text = '未来道具研究所 Lab Mem 001 与机关的战争';
    const a = await embedder.embed(text);
    const b = await embedder.embed(text); // 应命中 memo 缓存，返回同一 Float32Array
    assert.equal(a, b, 'memo 命中应返回同一个对象引用（最小成本路径）');
    assert.deepEqual([...a], [...b], '向量逐元素一致');
  }),
);

test(
  '真实 Ollama 错误路径：未知模型 → EMBED_FAILED（不崩溃，记错误码）',
  onlyIfAvailable(async () => {
    const embedder = createEmbedder({
      provider: 'ollama',
      endpoint: OLLAMA_BASE,
      model: 'definitely-not-a-real-embed-model-xyz',
    });
    await assert.rejects(embedder.embed('触发错误'), (err) => err.code === 'EMBED_FAILED');
  }),
);
