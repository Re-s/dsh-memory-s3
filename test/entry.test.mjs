// test/entry.test.mjs — 条目模型：校验 / 规范化 / 序列化 / 秘密检测。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TYPES,
  DEFAULT_IMPORTANCE,
  normalizeEntry,
  validateEntry,
  toJSON,
  fromJSON,
  sameTitle,
  detectSecret,
  detectEntrySecrets,
} from '../lib/entry.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('TYPES 枚举对齐 types.d.ts', () => {
  assert.deepEqual(TYPES, ['preference', 'project', 'decision', 'history']);
});

test('normalizeEntry：完整输入 → 规范条目', () => {
  const now = 1_700_000_000_000;
  const entry = normalizeEntry(
    { type: 'project', title: '  微波炉实验  ', content: '电话微波炉（暂定名）的第 1 号实验。', tags: ['lab', '实验'], importance: 4, source: 'seed' },
    { workspaceKey: '/lab', agentKey: 'okabe', now },
  );
  assert.match(entry.id, UUID_RE);
  assert.equal(entry.type, 'project');
  assert.equal(entry.title, '微波炉实验'); // trim
  assert.equal(entry.content, '电话微波炉（暂定名）的第 1 号实验。');
  assert.deepEqual(entry.tags, ['lab', '实验']);
  assert.equal(entry.importance, 4);
  assert.equal(entry.source, 'seed');
  assert.equal(entry.createdAt, now);
  assert.equal(entry.updatedAt, now);
  assert.equal(entry.recallCount, 0);
  assert.equal(entry.lastRecalled, null);
  assert.equal(entry.workspaceKey, '/lab');
  assert.equal(entry.agentKey, 'okabe');
  assert.equal(entry.embedding, undefined);
});

test('normalizeEntry：缺省值（importance=3 / tags=[] / source=tool / timestamps=now）', () => {
  const before = Date.now();
  const entry = normalizeEntry({ type: 'history', title: 't', content: 'c' }, { workspaceKey: '', agentKey: '' });
  assert.equal(entry.importance, DEFAULT_IMPORTANCE);
  assert.deepEqual(entry.tags, []);
  assert.equal(entry.source, 'tool');
  assert.ok(entry.createdAt >= before && entry.createdAt <= Date.now());
  assert.equal(entry.updatedAt, entry.createdAt);
  assert.equal(entry.workspaceKey, '');
  assert.equal(entry.agentKey, '');
});

test('normalizeEntry：importance 夹取到 [1,5]，非数字回退 3', () => {
  const base = { type: 'decision', title: 't', content: 'c' };
  assert.equal(normalizeEntry({ ...base, importance: 0 }).importance, 1);
  assert.equal(normalizeEntry({ ...base, importance: 9 }).importance, 5);
  assert.equal(normalizeEntry({ ...base, importance: -3 }).importance, 1);
  assert.equal(normalizeEntry({ ...base, importance: 2.5 }).importance, 2.5); // 夹取不取整
  assert.equal(normalizeEntry({ ...base, importance: NaN }).importance, 3);
  assert.equal(normalizeEntry({ ...base, importance: 'high' }).importance, 3);
});

test('normalizeEntry：tags 元素转字符串、trim、去空', () => {
  const entry = normalizeEntry({ type: 'preference', title: 't', content: 'c', tags: [' a ', '', 42, 'b'] });
  assert.deepEqual(entry.tags, ['a', '42', 'b']);
});

test('normalizeEntry：embedding 可选保留；非数组抛 INVALID_INPUT', () => {
  const base = { type: 'preference', title: 't', content: 'c' };
  const withVec = normalizeEntry({ ...base, embedding: [0.1, 0.2] });
  assert.deepEqual(withVec.embedding, [0.1, 0.2]);
  assert.throws(() => normalizeEntry({ ...base, embedding: 'nope' }), (err) => err.code === 'INVALID_INPUT');
});

