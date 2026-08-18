// scripts/smoke-attachments.mjs — 真实 S3 端点附件冒烟（dsh-memory-s3 附件能力）。
//
// 验证链路（附件对象 files/{id} + 条目元数据）：
//   1. probeFile 本地探测（临时 PNG：真实魔数头 + 随机载荷）→ 元数据（sha256/mime/kind）
//   2. PUT files/{id} If-None-Match:*（contentType image/png）→ 期望成功
//   3. 重复 PUT 同 key If-None-Match:* → 期望 CONFLICT（附件不可变键）
//   4. GET binary → 期望 Buffer 与原始字节逐字节一致（二进制往返不损坏）
//   5. 重新计算 sha256 → 期望与探测阶段一致（完整性 proof）
//   6. 条目 PUT（attachments 元数据挂载）→ GET → 期望 attachments 元数据完整回读
//   7. 清理：DELETE 附件 + 条目 → GET 均 null
//
// 凭据从环境变量读取（RUSTFS_AK / RUSTFS_SK / RUSTFS_ENDPOINT / RUSTFS_BUCKET / RUSTFS_REGION），
// 脚本本身不含任何凭据。lib/ 为纯 node 模块，可直接 import。
import { createS3Store } from '../lib/s3store.mjs';
import { probeFile, formatBytes } from '../lib/filemeta.mjs';
import { normalizeEntry, toJSON } from '../lib/entry.mjs';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = process.env.RUSTFS_ENDPOINT || 'https://obj.seq.ink/';
const AK = process.env.RUSTFS_AK;
const SK = process.env.RUSTFS_SK;
const REGION = process.env.RUSTFS_REGION || 'us-east-1';
const BUCKET = process.env.RUSTFS_BUCKET;

if (!AK || !SK || !BUCKET) {
  console.error('✗ 缺少凭据：需要 RUSTFS_AK / RUSTFS_SK / RUSTFS_BUCKET 环境变量');
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

async function main() {
  console.log(`\n=== dsh-memory-s3 附件真实端点冒烟 ===`);
  console.log(`endpoint: ${ENDPOINT} | bucket: ${BUCKET}\n`);

  const store = createS3Store({
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET,
    prefix: '',
    accessKey: AK,
    secretKey: SK,
    retry: { maxRetries: 2, baseDelayMs: 200 },
  });

  // 0. 临时 PNG：真实魔数头（89 50 4E 47 0D 0A 1A 0A）+ 随机载荷（非真实图像体，仅验证传输完整性）。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-attach-'));
  const pngPath = join(dir, 'smoke-attachment.png');
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const payload = Buffer.concat([magic, randomBytes(4096)]);
  writeFileSync(pngPath, payload);

  const entryId = `attach-smoke-${Date.now()}`;

  try {
    // 1. probeFile 本地探测
    const probed = await probeFile(pngPath);
    check('1. probeFile 识别 PNG', probed.mime === 'image/png' && probed.kind === 'image',
      `${probed.name} ${formatBytes(probed.size)} sha256=${probed.sha256.slice(0, 12)}…`);

    const attachmentId = `smoke-${Date.now()}`;
    const objectKey = store.fileKeyOf(attachmentId);
    check('1b. fileKeyOf 布局 files/{id}', objectKey === `files/${attachmentId}`, objectKey);

    // 2. 附件对象创建
    const put1 = await store.putObject(objectKey, probed.bytes, {
      contentType: probed.mime,
      ifNoneMatch: '*',
    });
    check('2. PUT files/{id} If-None-Match:* 创建', !!put1.etag, `etag=${put1.etag}`);

    // 3. 重复创建 → CONFLICT（附件不可变）
    let conflict = false;
    try {
      await store.putObject(objectKey, probed.bytes, { contentType: probed.mime, ifNoneMatch: '*' });
    } catch (error) {
      conflict = error?.code === 'CONFLICT';
    }
    check('3. 重复 PUT If-None-Match:* → CONFLICT', conflict);

    // 4. 二进制 GET 往返
    const got = await store.getObject(objectKey, { binary: true });
    const bytewise = got !== null && Buffer.isBuffer(got.body) && Buffer.compare(got.body, payload) === 0;
    check('4. GET binary 逐字节一致', bytewise, `len=${got?.body?.length ?? 0}`);

    // 5. sha256 完整性
    const { createHash } = await import('node:crypto');
    const rehash = createHash('sha256').update(got.body).digest('hex');
    check('5. 下载内容 sha256 与探测一致', rehash === probed.sha256, rehash.slice(0, 12));

    // 6. 条目挂附件元数据 → 落盘 → 回读
    const attachmentMeta = {
      id: attachmentId,
      name: probed.name,
      mime: probed.mime,
      kind: probed.kind,
      size: probed.size,
      sha256: probed.sha256,
      objectKey,
      createdAt: Date.now(),
    };
    const entry = normalizeEntry({
      type: 'history',
      title: '附件冒烟',
      content: `真实附件端点验证 ${new Date().toISOString()}`,
      tags: ['smoke'],
      attachments: [attachmentMeta],
    }, { workspaceKey: '', agentKey: '' });
    const entryKey = store.keyOf(entry.type, entry.id);
    await store.putObject(entryKey, JSON.stringify(toJSON(entry)), { ifNoneMatch: '*' });
    const gotEntry = await store.getObject(entryKey);
    const parsed = gotEntry ? JSON.parse(gotEntry.body) : null;
    const metaRoundTrip = parsed?.attachments?.[0]?.sha256 === probed.sha256 && parsed?.attachments?.[0]?.objectKey === objectKey;
    check('6. 条目 attachments 元数据落盘回读一致', metaRoundTrip, `entry=${parsed?.id}`);

    // 7. 清理
    await store.deleteObject(objectKey);
    await store.deleteObject(entryKey);
    const gone1 = await store.getObject(objectKey, { binary: true });
    const gone2 = await store.getObject(entryKey);
    check('7. 清理后均 404', gone1 === null && gone2 === null);
  } catch (error) {
    console.error(`\n  ✗ 附件冒烟异常: ${error?.code || ''} ${error?.message || error}`);
    fail += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('fatal:', error?.message || error);
  process.exit(1);
});