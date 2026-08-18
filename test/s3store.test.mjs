// test/s3store.test.mjs — S3 客户端测试（node:test）。
//
// 全部走 mock fetch（替换 globalThis.fetch，finally 恢复）：验证条件写头透传、
// CONFLICT 映射、ListObjectsV2 XML 解析、404→null、keyOf 布局、网络错误分类、
// 指数退避重试次数。绝不真实连网。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createS3Store } from '../lib/s3store.mjs';

const STORE_CONFIG = {
  endpoint: 'https://minio.local:9000',
  bucket: 'mem',
  prefix: 'dsh-memory-s3',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};

/** 安装 mock fetch：记录每次调用的 {url, init}，转发给 handler；返回恢复函数。 */
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

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('putObject 透传 If-None-Match 头并返回去引号 etag', async () => {
  const m = mockFetch(() => jsonResponse('', { headers: { etag: '"abc123"' } }));
  try {
    const store = createS3Store(STORE_CONFIG);
    const { etag } = await store.putObject('memories/preference/x.json', '{"a":1}', { ifNoneMatch: '*' });
    assert.equal(etag, 'abc123');
    assert.equal(m.calls.length, 1);
    const call = m.calls[0];
    assert.equal(call.init.method, 'PUT');
    assert.equal(call.init.headers['if-none-match'], '*');
    // forcePathStyle：{endpoint}/{bucket}/{prefix}/{key}。
    assert.match(call.url, /^https:\/\/minio\.local:9000\/mem\/dsh-memory-s3\/memories\/preference\/x\.json$/);
    // PUT 带 body，且签名头就位。
    assert.equal(call.init.body, '{"a":1}');
    assert.ok(call.init.headers['x-amz-date']);
    assert.match(call.init.headers.Authorization, /^AWS4-HMAC-SHA256 /);
  } finally {
    m.restore();
  }
});

test('putObject 透传 If-Match（乐观并发更新）', async () => {
  const m = mockFetch(() => jsonResponse('', { headers: { etag: '"e2"' } }));
  try {
    const store = createS3Store(STORE_CONFIG);
    await store.putObject('memories/project/y.json', '{}', { ifMatch: 'e2' });
    assert.equal(m.calls[0].init.headers['if-match'], 'e2');
    assert.equal(m.calls[0].init.headers['if-none-match'], undefined);
  } finally {
    m.restore();
  }
});

