// test/recall.integration.test.mjs — 语义召回端到端集成测试（真实 Ollama 嵌入）。
//
// 目标：验证「接入 Ollama 嵌入器后，recall 的向量路径真实生效」——
// 走完整插件栈（apply → memory_s3_save 写路径 #tryEmbed 落真实向量 →
// memory_s3_recall 读路径 embed(query) + bruteForceTopK + RRF 合并）。
//
// 设计要点：
//  - S3 用 mock fetch（不真连网），嵌入用真实本机 Ollama（当前接口 embedder.provider=ollama）。
//  - 对照组：同一批条目 + provider:none 的 store，query 因「无关键词重合」召回为 0，
//    反证向量路径（而非关键词）是命中语义相关条目的原因。
//  - Ollama 不可达时整文件优雅 skip（CI 无本机 Ollama 也能过）。
//
// 运行：node --test test/recall.integration.test.mjs  或随 npm test。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../index.mjs';

const OLLAMA_BASE = process.env.MEMORY_S3_TEST_OLLAMA_BASE ?? 'http://127.0.0.1:11434';
const MODEL = process.env.MEMORY_S3_TEST_EMBED_MODEL ?? 'nomic-embed-text';

let available = false;

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
    console.log(`[recall.integration] Ollama 不可达（${OLLAMA_BASE}），本文件用例全部跳过。`);
  }
});

/**
 * 与 index.test.mjs 同构的 mock fetch：仅拦截 S3 对象存储请求（PUT/DELETE/GET），
 * 其余 URL（如本机 Ollama /api/embed）放行走真实网络——本文件要用真实嵌入。
 */
function installFetchMock(records, handlers = {}) {
  const original = globalThis.fetch;
  const ollamaHost = new URL(OLLAMA_BASE).host;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    // 放行真实 Ollama 嵌入请求（当前接口接入点），不 mock。
    let host = '';
    try {
      host = new URL(u).host;
    } catch {
      /* 非法 URL 走 mock 兜底 */
    }
    if (host === ollamaHost) return original(url, init);
    const record = { url: u, init: { ...init, headers: { ...init?.headers } } };
    records.push(record);
    if (init?.method === 'PUT' || init?.method === 'DELETE') {
      if (handlers.putDelete) return handlers.putDelete(record, u);
      return new Response('', { status: 200, headers: { etag: '"e1"' } });
    }
    if (handlers.get) return handlers.get(record, u);
    return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

const EXEC = (sessionId = 's1', name = 'memory_s3_save') => ({
  signal: new AbortController().signal,
  agent: { session: { id: sessionId, header: {} } },
  name,
});

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-s3-recall-'));
}

