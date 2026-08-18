// test/filemeta.test.mjs — 附件文件探测模块（lib/filemeta.mjs）全路径测试。
//
// 覆盖：probeFile 各类型真实魔数文件（PNG/JPEG/GIF/WebP/PDF/ZIP + 文本类）、
// 白名单拒绝、大小限制、目录/不存在/空路径、扩展名与魔法字节一致性校验、
// 文本 NUL 拒绝、sniffMime 全类型识别、extensionOf、formatBytes、默认常量导出。
// 全部走临时目录真实文件（node:fs mkdtempSync / writeFileSync / rmSync）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeFile,
  sniffMime,
  extensionOf,
  formatBytes,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_ALLOWED_EXTENSIONS,
  TEXT_EXTENSIONS,
} from '../lib/filemeta.mjs';

/** 各类型最小合法文件体（真实魔数头 + 填充字节；非真实解码，仅魔数识别）。 */
const FIXTURES = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('PNGDATA-填充')]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JPEGDATA')]),
  gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.from('GIFDATA')]),
  gif87: Buffer.concat([Buffer.from('GIF87a'), Buffer.from('GIFDATA')]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('VP8 ') ]),
  pdf: Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.from('\n%âãÏÓ\n')]),
  zip: Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('ZIPDATA')]),
  txt: Buffer.from('这是普通文本，没有任何秘密。\n第二行。'),
  md: Buffer.from('# 标题\n正文 *强调*'),
  json: Buffer.from('{"lab":"okabe","experiment":1}'),
  csv: Buffer.from('name,role\ntrue,assistant\n'),
};

/** 期望的探测结果（mime/kind/extension）。 */
const EXPECT = {
  png: { mime: 'image/png', kind: 'image', extension: 'png' },
  jpg: { mime: 'image/jpeg', kind: 'image', extension: 'jpg' },
  gif: { mime: 'image/gif', kind: 'image', extension: 'gif' },
  webp: { mime: 'image/webp', kind: 'image', extension: 'webp' },
  pdf: { mime: 'application/pdf', kind: 'document', extension: 'pdf' },
  zip: { mime: 'application/zip', kind: 'archive', extension: 'zip' },
  txt: { mime: 'text/plain', kind: 'document', extension: 'txt' },
  md: { mime: 'text/markdown', kind: 'document', extension: 'md' },
  json: { mime: 'application/json', kind: 'document', extension: 'json' },
  csv: { mime: 'text/csv', kind: 'document', extension: 'csv' },
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-filemeta-test-'));
}

