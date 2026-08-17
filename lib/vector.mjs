// lib/vector.mjs — 向量检索：余弦 top-k + 元数据过滤（纯 JS，零依赖）。
//
// 性能设计（对齐 TECH_STACK.md §4：10k×768 全扫 ~10-40ms）：
// - 查询向量只归一化一次；对每个候选向量单遍扫描：累计点积的同时累计
//   平方和，score = dot / sqrt(sumSq)。因为 ||query||=1，这等价于余弦，
//   且比「先归一化再点积」少一遍遍历。
// - 过滤前置：filterFn 在向量扫描之前执行，高选择性过滤时把候选集缩到
//   很小再算距离（对齐 ARCHITECTURE.md D4 的「先过滤再向量」策略）。
// - Float32Array 存储：内存减半且与嵌入器输出对齐。

/** 转 Float32Array（数组 / TypedArray / 类数组均可）。 */
export function toFloat32(vec) {
  if (vec instanceof Float32Array) return vec;
  return Float32Array.from(vec);
}

/**
 * L2 预归一化，总是返回新 Float32Array（纯函数语义，不修改入参）。
 * 零向量（范数为 0）返回原样——除零无意义，保持全 0。
 */
export function normalize(vec) {
  const src = toFloat32(vec);
  const arr = src.slice(); // 拷贝：调用方持有的向量（如条目 embedding）不被污染
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    sumSq += arr[i] * arr[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] /= norm;
    }
  }
  return arr;
}

function dotProduct(a, b, len) {
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * 余弦相似度（带内部兜底：调用方未归一化也能得到正确余弦）。
 * 长度不一致时按较短者计算；任一为零向量返回 0（无方向可比）。
 */
export function cosine(a, b) {
  const fa = toFloat32(a);
  const fb = toFloat32(b);
  const len = Math.min(fa.length, fb.length);
  if (len === 0) return 0;
  let dot = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < len; i++) {
    dot += fa[i] * fb[i];
    sumA += fa[i] * fa[i];
    sumB += fb[i] * fb[i];
  }
  const denom = Math.sqrt(sumA) * Math.sqrt(sumB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * 暴力扫描 top-k：
 * @param {ArrayLike<number>} queryVec 查询向量（内部会预归一化，不修改入参）
 * @param {Array<{id, vec, meta?}>} items 候选集；vec 缺失/非数组的条目自动跳过
 * @param {number} [k=10] 返回条数（<=0 返回空数组）
 * @param {(item: {id, vec, meta}) => boolean} [filterFn] 过滤前置：返回 false 的条目不参与扫描
 * @returns {{id, score}[]} 按相似度降序
 */
export function bruteForceTopK(queryVec, items, k = 10, filterFn = null) {
  const limit = Math.max(0, Math.floor(k));
  if (limit === 0 || !Array.isArray(items) || items.length === 0) return [];

  // 查询只归一化一次（normalize 返回新数组，不污染入参）。
  const q = normalize(queryVec);
  const qLen = q.length;

  const scored = [];
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    if (!item || !item.vec || !Array.isArray(item.vec) && !(item.vec instanceof Float32Array)) {
      continue; // vec 缺失的条目无法参与向量检索
    }
    if (filterFn && !filterFn(item)) continue; // 过滤前置：先缩小候选集
    const v = item.vec;
    const len = Math.min(qLen, v.length);
    let dot = 0;
    let sumSq = 0;
    for (let i = 0; i < len; i++) {
      const vi = v[i];
      dot += q[i] * vi;
      sumSq += vi * vi;
    }
    // ||query||=1 → cosine = dot / ||v||；||v||=0 时无方向，score 0。
    const score = sumSq > 0 ? dot / Math.sqrt(sumSq) : 0;
    scored.push({ id: item.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
