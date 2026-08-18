// test/embedder.test.mjs — 可插拔嵌入器测试（node:test）。
//
// 全部走 mock fetch：openai-compatible 请求体/响应解析、ollama 路径、
// provider 'none' 抛 EMBED_DISABLED、memo 缓存（同文本不重复请求）、非 2xx 归类。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder } from '../lib/embedder.mjs';

/** 安装 mock fetch：返回 handler(record)；记录每次调用。 */
function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init };
    calls.push(record);
    return handler(record);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('openai-compatible：请求体形状与响应解析为 Float32Array', async () => {
  const m = mockFetch(() =>
    new Response(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  try {
    const embedder = createEmbedder({
      provider: 'openai-compatible',
      endpoint: 'https://api.example.com/v1/embeddings',
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 768,
    });
    assert.equal(embedder.name, 'openai-compatible');
    assert.equal(embedder.dimensions, 768);
    const vec = await embedder.embed('你好，世界');
    assert.ok(vec instanceof Float32Array);
    // Float32 存储有浮点误差：逐元素近似比较而非 deepEqual。
    assert.equal(vec.length, 3);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(vec[i] - (i + 1) * 0.1) < 1e-6);
    const call = m.calls[0];
    assert.equal(call.url, 'https://api.example.com/v1/embeddings');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer sk-test');
    const body = JSON.parse(call.init.body);
    assert.deepEqual(body, {
      model: 'text-embedding-3-small',
      input: '你好，世界',
      dimensions: 768,
      encoding_format: 'float',
    });
  } finally {
    m.restore();
  }
});

test('openai-compatible：apiKey 为空时不带 Authorization 头', async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }));
  try {
    const embedder = createEmbedder({
      provider: 'openai-compatible',
      endpoint: 'https://api.example.com/v1/embeddings',
      model: 'm',
    });
    await embedder.embed('x');
    assert.equal(m.calls[0].init.headers.authorization, undefined);
  } finally {
    m.restore();
  }
});

test('ollama：POST base/api/embed，body {model, input, truncate}，解析 embeddings[0]', async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 }));
  try {
    const embedder = createEmbedder({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434/',
      model: 'nomic-embed-text',
    });
    assert.equal(embedder.name, 'ollama');
    const vec = await embedder.embed('memory test');
    assert.ok(vec instanceof Float32Array);
    assert.deepEqual([...vec], [1, 2, 3]);
    const call = m.calls[0];
    assert.equal(call.url, 'http://127.0.0.1:11434/api/embed');
    assert.deepEqual(JSON.parse(call.init.body), { model: 'nomic-embed-text', input: 'memory test', truncate: true });
    assert.equal(call.init.headers.authorization, undefined, 'ollama 不走 Bearer');
  } finally {
    m.restore();
  }
});

test("provider 'none'：embed() 抛 EMBED_DISABLED，name='none'", async () => {
  const embedder = createEmbedder({ provider: 'none' });
  assert.equal(embedder.name, 'none');
  await assert.rejects(embedder.embed('anything'), (err) => err.code === 'EMBED_DISABLED');
});

test('memo 缓存：同文本第二次不发起网络请求', async () => {
  let requests = 0;
  const m = mockFetch(() => {
    requests += 1;
    return new Response(JSON.stringify({ data: [{ embedding: [7, 8] }] }), { status: 200 });
  });
  try {
    const embedder = createEmbedder({
      provider: 'openai-compatible',
      endpoint: 'https://api.example.com/v1/embeddings',
      model: 'm',
    });
    await embedder.embed('same text');
    await embedder.embed('same text');
    await embedder.embed('other text');
    assert.equal(requests, 2, '两次相同文本只请求一次');
    assert.equal(m.calls.length, 2);
  } finally {
    m.restore();
  }
});

test('非 2xx 响应 → EMBED_FAILED', async () => {
  const m = mockFetch(() => new Response('{"error":"rate limited"}', { status: 429 }));
  try {
    const embedder = createEmbedder({
      provider: 'openai-compatible',
      endpoint: 'https://api.example.com/v1/embeddings',
      model: 'm',
    });
    await assert.rejects(embedder.embed('x'), (err) => err.code === 'EMBED_FAILED');
  } finally {
    m.restore();
  }
});

