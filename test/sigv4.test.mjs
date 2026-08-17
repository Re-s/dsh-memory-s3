// test/sigv4.test.mjs — SigV4 签名器行为测试（node:test，零依赖）。
//
// 覆盖：Authorization 结构、签名确定性（同输入同签名）、payload/查询变化改变签名、
// unsignedPayload 选项、sessionToken 纳入签名、canonical query 排序（不同顺序同签名）、
// sha256hex 已知值。不要求匹配 AWS 官方向量（任务明示），但结构必须符合规范。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, sha256hex, EMPTY_PAYLOAD_HASH } from '../lib/sigv4.mjs';

const BASE = {
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
  amzDate: '20260817T120000Z',
};

test('signRequest 生成结构正确的 Authorization 头', () => {
  const headers = signRequest({
    method: 'GET',
    url: 'https://example.s3.amazonaws.com/memories/preference/abc.json',
    headers: {},
    ...BASE,
  });
  const auth = headers.Authorization;
  // 前缀 + Credential 含完整 scope（date/region/service/aws4_request）。
  assert.match(auth, /^AWS4-HMAC-SHA256 /);
  assert.match(auth, /Credential=AKIAIOSFODNN7EXAMPLE\/20260817\/us-east-1\/s3\/aws4_request/);
  // SignedHeaders 最小集（host 不在 Authorization 里出现，但 x-amz-* 在）。
  assert.match(auth, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  // Signature 必须是 64 位小写 hex。
  const sig = auth.match(/Signature=([0-9a-f]{64})$/);
  assert.ok(sig, `signature should be 64 lowercase hex, got: ${auth}`);
  // x-amz-date 头回填。
  assert.equal(headers['x-amz-date'], '20260817T120000Z');
  // GET 无 body → payload hash = sha256hex('')。
  assert.equal(headers['x-amz-content-sha256'], EMPTY_PAYLOAD_HASH);
});

test('签名确定性：相同输入两次调用产生相同签名', () => {
  const opts = {
    method: 'PUT',
    url: 'https://minio.local:9000/mem/dsh-memory-s3/memories/preference/x.json',
    body: '{"a":1}',
    ...BASE,
  };
  const a = signRequest(opts);
  const b = signRequest(opts);
  assert.equal(a.Authorization, b.Authorization);
  assert.equal(a['x-amz-content-sha256'], sha256hex('{"a":1}'));
});

test('body 变化改变签名（payload hash 纳入 canonical request）', () => {
  const mk = (body) =>
    signRequest({
      method: 'PUT',
      url: 'https://h/b/memories/preference/x.json',
      body,
      ...BASE,
    }).Authorization;
  assert.notEqual(mk('{"a":1}'), mk('{"a":2}'));
});

test('query 顺序不影响签名（canonical query 按编码后 key 排序）', () => {
  const mk = (url) =>
    signRequest({
      method: 'GET',
      url,
      ...BASE,
    }).Authorization;
  // 同样的参数不同书写顺序 → 相同 canonical form → 相同签名。
  assert.equal(mk('https://h/b?list-type=2&prefix=memories/&a=1'), mk('https://h/b?a=1&prefix=memories/&list-type=2'));
  // 真编码过的值（%20）与未编码空格（安全起见用 encodeURIComponent 构造 URL）不双重编码。
  const encoded = `https://h/b?prefix=${encodeURIComponent('my prefix')}`;
  const raw = 'https://h/b?prefix=my%20prefix';
  assert.equal(mk(encoded), mk(raw));
});

test('unsignedPayload 选项使用 UNSIGNED-PAYLOAD 占位', () => {
  const headers = signRequest({
    method: 'PUT',
    url: 'https://h/b/memories/preference/x.json',
    body: '{"big":true}',
    unsignedPayload: true,
    ...BASE,
  });
  assert.equal(headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
});

test('sessionToken 加入 x-amz-security-token 头并纳入 SignedHeaders', () => {
  const headers = signRequest({
    method: 'GET',
    url: 'https://h/b/memories/preference/x.json',
    sessionToken: 'FwoGZXIvYXdzEH0EXAMPLE',
    ...BASE,
  });
  assert.equal(headers['x-amz-security-token'], 'FwoGZXIvYXdzEH0EXAMPLE');
  assert.match(headers.Authorization, /x-amz-security-token/);
});

test('调用方提供的 x-amz-* 头纳入签名集合', () => {
  const headers = signRequest({
    method: 'PUT',
    url: 'https://h/b/memories/preference/x.json',
    headers: { 'x-amz-meta-custom': 'v1' },
    body: '{}',
    ...BASE,
  });
  assert.match(headers.Authorization, /x-amz-meta-custom/);
  assert.equal(headers['x-amz-meta-custom'], 'v1');
});

test('sha256hex 空串为已知摘要', () => {
  assert.equal(sha256hex(''), EMPTY_PAYLOAD_HASH);
  assert.equal(sha256hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
