// scripts/backfill-embeddings.mjs — 存量记忆 embedding 回填脚本。
//
// 背景：在接入 Ollama 向量嵌入之前保存的存量记忆没有 embedding 字段，语义召回
// （recall 向量路径）无法命中它们（只能关键词命中）。本脚本为「缺失 embedding 的
// 存量条目」补算真实向量并入缓存。
//
// 行为：
//   1. 读取缓存目录（默认 $DSH_HOME/dsh-memory-s3/cache，可用 --cacheDir 覆盖）。
//   2. 对每个缺失 embedding 的条目，用 createEmbedder({provider:'ollama',...})
//      给 content 计算 768 维向量。
//   3. 写回前先把原文件备份到 entries/ 同级 .bak-<ts>/ 目录（可恢复）。
//   4. 用 createCache.putEntry 写回（磁盘 + 插件同款内存管理语义）。
//   5. 若进程环境含 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY，则同步把这些条目
//      PUT 回 S3（键 memories/<type>/<id>.json），使回填对 sync 持久（推荐
//      在插件进程同环境运行以获得凭据）；否则打印提示（仅缓存层生效）。
//
// 用法：
//   node scripts/backfill-embeddings.mjs \
//     --cacheDir /home/master/.deepseek-harness/dsh-memory-s3/cache \
//     --endpoint http://127.0.0.1:11434 --model nomic-embed-text
//
// 幂等：已含 embedding 的条目跳过（不做重复计算）；重复运行安全。
// 退出码：0=全部成功；1=部分失败（已尽力完成）；2=环境错误（Ollama 不可达等）。

import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createEmbedder } from '../lib/embedder.mjs';
import { createCache } from '../lib/cache.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cacheDir') args.cacheDir = argv[++i];
    else if (argv[i] === '--endpoint') args.endpoint = argv[++i];
    else if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--no-s3') args.noS3 = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness');
const cacheDir = args.cacheDir ?? join(DSH_HOME, 'dsh-memory-s3', 'cache');
const endpoint = args.endpoint ?? process.env.MEMORY_S3_TEST_OLLAMA_BASE ?? 'http://127.0.0.1:11434';
const model = args.model ?? process.env.MEMORY_S3_TEST_EMBED_MODEL ?? 'nomic-embed-text';

const accessKey = process.env.AWS_ACCESS_KEY_ID ?? '';
const secretKey = process.env.AWS_SECRET_ACCESS_KEY ?? '';
const s3Enabled = !args.noS3 && accessKey !== '' && secretKey !== '';

// ── S3 回写（可选；凭据存在时才启用）────────────────────────────────────
let putS3 = async () => {};
if (s3Enabled) {
  const { createS3Store } = await import('../lib/s3store.mjs');
  const bucket = process.env.MEMORY_S3_BUCKET ?? 'dsh-mem';
  const endpointS3 = process.env.MEMORY_S3_ENDPOINT ?? 'https://obj.seq.ink/';
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const prefix = process.env.MEMORY_S3_PREFIX ?? '';
  const s3 = createS3Store({ endpoint: endpointS3, region, bucket, prefix, accessKey, secretKey });
  putS3 = async (type, id, entry) => {
    const key = s3.keyOf(type, id);
    await s3.putObject(key, JSON.stringify(entry), { contentType: 'application/json' });
  };
}

// ── 探活 ─────────────────────────────────────────────────────────────────
async function probeOllama() {
  const res = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return false;
  const j = await res.json();
  return Boolean(j?.version);
}

const stableSort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function main() {
  if (!(await probeOllama())) {
    console.error(`[backfill] Ollama 不可达（${endpoint}），中止。`);
    return 2;
  }

  const entriesDir = join(cacheDir, 'entries');
  if (!existsSync(entriesDir)) {
    console.log(`[backfill] 未找到条目目录：${entriesDir}（无需回填或缓存为空）`);
    return 0;
  }

  const cache = createCache({ dir: cacheDir });
  const embedder = createEmbedder({ provider: 'ollama', endpoint, model });
  const files = readdirSync(entriesDir).filter((f) => f.endsWith('.json')).sort(stableSort);

  // 备份原文件：.bak-<timestamp>/ 子目录（与 entries 同级，避免污染条目扫描）。
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bakDir = join(cacheDir, `.bak-${ts}`);
  mkdirSync(bakDir, { recursive: true });

  const toBackfill = [];
  for (const f of files) {
    const id = f.slice(0, -'.json'.length);
    const entry = cache.getEntry(id);
    if (entry !== null && Array.isArray(entry.embedding)) continue; // 已有向量，跳过
    toBackfill.push({ id, f });
  }
  if (toBackfill.length === 0) {
    console.log('[backfill] 全部条目已含 embedding，无需回填。');
    return 0;
  }

  console.log(`[backfill] 待回填 ${toBackfill.length} 条（总 ${files.length} 条）。备份目录：${bakDir}`);
  let ok = 0;
  let failed = 0;

  for (const { id, f } of toBackfill) {
    const entry = cache.getEntry(id);
    if (entry === null) {
      console.warn(`[backfill] 跳过（读取失败）：${id}`);
      failed += 1;
      continue;
    }
    try {
      const vec = await embedder.embed(entry.content);
      const next = { ...entry, embedding: [...vec] };
      copyFileSync(join(entriesDir, f), join(bakDir, f)); // 备份原文件
      cache.putEntry(id, next); // 写回磁盘 + 插件同款内存层
      if (s3Enabled) {
        await putS3(next.type, next.id, toPublicForS3(next));
      }
      ok += 1;
      console.log(`  ✓ ${next.type}/${next.title}（${vec.length} 维）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${id}: ${msg}`);
      failed += 1;
    }
  }

  console.log(
    `[backfill] 完成：成功 ${ok}，失败 ${failed}` +
      (s3Enabled ? '（已同步 S3，sync 持久）' : '（未检测到 AWS 凭据，仅缓存层生效；建议在插件进程同环境运行以同步 S3）'),
  );
  return failed === 0 ? 0 : 1;
}

/** S3 落盘用序列化：保留 embedding，供远端持久（与 toJSON 一致但含 embedding）。 */
function toPublicForS3(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

main()
  .then((code) => process.exitCode = code)
  .catch((err) => {
    console.error(`[backfill] 致命错误：${err instanceof Error ? err.message : err}`);
    process.exitCode = 2;
  });