test('响应缺少 data[0].embedding → EMBED_FAILED', async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  try {
    const embedder = createEmbedder({
      provider: 'openai-compatible',
      endpoint: 'https://api.example.com/v1/embeddings',
      model: 'm',
    });
    await assert.rejects(embedder.embed('x'), (err) => err.code === 'EMBED_FAILED');
  } finally {
    m.restore();
  }
});

test('未知 provider → INVALID_CONFIG', () => {
  assert.throws(() => createEmbedder({ provider: 'watson' }), (err) => err.code === 'INVALID_CONFIG');
});

test('openai-compatible / ollama：endpoint 缺失 → INVALID_CONFIG', () => {
  assert.throws(() => createEmbedder({ provider: 'openai-compatible' }), (err) => err.code === 'INVALID_CONFIG');
  assert.throws(() => createEmbedder({ provider: 'ollama' }), (err) => err.code === 'INVALID_CONFIG');
});

test('网络失败 / 非 JSON 响应 → EMBED_FAILED（openai 与 ollama 两 provider）', async () => {
  // openai 网络失败
  const m1 = mockFetch(() => {
    throw new TypeError('fetch failed: connection refused');
  });
  try {
    const e = createEmbedder({ provider: 'openai-compatible', endpoint: 'https://x/v1/embeddings', model: 'm' });
    await assert.rejects(e.embed('x'), (err) => err.code === 'EMBED_FAILED');
  } finally {
    m1.restore();
  }
  // openai 响应非 JSON
  const m2 = mockFetch(() => new Response('<html>gateway error</html>', { status: 200 }));
  try {
    const e = createEmbedder({ provider: 'openai-compatible', endpoint: 'https://x/v1/embeddings', model: 'm' });
    await assert.rejects(e.embed('x'), (err) => err.code === 'EMBED_FAILED');
  } finally {
    m2.restore();
  }
  // ollama 网络失败
  const m3 = mockFetch(() => {
    throw new TypeError('connection refused');
  });
  try {
    const e = createEmbedder({ provider: 'ollama', endpoint: 'http://127.0.0.1:9', model: 'm' });
    await assert.rejects(e.embed('x'), (err) => err.code === 'EMBED_FAILED');
  } finally {
    m3.restore();
  }
  // ollama 响应非 JSON
  const m4 = mockFetch(() => new Response('not json', { status: 200 }));
  try {
    const e = createEmbedder({ provider: 'ollama', endpoint: 'http://127.0.0.1:9/', model: 'm' });
    await assert.rejects(e.embed('x'), (err) => err.code === 'EMBED_FAILED');
  } finally {
    m4.restore();
  }
});

test('ollama：响应缺 embeddings[0] → EMBED_FAILED', async () => {
  const m = mockFetch(() => new Response(JSON.stringify({ embeddings: [] }), { status: 200 }));
  try {
    const e = createEmbedder({ provider: 'ollama', endpoint: 'http://127.0.0.1:9/', model: 'm' });
    await assert.rejects(e.embed('x'), (err) => err.code === 'EMBED_FAILED');
  } finally {
    m.restore();
  }
});

test('memo 超容量逐出最旧（容量 100，LRU 语义）', async () => {
  let requests = 0;
  const m = mockFetch(() => {
    requests += 1;
    return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
  });
  try {
    const e = createEmbedder({ provider: 'openai-compatible', endpoint: 'https://x/v1/embeddings', model: 'm' });
    for (let i = 0; i < 120; i++) {
      await e.embed(`text-${i}`);
    }
    assert.equal(requests, 120, '120 个不同文本各请求一次');
    // 最旧 20 个已被逐出（容量 100）→ 重新请求。
    await e.embed('text-0');
    await e.embed('text-119');
    assert.equal(requests, 121, 'text-0 被逐出需重请求，text-119 仍命中缓存');
  } finally {
    m.restore();
  }
});