function makeCtx() {
  const tools = [];
  const provided = new Map();
  const ctx = {
    approval: { request: async () => 'allowed-once' },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: { section: (def) => {} },
    provide: (name, svc) => provided.set(name, svc),
    on: (event, fn, opts) => {
      return () => {};
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
  };
  return { ctx, tools, provided };
}

function findTool(tools, name) {
  return tools.find((t) => t.name === name);
}

/**
 * 造 store：真实 Ollama 嵌入（或 provider:none 对照组）写入三句话义相近、用词不同的条目。
 * 返回 { saveTool, searchTool, listTool, recallTool, close }。
 */
function buildStore({ embedder }) {
  const records = [];
  const restore = installFetchMock(records);
  const dir = tempDir();
  const { ctx, tools } = makeCtx();
  apply(ctx, { bucket: 'mem', cacheDir: dir, writePolicy: 'auto', embedder });
  return {
    saveTool: findTool(tools, 'memory_s3_save'),
    searchTool: findTool(tools, 'memory_s3_search'),
    listTool: findTool(tools, 'memory_s3_list'),
    recallTool: findTool(tools, 'memory_s3_recall'),
    close() {
      restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 三条「时间旅行·回到过去」语义域的内存，用词刻意互不相同、且不含 query 关键词——
// 只有向量路径（非关键词）能召回它们。
const MEMORIES = [
  { type: 'history', title: '刻度回溯', content: '用电话微波炉改变旧日的刻度，救回重要的人' },
  { type: 'project', title: '世界线变动率', content: '观测世界线变动率，等待另一条分支的可能性' },
  { type: 'moment', title: '重逢', content: '在雨夜里穿过时间的裂缝，又一次站在她面前' },
];

// 与上述语义域高度相关，但与任一 content 都无关键词重合（验证向量而非子串）。
const QUERY_SEMANTIC = '怎样能回到过往的日子，挽回那个我失去的人';

test(
  '接入 Ollama：recall 向量路径能召回「语义相关、关键词零重合」的记忆',
  onlyIfAvailable(async () => {
    const store = buildStore({ embedder: { provider: 'ollama', endpoint: OLLAMA_BASE, model: MODEL } });
    try {
      for (const m of MEMORIES) {
        const saved = await store.saveTool.execute(m, EXEC());
        assert.equal(saved.ok, true, `save ${m.title} 应成功`);
        // 公开投影：save 工具输出不得泄漏内部 768 维 embedding（隐私/上下文纪律）。
        assert.equal(
          saved.entry.embedding,
          undefined,
          `save ${m.title} 输出应剔除 embedding（公开投影）`,
        );
      }

      const result = await store.recallTool.execute({ query: QUERY_SEMANTIC, topK: 10, limit: 10 }, EXEC('s1', 'memory_s3_recall'));
      assert.equal(result.ok, true);
      assert.ok(result.total >= 1, `语义相关 query 应至少召回 1 条，实得 ${result.total}`);
      const titles = result.entries.map((e) => e.title);
      // 关键词不含任何 MEMORIES 词汇，命中的只能来自向量路径。
      assert.ok(result.entries.length >= 1, '向量路径已生效');
      console.log(`[recall.integration] 语义召回命中：${titles.join(', ')}`);
    } finally {
      store.close();
    }
  }),
);

test(
  '对照组 provider:none：同 query 因无关键词重合召回为 0（反证向量路径是命中原因）',
  onlyIfAvailable(async () => {
    const store = buildStore({ embedder: { provider: 'none' } });
    try {
      for (const m of MEMORIES) {
        await store.saveTool.execute(m, EXEC());
      }
      const result = await store.recallTool.execute({ query: QUERY_SEMANTIC, topK: 10, limit: 10 }, EXEC('s1', 'memory_s3_recall'));
      assert.equal(result.ok, true);
      assert.equal(
        result.total,
        0,
        'provider:none 时无关键词重合 → 召回 0；接入向量后才 >0（见前一用例）',
      );
    } finally {
      store.close();
    }
  }),
);

test(
  '接入 Ollama：status.embedder 反映真实 provider=ollama（接入状态可观测）',
  onlyIfAvailable(async () => {
    const records = [];
    const restore = installFetchMock(records);
    const dir = tempDir();
    const { ctx, tools } = makeCtx();
    try {
      apply(ctx, { bucket: 'mem', cacheDir: dir, embedder: { provider: 'ollama', endpoint: OLLAMA_BASE, model: MODEL } });
      const statusTool = findTool(tools, 'memory_s3_status');
      const result = await statusTool.execute({}, EXEC('s1', 'memory_s3_status'));
      assert.equal(result.ok, true);
      assert.equal(result.status.embedder, 'ollama', '接入后 embedder 状态应为 ollama');
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);

test(
  '回归：接入后任一读工具输出都不得泄漏内部 embedding（公开投影生效）',
  onlyIfAvailable(async () => {
    const store = buildStore({ embedder: { provider: 'ollama', endpoint: OLLAMA_BASE, model: MODEL } });
    try {
      // 先写入一条带真实 embedding 的条目（save 公开投影已剔除该字段）。
      await store.saveTool.execute(MEMORIES[0], EXEC());

      // search：虽为关键词命中路径，输出同样不得含 embedding。
      const search = await store.searchTool.execute({ text: '刻度' }, EXEC('s2', 'memory_s3_search'));
      assert.equal(search.ok, true);
      for (const e of search.entries) assert.equal(e.embedding, undefined, 'search 输出不得含 embedding');

      // list：全量输出同样投影。
      const list = await store.listTool.execute({}, EXEC('s3', 'memory_s3_list'));
      assert.equal(list.ok, true);
      for (const e of list.entries) assert.equal(e.embedding, undefined, 'list 输出不得含 embedding');

      // recall：向量命中条目已含内部 embedding，但输出必须投影剔除。
      const recall = await store.recallTool.execute(
        { query: QUERY_SEMANTIC, topK: 10, limit: 10 },
        EXEC('s4', 'memory_s3_recall'),
      );
      assert.equal(recall.ok, true);
      assert.ok(recall.total >= 1, '向量路径仍应命中（embedding 已在校内存储）');
      for (const e of recall.entries) assert.equal(e.embedding, undefined, 'recall 输出不得含 embedding');
    } finally {
      store.close();
    }
  }),
);

/** Ollama 不可达时让用例降级为空操作（优雅 skip）。 */
function onlyIfAvailable(fn) {
  return async () => {
    if (!available) return;
    return fn();
  };
}