test('putObject 412 → CONFLICT（创建冲突，不可重试）', async () => {
  const m = mockFetch(() => new Response('', { status: 412 }));
  try {
    const store = createS3Store(STORE_CONFIG);
    await assert.rejects(
      store.putObject('memories/preference/x.json', '{}', { ifNoneMatch: '*' }),
      (err) => err.code === 'CONFLICT' && err.retryable === false,
    );
    // CONFLICT 不触发指数退避重试：只请求一次。
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test('getObject 404 → null，不抛错', async () => {
  const m = mockFetch(() => new Response('', { status: 404 }));
  try {
    const store = createS3Store(STORE_CONFIG);
    const result = await store.getObject('memories/preference/missing.json');
    assert.equal(result, null);
  } finally {
    m.restore();
  }
});

test('getObject 返回 body 与去引号 etag', async () => {
  const m = mockFetch(() => jsonResponse('{"id":"a"}', { headers: { etag: '"etag-1"' } }));
  try {
    const store = createS3Store(STORE_CONFIG);
    const obj = await store.getObject('memories/preference/a.json');
    assert.deepEqual(obj, { body: '{"id":"a"}', etag: 'etag-1' });
    assert.equal(m.calls[0].init.method, 'GET');
  } finally {
    m.restore();
  }
});

test('listObjects 解析最小 XML（剥 prefix、提取 etag/lastModified/nextToken）', async () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    '<Name>mem</Name><Prefix>dsh-memory-s3/</Prefix>' +
    '<IsTruncated>true</IsTruncated>' +
    '<Contents><Key>dsh-memory-s3/memories/preference/a.json</Key>' +
    '<LastModified>2026-08-17T12:00:00.000Z</LastModified><ETag>"aaa"</ETag></Contents>' +
    '<Contents><Key>dsh-memory-s3/memories/project/b.json</Key>' +
    '<LastModified>2026-08-17T12:01:00.000Z</LastModified><ETag>"bbb"</ETag></Contents>' +
    '<NextContinuationToken>tok123</NextContinuationToken>' +
    '</ListBucketResult>';
  const m = mockFetch(() => jsonResponse(xml));
  try {
    const store = createS3Store(STORE_CONFIG);
    const { keys, nextToken } = await store.listObjects({ prefix: 'memories/' });
    assert.equal(keys.length, 2);
    assert.deepEqual(keys[0], {
      key: 'memories/preference/a.json',
      etag: 'aaa',
      lastModified: '2026-08-17T12:00:00.000Z',
    });
    assert.deepEqual(keys[1], { key: 'memories/project/b.json', etag: 'bbb', lastModified: '2026-08-17T12:01:00.000Z' });
    assert.equal(nextToken, 'tok123');
    // query 携带 list-type=2 与完整前缀（config.prefix + 相对前缀）。
    const url = new URL(m.calls[0].url);
    assert.equal(url.searchParams.get('list-type'), '2');
    assert.equal(url.searchParams.get('prefix'), 'dsh-memory-s3/memories/');
  } finally {
    m.restore();
  }
});

test('listObjects 无截断时不返回 nextToken', async () => {
  const xml = '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>dsh-memory-s3/memories/preference/a.json</Key></Contents></ListBucketResult>';
  const m = mockFetch(() => jsonResponse(xml));
  try {
    const store = createS3Store(STORE_CONFIG);
    const { keys, nextToken } = await store.listObjects({ prefix: 'memories/' });
    assert.equal(keys.length, 1);
    assert.equal(nextToken, undefined);
  } finally {
    m.restore();
  }
});

test('listObjects 携带 continuation-token 分页续传', async () => {
  const xml = '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>dsh-memory-s3/memories/preference/b.json</Key></Contents></ListBucketResult>';
  const m = mockFetch(() => jsonResponse(xml));
  try {
    const store = createS3Store(STORE_CONFIG);
    const { keys } = await store.listObjects({ prefix: 'memories/', continuationToken: 'tok-abc' });
    assert.equal(keys.length, 1);
    const url = new URL(m.calls[0].url);
    assert.equal(url.searchParams.get('continuation-token'), 'tok-abc');
  } finally {
    m.restore();
  }
});

test('listObjects 对 404 容错为空列表（AWS/RustFS 行为差异兼容）', async () => {
  const m = mockFetch(() => new Response('', { status: 404 }));
  try {
    const store = createS3Store(STORE_CONFIG);
    const { keys, nextToken } = await store.listObjects({ prefix: 'memories/' });
    assert.equal(keys.length, 0);
    assert.equal(nextToken, undefined);
  } finally {
    m.restore();
  }
});

test('getObject 对 5xx 指数退避重试后成功（最多 3 次重试）', async () => {
  let n = 0;
  const m = mockFetch(() => {
    n += 1;
    if (n <= 2) return new Response('', { status: 503 });
    return jsonResponse('{"ok":1}', { headers: { etag: '"e1"' } });
  });
  try {
    const store = createS3Store({ ...STORE_CONFIG, retry: { maxRetries: 3, baseDelayMs: 1 } });
    const obj = await store.getObject('memories/preference/a.json');
    assert.equal(obj.body, '{"ok":1}');
    assert.equal(n, 3, '两次失败后第三次成功 = 3 次请求');
  } finally {
    m.restore();
  }
});

test('putObject 持续 5xx 时耗尽重试并抛 S3_UNAVAILABLE', async () => {
  let n = 0;
  const m = mockFetch(() => {
    n += 1;
    return new Response('', { status: 500 });
  });
  try {
    const store = createS3Store({ ...STORE_CONFIG, retry: { maxRetries: 2, baseDelayMs: 1 } });
    await assert.rejects(store.putObject('memories/preference/a.json', '{}'), (err) => err.code === 'S3_UNAVAILABLE' && err.retryable === true);
    assert.equal(n, 3, '首次 + 2 次重试 = 3 次请求');
  } finally {
    m.restore();
  }
});

test('网络错误归类为 S3_UNAVAILABLE（retryable）', async () => {
  const m = mockFetch(() => {
    throw new TypeError('fetch failed: connection refused');
  });
  try {
    const store = createS3Store(STORE_CONFIG);
    await assert.rejects(store.getObject('memories/preference/a.json'), (err) => err.code === 'S3_UNAVAILABLE' && err.retryable === true);
  } finally {
    m.restore();
  }
});

test('4xx（非 412/409）归类为 S3_ERROR（不可重试）', async () => {
  const m = mockFetch(() => new Response('<Error><Code>InvalidAccessKeyId</Code></Error>', { status: 403 }));
  try {
    const store = createS3Store(STORE_CONFIG);
    await assert.rejects(store.getObject('memories/preference/a.json'), (err) => err.code === 'S3_ERROR' && err.status === 403 && err.retryable === false);
    assert.equal(m.calls.length, 1, '4xx 不重试');
  } finally {
    m.restore();
  }
});

test('headObject 返回 etag/lastModified，404 → null', async () => {
  let n = 0;
  const m = mockFetch(() => {
    n += 1;
    if (n === 1) return new Response(null, { status: 200, headers: { etag: '"h1"', 'last-modified': 'Mon, 17 Aug 2026 12:00:00 GMT' } });
    return new Response(null, { status: 404 });
  });
  try {
    const store = createS3Store(STORE_CONFIG);
    const hit = await store.headObject('memories/preference/a.json');
    assert.equal(hit.etag, 'h1');
    assert.ok(hit.lastModified);
    const miss = await store.headObject('memories/preference/missing.json');
    assert.equal(miss, null);
  } finally {
    m.restore();
  }
});

test('deleteObject 发出 DELETE 请求', async () => {
  const m = mockFetch(() => new Response(null, { status: 204 }));
  try {
    const store = createS3Store(STORE_CONFIG);
    await store.deleteObject('memories/preference/a.json');
    assert.equal(m.calls[0].init.method, 'DELETE');
  } finally {
    m.restore();
  }
});

test('keyOf 对齐 ARCHITECTURE.md §3 布局', () => {
  const store = createS3Store(STORE_CONFIG);
  assert.equal(store.keyOf('preference', 'abc'), 'memories/preference/abc.json');
  assert.equal(store.keyOf('history', 'xyz'), 'memories/history/xyz.json');
});

test('fileKeyOf：附件对象键为 files/{attachmentId}（无扩展名，与用户名解耦）', () => {
  const store = createS3Store(STORE_CONFIG);
  assert.equal(store.fileKeyOf('att-1'), 'files/att-1');
  assert.equal(store.fileKeyOf('550e8400-e29b-41d4-a716-446655440000'), 'files/550e8400-e29b-41d4-a716-446655440000');
});

test('getObject binary 模式：body 为 Buffer 且逐字节无损（附件二进制往返）', async () => {
  // 真实 PNG 魔数头 + 任意字节：模拟附件二进制对象。
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x01, 0x02, 0x03, 0x04, 0x05, 0xfe, 0xff, 0x80, 0x7f,
  ]);
  const m = mockFetch(() => new Response(bytes, { status: 200, headers: { etag: '"bin-1"' } }));
  try {
    const store = createS3Store(STORE_CONFIG);
    const obj = await store.getObject('files/att-1', { binary: true });
    assert.ok(Buffer.isBuffer(obj.body), 'binary 模式 body 应为 Buffer');
    assert.deepEqual(obj.body, Buffer.from(bytes), 'Buffer 内容与源字节逐字节一致（无 UTF-8 解码损坏）');
    assert.equal(obj.etag, 'bin-1');
    // GET 请求不带 body（方法校验）。
    assert.equal(m.calls[0].init.method, 'GET');
    assert.equal(m.calls[0].init.body, undefined);
  } finally {
    m.restore();
  }
});

