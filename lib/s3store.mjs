// lib/s3store.mjs — S3 兼容对象存储客户端（零依赖：fetch + sigv4）。
//
// 覆盖 dsh-memory-s3 的 5 类请求面（ARCHITECTURE.md §3）：Get/Put/Delete/Head/
// ListObjectsV2，全部 forcePathStyle（`{endpoint}/{bucket}/{prefix}/{key}`）。
//
// 并发写协议（乐观锁，无锁数据库语义）：
// - 创建：PutObject + If-None-Match: *；已存在返回 412/409 → 抛 {code:'CONFLICT'}。
// - 更新：HeadObject 取 ETag → PutObject + If-Match: <etag>；被并发修改同样 CONFLICT。
// 调用方（service 层）负责 CONFLICT 后的重读-合并-重试。
//
// 错误分类（ARCHITECTURE.md D8）：
// - 网络错误 / 5xx → {code:'S3_UNAVAILABLE', retryable:true}（getObject/putObject 指数退避重试 ≤3 次）；
// - 412/409   → {code:'CONFLICT', retryable:false}；
// - 其余 4xx  → {code:'S3_ERROR', status, retryable:false}（配置错误响亮失败）。
//
// listObjects 的 XML 解析用正则骨架（注释标注）：本插件 key 形态固定
// （memories/{type}/{id}.json，ASCII），ETag 由存储服务端生成，NextContinuationToken
// 为 URL-safe base64——均不含需反转义的 XML 实体，骨架简化成立；未来若 key 允许
// 任意字符再升级为真 XML 解析器。

import { signRequest, uriEncode } from './sigv4.mjs';

