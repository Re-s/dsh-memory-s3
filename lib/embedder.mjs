// lib/embedder.mjs — 可插拔嵌入器（零依赖：fetch）。
//
// 支持三种 provider（TECH_STACK.md §5）：
// - 'openai-compatible'：POST {endpoint}，body {model, input, dimensions?, encoding_format:'float'}，
//   解析 data[0].embedding；apiKey 走 Authorization: Bearer。
// - 'ollama'：POST {endpoint}/api/embed，body {model, input, truncate:true}，解析 embeddings[0]。
// - 'none'：embed() 抛 {code:'EMBED_DISABLED'}（降级路径：search 关键词仍可用，recall 降级）。
//
// 统一输出 Float32Array（对齐 lib/vector.mjs 的内存布局）。内部 memo 缓存最近一次
// 嵌入结果（key=text，容量 100，简单 LRU 语义），避免同一内容反复请求网络。
//
// 错误：网络/HTTP/响应形状异常一律抛 {code:'EMBED_FAILED'}（可重试性由调用方决定）；
// 不打印请求体/响应体全文（可能含记忆内容，脱敏纪律）。

const MEMO_CAP = 100;

/** 简单 LRU memo：命中提升为最新；超容逐出最旧（Map 迭代序头部）。 */
function createMemo() {
  const map = new Map();
  return {
    get(text) {
      if (!map.has(text)) return undefined;
      const value = map.get(text);
      map.delete(text);
      map.set(text, value);
      return value;
    },
    set(text, value) {
      if (map.has(text)) map.delete(text);
      map.set(text, value);
      while (map.size > MEMO_CAP) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
    },
  };
}

/** 统一错误构造：EMBED_FAILED + 原因（不带响应全文）。 */
function embedFailed(reason, cause) {
  const error = Object.assign(new Error(`embed failed: ${reason}`), {
    code: 'EMBED_FAILED',
    message: reason,
    ...(cause === undefined ? {} : { cause }),
  });
  return error;
}

/**
 * 创建嵌入器。
 * @param {object} config
 * @param {'openai-compatible'|'ollama'|'none'} [config.provider='none'] - 提供方；none = 禁用。
 * @param {string} [config.endpoint=''] - openai-compatible 的完整 /embeddings URL；ollama 的 base URL。
 * @param {string} [config.apiKey=''] - openai-compatible 的 Bearer key（空则不带头）。
 * @param {string} [config.model=''] - 模型名。
 * @param {number} [config.dimensions] - 向量维度（openai-compatible 请求体透传）。
 * @returns {{name: 'none'|'openai-compatible'|'ollama', dimensions: number,
 *            embed: (text: string) => Promise<Float32Array>}}
 */
export function createEmbedder(config = {}) {
  const { provider = 'none', endpoint = '', apiKey = '', model = '', dimensions } = config;
  const memo = createMemo();

  if (provider === 'none') {
    return {
      name: 'none',
      dimensions: 0,
      // async 语义与其他 provider 统一：调用方总是 await embed()，拒绝走 rejection 而非同步 throw。
      async embed() {
        throw Object.assign(new Error('embedding disabled (provider none)'), { code: 'EMBED_DISABLED' });
      },
    };
  }

  if (provider === 'openai-compatible') {
    if (typeof endpoint !== 'string' || endpoint === '') {
      throw Object.assign(new Error('openai-compatible embedder requires endpoint'), { code: 'INVALID_CONFIG' });
    }
    return {
      name: 'openai-compatible',
      dimensions: Number.isFinite(dimensions) ? dimensions : 0,
      async embed(text) {
        const cached = memo.get(text);
        if (cached !== undefined) return cached;
        let res;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              input: text,
              ...(Number.isFinite(dimensions) ? { dimensions } : {}),
              encoding_format: 'float',
            }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw embedFailed(`request failed: ${message}`, error);
        }
        if (!res.ok) throw embedFailed(`HTTP ${res.status}`);
        let json;
        try {
          json = await res.json();
        } catch (error) {
          throw embedFailed('response is not valid JSON', error);
        }
        const vec = json?.data?.[0]?.embedding;
        if (!Array.isArray(vec)) throw embedFailed('response missing data[0].embedding');
        const out = Float32Array.from(vec);
        memo.set(text, out);
        return out;
      },
    };
  }

  if (provider === 'ollama') {
    if (typeof endpoint !== 'string' || endpoint === '') {
      throw Object.assign(new Error('ollama embedder requires endpoint'), { code: 'INVALID_CONFIG' });
    }
    const base = endpoint.replace(/\/+$/, '');
    return {
      name: 'ollama',
      dimensions: Number.isFinite(dimensions) ? dimensions : 0,
      async embed(text) {
        const cached = memo.get(text);
        if (cached !== undefined) return cached;
        let res;
        try {
          res = await fetch(`${base}/api/embed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, input: text, truncate: true }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw embedFailed(`request failed: ${message}`, error);
        }
        if (!res.ok) throw embedFailed(`HTTP ${res.status}`);
        let json;
        try {
          json = await res.json();
        } catch (error) {
          throw embedFailed('response is not valid JSON', error);
        }
        const vec = json?.embeddings?.[0];
        if (!Array.isArray(vec)) throw embedFailed('response missing embeddings[0]');
        const out = Float32Array.from(vec);
        memo.set(text, out);
        return out;
      },
    };
  }

  throw Object.assign(new Error(`unknown embedder provider "${provider}"`), { code: 'INVALID_CONFIG' });
}