test('二进制往返：putObject 上传 Buffer → getObject binary 读回一致', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11, 0x22, 0xff, 0x00]);
  let uploaded = null;
  const m = mockFetch((record) => {
    if (record.init.method === 'PUT') {
      uploaded = Buffer.from(record.init.body);
      return new Response('', { status: 200, headers: { etag: '"up-1"' } });
    }
    // GET：把刚上传的字节原样吐回。
    return new Response(new Uint8Array(uploaded), { status: 200, headers: { etag: '"up-1"' } });
  });
  try {
    const store = createS3Store(STORE_CONFIG);
    await store.putObject('files/att-9', png, { contentType: 'image/png', ifNoneMatch: '*' });
    const obj = await store.getObject('files/att-9', { binary: true });
    assert.deepEqual(obj.body, png, 'PUT→GET 二进制往返无损');
    // 上传请求 content-type 透传附件 mime。
    assert.equal(m.calls[0].init.headers['content-type'], 'image/png');
    assert.equal(m.calls[0].init.headers['if-none-match'], '*');
  } finally {
    m.restore();
  }
});

test('prefix 为空时路径不出现空段（桶根模式）', async () => {
  const m = mockFetch(() => jsonResponse('{}'));
  try {
    const store = createS3Store({ ...STORE_CONFIG, prefix: '' });
    await store.getObject('memories/preference/a.json');
    assert.match(m.calls[0].url, /^https:\/\/minio\.local:9000\/mem\/memories\/preference\/a\.json$/);
  } finally {
    m.restore();
  }
});