test('normalizeEntry：非法输入抛结构化错误 {code:"INVALID_INPUT"}', () => {
  const base = { type: 'preference', title: 't', content: 'c' };
  assert.throws(() => normalizeEntry({ ...base, type: 'gossip' }), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => normalizeEntry({ ...base, title: '   ' }), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => normalizeEntry({ ...base, title: 7 }), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => normalizeEntry({ ...base, content: undefined }), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => normalizeEntry({ ...base, tags: 'nope' }), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => normalizeEntry(null), (err) => err.code === 'INVALID_INPUT');
});

test('validateEntry：合法条目 → null', () => {
  const entry = normalizeEntry({ type: 'project', title: 't', content: 'c' });
  assert.equal(validateEntry(entry), null);
});

test('validateEntry：非法 type / 缺字段 / importance 越界 → 结构化错误', () => {
  const entry = normalizeEntry({ type: 'decision', title: 't', content: 'c' });

  const badType = validateEntry({ ...entry, type: 'gossip' });
  assert.equal(badType.code, 'INVALID_INPUT');
  assert.match(badType.message, /invalid type/);

  const { content, ...noContent } = entry;
  const missing = validateEntry(noContent);
  assert.equal(missing.code, 'INVALID_INPUT');
  assert.ok(missing.details.missing.includes('content'));

  for (const importance of [0, 6, NaN, '4']) {
    const err = validateEntry({ ...entry, importance });
    assert.equal(err.code, 'INVALID_INPUT');
  }
  // 空 title 也非法（去重键不可空）
  assert.equal(validateEntry({ ...entry, title: '   ' }).code, 'INVALID_INPUT');
  // embedding 类型错误
  assert.equal(validateEntry({ ...entry, embedding: 'x' }).code, 'INVALID_INPUT');
  assert.equal(validateEntry({ ...entry, embedding: [0.1, 'x'] }).code, 'INVALID_INPUT');
});

test('toJSON：白名单字段 + 未知字段丢弃 + embedding 可选', () => {
  const entry = normalizeEntry({ type: 'history', title: 't', content: 'c', embedding: [1] });
  const withDirty = { ...entry, hackerField: 'x', embedding: [1] };
  const json = toJSON(withDirty);
  assert.equal(json.hackerField, undefined);
  assert.deepEqual(json.embedding, [1]);
  assert.equal(Object.keys(json).length, 14); // 13 个固定字段 + embedding

  const plain = toJSON(normalizeEntry({ type: 'history', title: 't', content: 'c' }));
  assert.equal('embedding' in plain, false); // 未嵌入的条目序列化不含 embedding
});

test('fromJSON：round-trip 一致', () => {
  const entry = normalizeEntry({ type: 'project', title: 't', content: 'c', tags: ['a'], importance: 5 }, { workspaceKey: '/w', agentKey: 'a' });
  assert.deepEqual(fromJSON(toJSON(entry)), entry);
});

test('fromJSON：缺字段补默认，未知字段丢弃', () => {
  const restored = fromJSON({ type: 'preference', title: 't' });
  assert.equal(restored.type, 'preference');
  assert.equal(restored.content, '');
  assert.deepEqual(restored.tags, []);
  assert.equal(restored.importance, DEFAULT_IMPORTANCE);
  assert.equal(restored.source, 'unknown');
  assert.equal(restored.createdAt, 0);
  assert.equal(restored.updatedAt, 0);
  assert.equal(restored.recallCount, 0);
  assert.equal(restored.lastRecalled, null);
  assert.equal(restored.workspaceKey, '');
  assert.equal(restored.agentKey, '');
  assert.equal(restored.hackerField, undefined);
  assert.match(restored.id, UUID_RE);
});

test('fromJSON：type 缺失补默认 history；非法 type 抛 INVALID_INPUT', () => {
  assert.equal(fromJSON({ title: 't' }).type, 'history');
  assert.throws(() => fromJSON({ type: 'gossip', title: 't' }), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => fromJSON(null), (err) => err.code === 'INVALID_INPUT');
});

