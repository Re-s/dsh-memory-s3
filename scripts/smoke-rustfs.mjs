// scripts/smoke-rustfs.mjs — 真实 RustFS 端点冒烟验签脚本（dsh-memory-s3）。
//
// 验证链路（对齐 ARCHITECTURE.md §3 并发写协议）：
//   0. ListBuckets 探测（signRequest 手动签名 GET /）
//   1. PUT If-None-Match:* 创建         → 期望成功
//   2. 重复 PUT If-None-Match:*         → 期望 CONFLICT（对象已存在）
//   3. GET                              → 期望内容一致
//   4. HEAD                             → 期望拿到 ETag
//   5. PUT If-Match:<etag> 更新         → 期望成功
//   6. PUT If-Match:<错误etag>          → 期望 CONFLICT（被并发修改）
//   7. ListObjectsV2                    → 期望出现测试对象
//   8. DELETE                           → 期望成功
//   9. GET                              → 期望 null（404）
//
// 凭据从环境变量读取（RUSTFS_AK / RUSTFS_SK / RUSTFS_ENDPOINT / RUSTFS_BUCKET / RUSTFS_REGION），
// 脚本本身不含任何凭据。
import { createS3Store } from '../lib/s3store.mjs';
import { signRequest } from '../lib/sigv4.mjs';

const ENDPOINT = process.env.RUSTFS_ENDPOINT || 'https://obj.seq.ink/';
const AK = process.env.RUSTFS_AK;
const SK = process.env.RUSTFS_SK;
const REGION = process.env.RUSTFS_REGION || 'us-east-1';
const REQUESTED_BUCKET = process.env.RUSTFS_BUCKET || '';

if (!AK || !SK) {
  console.error('✗ 缺少凭据：需要 RUSTFS_AK / RUSTFS_SK 环境变量');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** ListBuckets：GET /（根路径，不在 s3store 接口内，手动签名）。 */
async function listBuckets() {
  const url = ENDPOINT.replace(/\/+$/, '') + '/';
  const signed = signRequest({
    method: 'GET',
    url,
    headers: {},
    body: undefined,
    accessKey: AK,
    secretKey: SK,
    region: REGION,
    service: 's3',
  });
  const res = await fetch(url, { method: 'GET', headers: signed });
  const text = await res.text();
  // 极简 XML 提取 <Name>...</Name>（ListAllMyBucketsResult 形状）。
  const names = [...text.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
  return { status: res.status, names, text: text.slice(0, 300) };
}

async function main() {
  console.log(`\n=== dsh-memory-s3 真实端点冒烟验签 ===`);
  console.log(`endpoint: ${ENDPOINT} | region: ${REGION} | bucket: ${REQUESTED_BUCKET || '(探测)'}\n`);

  // 0. 凭据有效性 + bucket 探测
  let bucket = REQUESTED_BUCKET;
  try {
    const lb = await listBuckets();
    if (lb.status === 200) {
      console.log(`  0. ListBuckets ✔（status 200，可用桶: ${lb.names.join(', ') || '无'}）`);
      if (!bucket) {
        bucket = lb.names.find((n) => /mem|s3|test|data/i.test(n)) || lb.names[0];
      }
    } else {
      // 403 说明签名有效但权限不足；或服务不支持 ListBuckets（部分实现只放行 bucket 内操作）。
      console.log(`  0. ListBuckets → HTTP ${lb.status}（${lb.text}）`);
      console.log('     （签名有效但可能无 ListBuckets 权限，或该实现不支持——继续用显式 bucket）');
      if (!bucket) {
        console.error('  ✗ 无法探测 bucket，请通过 RUSTFS_BUCKET 环境变量指定');
        process.exit(2);
      }
    }
  } catch (error) {
    console.error(`  0. ListBuckets 网络/签名错误: ${error.message}`);
    console.error('  ✗ 凭据或端点不可达——冒烟终止');
    process.exit(1);
  }

  console.log(`\n  → 使用 bucket: ${bucket}\n`);
  const store = createS3Store({
    endpoint: ENDPOINT,
    region: REGION,
    bucket,
    prefix: '',
    accessKey: AK,
    secretKey: SK,
    retry: { maxRetries: 2, baseDelayMs: 200 },
  });

  const id = `smoke-${Date.now()}`;
  const key = store.keyOf('preference', id);
  const entry = {
    id,
    type: 'preference',
    title: 'RustFS 冒烟',
    content: `真实端点验签 ${new Date().toISOString()}`,
    tags: ['smoke'],
    importance: 3,
    source: 'smoke-test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recallCount: 0,
    lastRecalled: null,
    workspaceKey: '',
    agentKey: '',
  };
  const body = JSON.stringify(entry);

  try {
    // 1. 创建（If-None-Match: *）
    const put1 = await store.putObject(key, body, { ifNoneMatch: '*' });
    check('1. PUT If-None-Match:* 创建', !!put1.etag, `etag=${put1.etag}`);

    // 2. 重复创建 → CONFLICT
    let conflict1 = false;
    try {
      await store.putObject(key, body, { ifNoneMatch: '*' });
    } catch (error) {
      conflict1 = error?.code === 'CONFLICT';
    }
    check('2. 重复 PUT If-None-Match:* → CONFLICT', conflict1);

    // 3. GET 内容一致
    const got = await store.getObject(key);
    check('3. GET 内容一致', got?.body === body, `len=${got?.body?.length ?? 0}`);

    // 4. HEAD 取 ETag
    const head = await store.headObject(key);
    check('4. HEAD 取 ETag', !!head?.etag, `etag=${head?.etag}`);

    // 5. If-Match 更新
    const updated = { ...entry, content: '更新后的内容' };
    const put2 = await store.putObject(key, JSON.stringify(updated), { ifMatch: head.etag });
    check('5. PUT If-Match:<etag> 更新', !!put2.etag);

    // 6. 错误 If-Match → CONFLICT
    let conflict2 = false;
    try {
      await store.putObject(key, JSON.stringify(updated), { ifMatch: '"deadbeef"' });
    } catch (error) {
      conflict2 = error?.code === 'CONFLICT';
    }
    check('6. PUT If-Match:<错误etag> → CONFLICT', conflict2);

    // 7. ListObjectsV2
    const listed = await store.listObjects({ prefix: `memories/preference/` });
    const seen = listed.keys.some((k) => k.key === key);
    check('7. ListObjectsV2 出现测试对象', seen, `total=${listed.keys.length}`);

    // 8. DELETE
    await store.deleteObject(key);
    check('8. DELETE', true);

    // 9. GET → null
    const gone = await store.getObject(key);
    check('9. GET 后删除 → null(404)', gone === null);
  } catch (error) {
    console.error(`\n  ✗ 冒烟异常: ${error?.code || ''} ${error?.message || error}`);
    // 清理遗留对象
    try {
      await store.deleteObject(key);
    } catch {
      /* 忽略清理失败 */
    }
    fail += 1;
  }

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('fatal:', error?.message || error);
  process.exit(1);
});