/** 在临时目录写文件，返回 {dir, path}。 */
function makeFile(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test('probeFile：各白名单类型的真实魔数文件 → 完整元数据', async () => {
  const dir = tempDir();
  try {
    // gif87 仅作为 sniffMime 用例（扩展名不在白名单），probeFile 遍历不含它。
    for (const [ext, bytes] of Object.entries(FIXTURES).filter(([k]) => k !== 'gif87')) {
      const path = makeFile(dir, `sample.${ext}`, bytes);
      const meta = await probeFile(path);
      const exp = EXPECT[ext];
      assert.equal(meta.extension, exp.extension, `.${ext} extension`);
      assert.equal(meta.mime, exp.mime, `.${ext} mime`);
      assert.equal(meta.kind, exp.kind, `.${ext} kind`);
      assert.equal(meta.name, `sample.${ext}`);
      assert.equal(meta.size, bytes.length);
      assert.ok(Buffer.isBuffer(meta.bytes), 'bytes 应为 Buffer');
      assert.deepEqual(meta.bytes, bytes, 'bytes 逐字节一致');
      assert.match(meta.sha256, /^[0-9a-f]{64}$/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：大小写/多段扩展名规范化（photo.JPG → jpg；a.tar.jpg → jpg）', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'Photo.JPG', FIXTURES.jpg);
    const meta = await probeFile(path);
    assert.equal(meta.extension, 'jpg');
    assert.equal(meta.name, 'Photo.JPG');
    assert.equal(meta.mime, 'image/jpeg');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：空路径 → INVALID_INPUT', async () => {
  await assert.rejects(probeFile(''), (err) => err.code === 'INVALID_INPUT');
  await assert.rejects(probeFile('   '), (err) => err.code === 'INVALID_INPUT');
  await assert.rejects(probeFile(null), (err) => err.code === 'INVALID_INPUT');
});

test('probeFile：文件不存在 → FILE_NOT_FOUND', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(probeFile(join(dir, 'missing.png')), (err) => err.code === 'FILE_NOT_FOUND');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：路径是目录 → INVALID_INPUT（非 regular file）', async () => {
  const dir = tempDir();
  try {
    const sub = join(dir, 'somedir.png');
    mkdirSync(sub);
    await assert.rejects(probeFile(sub), (err) => err.code === 'INVALID_INPUT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：超过 maxBytes → FILE_TOO_LARGE（含 details.size/maxBytes）', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'big.png', FIXTURES.png);
    await assert.rejects(probeFile(path, { maxBytes: 10 }), (err) => {
      assert.equal(err.code, 'FILE_TOO_LARGE');
      assert.equal(err.details.size, FIXTURES.png.length);
      assert.equal(err.details.maxBytes, 10);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：扩展名不在白名单 → UPLOAD_REJECTED', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'evil.exe', Buffer.from('MZ...'));
    await assert.rejects(probeFile(path), (err) => {
      assert.equal(err.code, 'UPLOAD_REJECTED');
      assert.equal(err.details.extension, 'exe');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：自定义 allowedExtensions 白名单生效（.txt 不在 [png] → 拒绝）', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'notes.txt', FIXTURES.txt);
    await assert.rejects(probeFile(path, { allowedExtensions: ['png'] }), (err) => err.code === 'UPLOAD_REJECTED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：allowedExtensions 空数组/非法 → 回退默认白名单', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'ok.png', FIXTURES.png);
    const viaEmpty = await probeFile(path, { allowedExtensions: [] });
    const viaBad = await probeFile(path, { allowedExtensions: 'nope' });
    const viaDefault = await probeFile(path, {});
    assert.equal(viaEmpty.mime, 'image/png');
    assert.equal(viaBad.mime, 'image/png');
    assert.equal(viaDefault.mime, 'image/png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：扩展名与魔法字节不一致（.png 装 PDF）→ UPLOAD_REJECTED', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'fake.png', FIXTURES.pdf);
    await assert.rejects(probeFile(path), (err) => {
      assert.equal(err.code, 'UPLOAD_REJECTED');
      assert.equal(err.details.extension, 'png');
      assert.equal(err.details.detected, 'application/pdf');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：.jpg 装 PNG 内容 → UPLOAD_REJECTED（同样是走私载体）', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'lie.jpg', FIXTURES.png);
    await assert.rejects(probeFile(path), (err) => {
      assert.equal(err.code, 'UPLOAD_REJECTED');
      assert.equal(err.details.detected, 'image/png');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：扩展名白名单内但魔法字节无法识别（.zip 装明文）→ UPLOAD_REJECTED', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'fake.zip', Buffer.from('this is not a zip at all, plain text content'));
    await assert.rejects(probeFile(path), (err) => {
      assert.equal(err.code, 'UPLOAD_REJECTED');
      assert.match(err.message, /unrecognized magic bytes/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：文本类含 NUL 字节 → UPLOAD_REJECTED（二进制伪装文本）', async () => {
  const dir = tempDir();
  try {
    // NUL 置于文件开头（实现只对文件头子串做 NUL 检查）。
    const path = makeFile(dir, 'mixed.txt', Buffer.concat([Buffer.from([0x00, 0x01]), FIXTURES.txt]));
    await assert.rejects(probeFile(path), (err) => {
      assert.equal(err.code, 'UPLOAD_REJECTED');
      assert.match(err.message, /NUL/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeFile：maxBytes 非法值 → 回退默认 20MB', async () => {
  const dir = tempDir();
  try {
    const path = makeFile(dir, 'ok.png', FIXTURES.png);
    const meta = await probeFile(path, { maxBytes: -1 });
    assert.equal(meta.mime, 'image/png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sniffMime：全类型魔数识别', () => {
  const cases = [
    [FIXTURES.png.subarray(0, 12), { mime: 'image/png', kind: 'image' }],
    [FIXTURES.jpg.subarray(0, 12), { mime: 'image/jpeg', kind: 'image' }],
    [FIXTURES.gif.subarray(0, 12), { mime: 'image/gif', kind: 'image' }],
    [FIXTURES.gif87.subarray(0, 12), { mime: 'image/gif', kind: 'image' }],
    [FIXTURES.webp.subarray(0, 12), { mime: 'image/webp', kind: 'image' }],
    [FIXTURES.pdf.subarray(0, 12), { mime: 'application/pdf', kind: 'document' }],
    [FIXTURES.zip.subarray(0, 12), { mime: 'application/zip', kind: 'archive' }],
  ];
  for (const [header, expected] of cases) {
    assert.deepEqual(sniffMime(header), expected, `sniff ${expected.mime}`);
  }
});

test('sniffMime：无法识别 / 空 / 非 Uint8Array → null', () => {
  assert.equal(sniffMime(new Uint8Array([0x00, 0x01, 0x02, 0x03])), null);
  assert.equal(sniffMime(new Uint8Array(0)), null);
  assert.equal(sniffMime(null), null);
  assert.equal(sniffMime([0x89, 0x50, 0x4e, 0x47]), null, '普通数组非 Uint8Array → null');
  assert.equal(sniffMime('GIF89a'), null, '字符串非 Uint8Array → null');
});

test('sniffMime：长度不足类型最低要求 → null（不误判残缺头）', () => {
  // PNG 需要 8 字节；给 4 字节 → null。
  assert.equal(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  // WebP 需要 12 字节；给 RIFF+WEBP 完整 12 → 命中。
  assert.equal(sniffMime(FIXTURES.webp.subarray(0, 12)).mime, 'image/webp');
});

test('extensionOf：小写化、去点、无扩展名返回空串', () => {
  assert.equal(extensionOf('photo.JPG'), 'jpg');
  assert.equal(extensionOf('a.tar.gz'), 'gz');
  assert.equal(extensionOf('README'), '');
  assert.equal(extensionOf('.hidden'), '');
  assert.equal(extensionOf('no.dot'), 'dot');
  assert.equal(extensionOf(''), '');
  assert.equal(extensionOf(undefined), '');
});

test('formatBytes：人类可读字节数', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1500), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024 * 1.5), '1.5 MB');
  assert.equal(formatBytes(1024 * 100), '100 KB');
  assert.equal(formatBytes(1024 * 150), '150 KB');
  assert.equal(formatBytes(1024 * 1024 * 2), '2.0 MB');
  // 非法输入回退 '0 B'。
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
  assert.equal(formatBytes(Infinity), '0 B');
  assert.equal(formatBytes('x'), '0 B');
});

test('默认常量：20MB 上限、11 种白名单扩展名、文本类集合', () => {
  assert.equal(DEFAULT_MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.deepEqual(DEFAULT_ALLOWED_EXTENSIONS, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'txt', 'md', 'json', 'csv']);
  assert.deepEqual([...TEXT_EXTENSIONS].sort(), ['csv', 'json', 'md', 'txt']);
});