test('sameTitle：同类型 + trim 后相等才是同一去重键', () => {
  const a = { type: 'preference', title: '  香蕉  ' };
  assert.equal(sameTitle(a, { type: 'preference', title: '香蕉' }), true);
  assert.equal(sameTitle(a, { type: 'preference', title: '苹果' }), false);
  assert.equal(sameTitle(a, { type: 'history', title: '香蕉' }), false);
  assert.equal(sameTitle(a, { type: 'preference', title: 'BANANA' }), false); // 区分大小写
});

test('detectSecret：AWS AK / ASIA 命中', () => {
  assert.deepEqual(detectSecret('key = AKIAIOSFODNN7EXAMPLE'), { code: 'SECRET_DETECTED', pattern: 'aws-access-key' });
  assert.deepEqual(detectSecret('temp ASIA1234567890ABCDEF'), { code: 'SECRET_DETECTED', pattern: 'aws-access-key' });
});

test('detectSecret：JWT 命中', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.deepEqual(detectSecret(`Bearer ${jwt}`), { code: 'SECRET_DETECTED', pattern: 'jwt' });
});

test('detectSecret：PEM 私钥头命中（含 RSA/EC/OPENSSH 变体）', () => {
  assert.deepEqual(detectSecret('-----BEGIN PRIVATE KEY-----'), { code: 'SECRET_DETECTED', pattern: 'pem-private-key' });
  assert.deepEqual(detectSecret('-----BEGIN RSA PRIVATE KEY-----'), { code: 'SECRET_DETECTED', pattern: 'pem-private-key' });
  assert.deepEqual(detectSecret('-----BEGIN EC PRIVATE KEY-----'), { code: 'SECRET_DETECTED', pattern: 'pem-private-key' });
  assert.deepEqual(detectSecret('-----BEGIN OPENSSH PRIVATE KEY-----'), { code: 'SECRET_DETECTED', pattern: 'pem-private-key' });
});

test('detectSecret：口令赋值命中（大小写 / 分隔符变体）', () => {
  assert.deepEqual(detectSecret('password: hunter2'), { code: 'SECRET_DETECTED', pattern: 'secret-assignment' });
  assert.deepEqual(detectSecret('Password = abc123'), { code: 'SECRET_DETECTED', pattern: 'secret-assignment' });
  assert.deepEqual(detectSecret('api_key=sk-12345'), { code: 'SECRET_DETECTED', pattern: 'secret-assignment' });
  assert.deepEqual(detectSecret('token: xyz'), { code: 'SECRET_DETECTED', pattern: 'secret-assignment' });
  assert.deepEqual(detectSecret('secret := s3cr3t'), { code: 'SECRET_DETECTED', pattern: 'secret-assignment' });
});

test('detectSecret：反例不误报', () => {
  assert.equal(detectSecret('我的密码是生日，不是明文口令'), null);
  assert.equal(detectSecret('AKIA1234'), null); // 后随不足 16 位
  assert.equal(detectSecret('eyJabc.def'), null); // JWT 段过短
  assert.equal(detectSecret('-----BEGIN PUBLIC KEY-----'), null); // 公钥不拒
  assert.equal(detectSecret('password 是 hunter2'), null); // 无 : / = 赋值
  assert.equal(detectSecret('password: '), null); // 冒号后无值
  assert.equal(detectSecret('my_token=abc'), null); // \b 防止词内子串
  assert.equal(detectSecret('普通记忆：今天买了香蕉和苹果。'), null);
  assert.equal(detectSecret(''), null);
});

test('detectEntrySecrets：对 title/content/tags 全量扫描', () => {
  assert.deepEqual(detectEntrySecrets({ title: 'AKIAIOSFODNN7EXAMPLE', content: 'c', tags: [] }).pattern, 'aws-access-key');
  assert.deepEqual(detectEntrySecrets({ title: 't', content: 'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', tags: [] }).pattern, 'jwt');
  assert.deepEqual(detectEntrySecrets({ title: 't', content: 'c', tags: ['api_key=sk-1'] }).pattern, 'secret-assignment');
  assert.equal(detectEntrySecrets({ title: 't', content: 'c', tags: ['ok'] }), null);
});
