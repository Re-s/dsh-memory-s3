// test/vector.test.mjs — 向量检索：归一化 / 余弦 / top-k / 过滤 / 性能冒烟。

import test from 'node:test';
import assert from 'node:assert/strict';

import { toFloat32, normalize, cosine, bruteForceTopK } from '../lib/vector.mjs';

test('toFloat32：返回 Float32Array 且值一致', () => {
  const arr = toFloat32([1, 2, 3]);
  assert.ok(arr instanceof Float32Array);
  assert.deepEqual([...arr], [1, 2, 3]);
  const already = toFloat32(arr);
  assert.equal(already, arr); // 已是 Float32Array 则原样返回
});

test('normalize：L2 范数为 1；不修改入参', () => {
  const input = [3, 4];
  const out = normalize(input);
  assert.deepEqual(input, [3, 4]); // 纯函数：入参不被污染
  assert.ok(out instanceof Float32Array);
  assert.ok(Math.abs(Math.sqrt(out[0] ** 2 + out[1] ** 2) - 1) < 1e-6);
  assert.ok(Math.abs(out[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.8) < 1e-6);
});

test('normalize：零向量保持全 0，长度不变', () => {
  const out = normalize([0, 0, 0]);
  assert.deepEqual([...out], [0, 0, 0]);
});

test('cosine：相同 1 / 正交 0 / 相反 -1 / 零向量 0', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-6);
  assert.ok(Math.abs(cosine([1, 0], [0, 1]) - 0) < 1e-6);
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-6);
  assert.equal(cosine([0, 0], [1, 0]), 0);
  assert.equal(cosine([1, 0], [0, 0]), 0);
});

test('cosine：未归一化输入内部兜底；长度不一致按较短者', () => {
  assert.ok(Math.abs(cosine([3, 4], [3, 4]) - 1) < 1e-6); // 范数兜底
  assert.ok(Math.abs(cosine([1, 0, 0], [1, 0]) - 1) < 1e-6); // min 长度
});

test('bruteForceTopK：按相似度降序返回 top-k', () => {
  // 查询 q=[1,0,0]，item.a 平行、item.b 45°、item.c 正交、item.d 反向。
  const items = [
    { id: 'a', vec: [1, 0, 0], meta: { type: 'project' } },
    { id: 'b', vec: [1, 1, 0], meta: { type: 'project' } },
    { id: 'c', vec: [0, 1, 0], meta: { type: 'history' } },
    { id: 'd', vec: [-1, 0, 0], meta: { type: 'preference' } },
  ];
  const top2 = bruteForceTopK([1, 0, 0], items, 2);
  assert.deepEqual(top2, [
    { id: 'a', score: 1 },
    { id: 'b', score: 1 / Math.sqrt(2) },
  ]);
});

test('bruteForceTopK：k 默认 10；k<=0 与空输入返回 []', () => {
  const items = [
    { id: 'a', vec: [1, 0] },
    { id: 'b', vec: [0, 1] },
  ];
  const all = bruteForceTopK([1, 0], items);
  assert.equal(all.length, 2); // 默认 k=10 全量
  assert.deepEqual(bruteForceTopK([1, 0], items, 0), []);
  assert.deepEqual(bruteForceTopK([1, 0], items, -3), []);
  assert.deepEqual(bruteForceTopK([1, 0], [], 5), []);
  assert.deepEqual(bruteForceTopK([1, 0], null, 5), []);
});

test('bruteForceTopK：filterFn 过滤前置（先缩候选再扫描）', () => {
  const items = [
    { id: 'a', vec: [1, 0], meta: { type: 'project' } },
    { id: 'b', vec: [0.9, 0.1], meta: { type: 'project' } },
    { id: 'c', vec: [0.99, 0.01], meta: { type: 'history' } },
    { id: 'd', vec: [0.95, 0.05], meta: { type: 'history' } },
  ];
  const projects = bruteForceTopK([1, 0], items, 10, (item) => item.meta.type === 'project');
  assert.deepEqual(
    projects.map((r) => r.id),
    ['a', 'b'],
  );
});

test('bruteForceTopK：vec 缺失的条目自动跳过', () => {
  const items = [
    { id: 'a', vec: [1, 0] },
    { id: 'broken', meta: {} }, // 无 vec
    { id: 'nullvec', vec: null },
    { id: 'badvec', vec: 'nope' },
    { id: 'b', vec: [0, 1] },
  ];
  const result = bruteForceTopK([1, 0], items, 10);
  assert.deepEqual(
    result.map((r) => r.id),
    ['a', 'b'],
  );
});

test('bruteForceTopK：性能冒烟（10k × 768 全扫）', () => {
  const dim = 768;
  const n = 10_000;
  // 确定性伪随机，保证可复现；目标向量与 query 同向，应排第一。
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const items = [];
  for (let i = 0; i < n; i++) {
    const vec = new Float32Array(dim);
    let sum = 0;
    for (let d = 0; d < dim; d++) {
      vec[d] = rand();
      sum += vec[d] * vec[d];
    }
    // 全同向随机向量时相似度趋于一致，这里不预设排序，只验证可跑 + 形状。
    items.push({ id: `e${i}`, vec });
  }
  const query = new Float32Array(dim).fill(1);
  const start = performance.now();
  const result = bruteForceTopK(query, items, 10);
  const elapsed = performance.now() - start;
  assert.equal(result.length, 10);
  assert.ok(result.every((r) => typeof r.score === 'number' && r.id.startsWith('e')));
  // 宽松阈值：CI 抖动下不应超 3s；目标几十 ms（TECH_STACK §4 估算）。
  assert.ok(elapsed < 3000, `10k×768 scan took ${elapsed.toFixed(0)}ms`);
  console.log(`[vector] 10k×768 bruteForceTopK: ${elapsed.toFixed(1)}ms`);
});

test('bruteForceTopK：已归一化输入得分即余弦', () => {
  const q = normalize([1, 0, 0]);
  const items = [{ id: 'x', vec: normalize([0.5, Math.sqrt(3) / 2, 0]) }];
  const [r] = bruteForceTopK(q, items, 1);
  assert.ok(Math.abs(r.score - 0.5) < 1e-6);
});
