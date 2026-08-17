// lib/sigv4.mjs — 最小 SigV4 签名器（零依赖，node:crypto）。
//
// 实现 AWS Signature Version 4（header-based auth）：
//   CanonicalRequest → StringToSign → SigningKey(四层 HMAC) → Authorization。
// 规范依据 https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
//
// 设计取舍（对 dsh-memory-s3 的 5 类请求面收窄）：
// - SignedHeaders 最小集 = host + x-amz-content-sha256 + x-amz-date
//   （+ x-amz-security-token 当有 sessionToken；调用方显式提供的 x-amz-* 头也纳入，
//   因为 AWS 规范要求所有 x-amz-* 头必须签名）。
// - CanonicalQueryString：每个 name/value 先 decodeURIComponent（防双重编码）再按
//   RFC3986 编码（保留 A-Za-z0-9-_.~），最后按编码后的 name 字母序排序、'&' 连接。
// - CanonicalURI：S3 path-style 时路径为 /bucket/key，逐段编码且不编码 '/'。
//   注意：S3 官方对路径编码有平台例外（不编码部分字符），骨架阶段采用标准 RFC3986
//   逐段编码——我们的 key 是 ASCII（memories/{type}/{id}.json），两套规则无差异。
// - unsignedPayload 选项：S3 流式上传场景用 'UNSIGNED-PAYLOAD' 占位，避免大 body
//   双次散列；普通小对象默认 sha256hex(body)（header-based auth）。

import { createHash, createHmac } from 'node:crypto';

/** RFC3986 编码：encodeURIComponent 已保留 A-Za-z0-9-_.~，额外补 !'()*。 */
export function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** SHA-256 十六进制摘要；body 接受 string / Buffer / Uint8Array / 缺省(视为空)。 */
export function sha256hex(data) {
  const input = data === undefined || data === null ? '' : data;
  return createHash('sha256').update(input).digest('hex');
}

/** HMAC-SHA256（key 接受 string 或 Buffer；四层派生时逐层传入上一层的 Buffer）。 */
export function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/** 空 payload 的规范散列（sha256hex('')），测试与诊断用。 */
export const EMPTY_PAYLOAD_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** decodeURIComponent 容错：输入并非合法百分号编码时原样返回（不静默吞错，但容忍半编码输入）。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * CanonicalQueryString：解析原始 search，逐 name/value 解码再 RFC3986 编码，
 * 按编码后的整体字符串排序（'&' 连接）。空查询返回 ''。
 * 先解码再编码保证「调用方用 uriEncode 拼好的 URL」与「直接传未编码值」得到同一 canonical 形式。
 */
function canonicalQueryString(search) {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw === '') return '';
  const pairs = raw.split('&').filter((p) => p !== '');
  const encoded = pairs.map((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    return `${uriEncode(safeDecode(name))}=${uriEncode(safeDecode(value))}`;
  });
  encoded.sort();
  return encoded.join('&');
}

/** CanonicalURI：pathname 逐段编码，保留 '/'；空路径规范为 '/'。 */
function canonicalUri(pathname) {
  if (pathname === '' || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

/**
 * 对请求做 SigV4 签名。
 * @param {object} opts
 * @param {string} opts.method - HTTP 方法（GET/PUT/DELETE/HEAD）。
 * @param {string} opts.url - 完整请求 URL（含 query）。
 * @param {Record<string, string>} [opts.headers] - 已构造的请求头（content-type 等；x-amz-* 会纳入签名）。
 * @param {string|Buffer|Uint8Array} [opts.body] - 请求体（PUT 用）。
 * @param {string} opts.accessKey - 访问密钥 ID（Credential 前缀）。
 * @param {string} opts.secretKey - 秘密访问密钥。
 * @param {string} [opts.sessionToken] - STS 临时令牌（存在则加 x-amz-security-token 并纳入签名）。
 * @param {string} [opts.region='us-east-1'] - 区域（MinIO/自建占位；R2 用 auto）。
 * @param {string} opts.service - 服务名（本插件固定 's3'）。
 * @param {string} [opts.amzDate] - 固定时间 YYYYMMDDTHHMMSSZ（测试确定性）；缺省取当前 UTC。
 * @param {boolean} [opts.unsignedPayload] - true 时 payload hash 用 'UNSIGNED-PAYLOAD'（流式场景）。
 * @returns {Record<string, string>} 可直发 fetch 的 headers（含 x-amz-* 与 Authorization）。
 */
export function signRequest({
  method,
  url,
  headers = {},
  body,
  accessKey,
  secretKey,
  sessionToken,
  region = 'us-east-1',
  service,
  amzDate,
  unsignedPayload = false,
}) {
  const parsed = new URL(url);
  const now = amzDate ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const date = now.slice(0, 8);

  // 签名头集合：host + 调用方 x-amz-* + 必填三件套（调用方显式给的值优先，保证与请求一致）。
  const signed = { host: parsed.host };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-amz-')) signed[lower] = String(value).trim();
  }
  signed['x-amz-content-sha256'] = signed['x-amz-content-sha256'] ?? (unsignedPayload ? 'UNSIGNED-PAYLOAD' : sha256hex(body));
  signed['x-amz-date'] = signed['x-amz-date'] ?? now;
  if (sessionToken) signed['x-amz-security-token'] = sessionToken;

  const signedHeaderNames = Object.keys(signed).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${signed[name]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(parsed.pathname),
    canonicalQueryString(parsed.search),
    canonicalHeaders,
    signedHeaders,
    signed['x-amz-content-sha256'],
  ].join('\n');

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', now, scope, sha256hex(canonicalRequest)].join('\n');

  // 四层密钥派生：AWS4+secret → date → region → service → aws4_request。
  const dateKey = hmac(`AWS4${secretKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headers, ...signed, Authorization: authorization };
}