/** ETag 去引号：存储服务端返回 "abc123" 带引号，If-Match 需要裸值。 */
function stripQuotes(etag) {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

/** 拼 query 字符串：值全部 RFC3986 编码（与 sigv4 的 canonical 形式幂等）。 */
function buildQuery(entries = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${uriEncode(name)}=${uriEncode(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最小 ListObjectsV2 XML 解析（正则骨架，见文件头注释）。 */
function parseListXml(xml) {
  const first = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1] : undefined;
  };
  const all = (tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map((m) => m[1]);
  const keys = all('Key');
  const etags = all('ETag');
  const lastModifieds = all('LastModified');
  const items = keys.map((key, i) => ({
    key,
    etag: etags[i] === undefined ? undefined : stripQuotes(etags[i]),
    lastModified: lastModifieds[i],
  }));
  return { items, isTruncated: first('IsTruncated') === 'true', nextToken: first('NextContinuationToken') };
}

/**
 * 创建 S3 客户端。
 * @param {object} config
 * @param {string} config.endpoint - 形如 https://host[:port]（不含 bucket 路径）。
 * @param {string} [config.region='us-east-1'] - 区域；MinIO/自建占位，R2 用 auto。
 * @param {string} config.bucket - 桶名。
 * @param {string} [config.prefix=''] - 对象根前缀（如 'dsh-memory-s3'）；空 = 桶根。
 * @param {string} [config.accessKey=''] - 访问密钥 ID（缺失时请求会 4xx，由上层 configured 门控）。
 * @param {string} [config.secretKey='']
 * @param {string} [config.sessionToken=''] - STS 临时令牌（可选）。
 * @param {{maxRetries?: number, baseDelayMs?: number}} [config.retry] - 重试参数（测试可调小延迟）。
 */
export function createS3Store(config) {
  const {
    endpoint,
    region = 'us-east-1',
    bucket,
    prefix = '',
    accessKey = '',
    secretKey = '',
    sessionToken = '',
    retry = { maxRetries: 3, baseDelayMs: 100 },
  } = config;
  const base = `${String(endpoint).replace(/\/+$/, '')}/${bucket}${prefix ? `/${prefix}` : ''}`;

  /** 条目对象相对 key（不含 bucket 与 config.prefix），对齐 ARCHITECTURE.md §3 布局。 */
  function keyOf(type, id) {
    return `memories/${type}/${id}.json`;
  }

  /**
   * 单次带签名请求 + 错误分类。
   * @param {{method: string, path: string, query?: object, headers?: object, body?: string,
   *          signal?: AbortSignal, notFoundIsNull?: boolean}} opts
   * @returns {Promise<Response|null>} notFoundIsNull 且 404 时返回 null。
   */
  async function request({ method, path, query, headers = {}, body, signal, notFoundIsNull = false }) {
    const url = `${base}${path}${buildQuery(query)}`;
    const signed = signRequest({
      method,
      url,
      headers,
      body,
      accessKey,
      secretKey,
      sessionToken,
      region,
      service: 's3',
    });
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: signed,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal,
      });
    } catch (error) {
      // fetch 网络层错误（DNS/连接拒绝/超时）：归类为可重试，由调用方退避。
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`s3 network error: ${message}`), {
        code: 'S3_UNAVAILABLE',
        message,
        retryable: true,
        cause: error,
      });
    }
    if (res.status === 404 && notFoundIsNull) return null;
    if (res.status === 412 || res.status === 409) {
      // 条件写失败：对象已存在（If-None-Match）或被并发修改（If-Match）。
      throw Object.assign(new Error('conditional write conflict'), { code: 'CONFLICT', retryable: false });
    }
    if (res.status >= 500) {
      throw Object.assign(new Error(`s3 server error ${res.status}`), {
        code: 'S3_UNAVAILABLE',
        message: `s3 ${res.status}`,
        retryable: true,
      });
    }
    if (res.status >= 400) {
      throw Object.assign(new Error(`s3 client error ${res.status}`), {
        code: 'S3_ERROR',
        status: res.status,
        message: `s3 ${res.status}`,
        retryable: false,
      });
    }
    return res;
  }

  /** 指数退避重试：仅对 retryable 错误，最多 retry.maxRetries 次重试，基础延迟 ×2^n，抖动 ±50%。 */
  async function withRetry(fn) {
    let attempts = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (error?.retryable !== true || attempts >= retry.maxRetries) throw error;
        attempts += 1;
        const baseDelay = retry.baseDelayMs * 2 ** (attempts - 1);
        await sleep(baseDelay * (0.5 + Math.random()));
      }
    }
  }

  /** GetObject → {body, etag?}；404 → null。对可重试错误退避重试。 */
  async function getObject(key, { signal } = {}) {
    return withRetry(async () => {
      const res = await request({ method: 'GET', path: `/${key}`, signal, notFoundIsNull: true });
      if (res === null) return null;
      const body = await res.text();
      const etag = res.headers.get('etag');
      return { body, etag: etag === null ? undefined : stripQuotes(etag) };
    });
  }

  /**
   * PutObject → {etag?}。条件写透传 If-None-Match / If-Match；412/409 → CONFLICT。
   * 对可重试错误退避重试（PUT 幂等：同 key 同 body 重放无害）。
   */
  async function putObject(key, body, { ifNoneMatch, ifMatch, contentType = 'application/json', signal } = {}) {
    const headers = { 'content-type': contentType };
    if (ifNoneMatch !== undefined) headers['if-none-match'] = ifNoneMatch;
    if (ifMatch !== undefined) headers['if-match'] = ifMatch;
    return withRetry(async () => {
      const res = await request({ method: 'PUT', path: `/${key}`, headers, body, signal });
      const etag = res.headers.get('etag');
      return { etag: etag === null ? undefined : stripQuotes(etag) };
    });
  }

  /** DeleteObject → void（versioning 下产生删除标记，可恢复；对不存在 key 的 DELETE 存储端幂等返回 2xx）。 */
  async function deleteObject(key, { signal } = {}) {
    await request({ method: 'DELETE', path: `/${key}`, signal });
  }

  /** HeadObject → {etag?, lastModified?}；404 → null。 */
  async function headObject(key, { signal } = {}) {
    const res = await request({ method: 'HEAD', path: `/${key}`, signal, notFoundIsNull: true });
    if (res === null) return null;
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    return {
      etag: etag === null ? undefined : stripQuotes(etag),
      lastModified: lastModified === undefined ? undefined : lastModified,
    };
  }

  /**
   * ListObjectsV2 → {keys: [{key, etag?, lastModified?}], nextToken?}。
   * @param {{prefix?: string, continuationToken?: string, signal?: AbortSignal}} opts
   *   prefix 为相对 config.prefix 的对象前缀（如 'memories/'）；返回的 key 同样相对
   *   config.prefix（与 keyOf 一致，sync 层可直接 getObject）。
   */
  async function listObjects({ prefix: subPrefix, continuationToken, signal } = {}) {
    const query = { 'list-type': '2' };
    const sub = subPrefix ?? '';
    query.prefix = prefix ? (sub ? `${prefix}/${sub}` : prefix) : sub;
    if (continuationToken !== undefined && continuationToken !== '') {
      query['continuation-token'] = continuationToken;
    }
    const res = await request({ method: 'GET', path: '/', query, signal, notFoundIsNull: true });
    // 兼容层：AWS 对不存在的 prefix 返回空列表；RustFS 等部分实现返回 404。
    // notFoundIsNull 使 404 返回 null → 视为空列表（AWS/RustFS 行为差异兼容）。
    if (res === null) return { keys: [], nextToken: undefined };
    const xml = await res.text();
    const parsed = parseListXml(xml);
    const stripRoot = (key) => {
      if (!prefix) return key;
      const root = `${prefix}/`;
      return key.startsWith(root) ? key.slice(root.length) : key;
    };
    const keys = parsed.items.map((item) => ({
      key: stripRoot(item.key),
      etag: item.etag,
      lastModified: item.lastModified,
    }));
    return { keys, nextToken: parsed.isTruncated ? parsed.nextToken : undefined };
  }

  return { getObject, putObject, deleteObject, headObject, listObjects, keyOf };
}
