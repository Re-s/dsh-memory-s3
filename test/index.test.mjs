// test/index.test.mjs — 插件入口集成测试（mock ctx + mock fetch，不真实连网）。
//
// 覆盖：enabled:false 整体消失、十三工具与服务注册、systemPrompt 同步快照提供者
// （WeakMap 冻结）、approval answerer 三态裁决（auto/off/ask）、save 写路径
// （审批 → If-None-Match PUT）、审批拒绝 → DENIED + *-denied 审计行、读路径缓存、
// 工具领域错误 → {ok:false, error}；附件能力（save/attach/detach/get_file 全链路、
// 上传回滚、二进制往返、sha256 校验、文本附件秘密检测、快照 📎 渲染、config 白名单
// 与大小限制）。依赖 @deepseek-ai/*（npm install 后可用）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apply, Config, inject } from '../index.mjs';
import { strings } from '../lib/strings.mjs';
import { parseWriteReason } from '../lib/gate.mjs';

const TOOL_NAMES = [
  'memory_s3_save',
  'memory_s3_search',
  'memory_s3_backlinks',
  'memory_s3_recall',
  'memory_s3_list',
  'memory_s3_update',
  'memory_s3_delete',
  'memory_s3_forget',
  'memory_s3_attach',
  'memory_s3_get_file',
  'memory_s3_detach',
  'memory_s3_sync',
  'memory_s3_status',
];

/** 最小 PNG 文件（真实魔数头 + 若干字节；够过 filemeta 魔数嗅探与 sha256 校验）。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 魔数
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR 块头（演示数据，非真实解析）
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
]);

/** 在临时目录写一个附件文件，返回路径。 */
function makeTempFile(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** 按名字取已注册工具。 */
function findTool(tools, name) {
  return tools.find((t) => t.name === name);
}

/** 构造 mock ctx：记录注册面，approval 结果可编程。 */
function makeCtx() {
  const tools = [];
  const sections = [];
  const listeners = new Map();
  const provided = new Map();
  const approvalCalls = [];
  let approvalOutcome = 'allowed-once';
  const ctx = {
    approval: {
      request: async (req) => {
        approvalCalls.push(req);
        return approvalOutcome;
      },
    },
    tools: { register: (def) => tools.push(def) },
    systemPrompt: { section: (def) => sections.push(def) },
    provide: (name, svc) => provided.set(name, svc),
    on: (event, fn, opts) => {
      listeners.set(event, { fn, opts });
      return () => {};
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
  };
  return {
    ctx,
    tools,
    sections,
    listeners,
    provided,
    approvalCalls,
    setApprovalOutcome(outcome) {
      approvalOutcome = outcome;
    },
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-s3-test-'));
}

/**
 * mock fetch：记录调用；S3 PUT/DELETE 成功，GET 默认空 ListBucketResult。
 * handlers 可选定制：
 *  - handlers.putDelete(record, url)：覆盖 PUT/DELETE 响应（如 files/ PUT 抛 412）。
 *  - handlers.get(record, url)：覆盖 GET 分发（区分 list-objects / 条目 JSON / 附件二进制）。
 *  - handlers.head(record, url)：覆盖 HEAD 响应（如远端条目不存在的 404）。
 * 保持向后兼容：不带 handlers 时行为与旧版一致。
 */
function installFetchMock(records, handlers = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init: { ...init, headers: { ...init?.headers } } };
    records.push(record);
    const u = String(url);
    if (init?.method === 'PUT' || init?.method === 'DELETE') {
      if (handlers.putDelete) return handlers.putDelete(record, u);
      return new Response('', { status: 200, headers: { etag: '"e1"' } });
    }
    if (init?.method === 'HEAD') {
      if (handlers.head) return handlers.head(record, u);
      return new Response(null, { status: 200, headers: { etag: '"e1"' } });
    }
    // GET（getObject/listObjects）
    if (handlers.get) return handlers.get(record, u);
    return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

const EXEC = (sessionId = 's1') => ({
  signal: new AbortController().signal,
  agent: { session: { id: sessionId, header: {} } },
  name: 'memory_s3_save',
});

test('Config schema 可编译（对齐 README 配置表）', () => {
  assert.ok(Config, 'Config schema should exist');
  const str = Config.toString();
  assert.ok(str.length > 0);
});

test('enabled:false → 不注册任何东西（整体消失）', () => {
  const { ctx, tools, sections, provided } = makeCtx();
  apply(ctx, { enabled: false });
  assert.equal(tools.length, 0);
  assert.equal(sections.length, 0);
  assert.equal(provided.size, 0);
});

test('apply 注册九工具 + memoryS3 服务 + 快照段 + 事件监听', () => {
  const dir = tempDir();
  try {
    const { ctx, tools, sections, provided, listeners } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES);
    assert.ok(provided.get('memoryS3'), 'ctx.memoryS3 service should be provided');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'dsh-memory-s3:memory');
    assert.equal(sections[0].order, -50);
    assert.ok(listeners.has('approval/request'));
    assert.equal(listeners.get('approval/request').opts.prepend, true);
    assert.ok(listeners.has('session/event'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('systemPrompt 快照提供者同步渲染且按 session 冻结', () => {
  const dir = tempDir();
  try {
    const { ctx, sections } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const session = { id: 's1', header: {} };
    const assemble = { agent: { session } };
    const first = sections[0].text(assemble);
    assert.equal(typeof first, 'string');
    assert.match(first, /not synced|尚未同步/i, '无缓存首启应提示未同步');
    // 冻结：同 session 对象二次调用返回同一字符串（WeakMap）。
    const second = sections[0].text(assemble);
    assert.equal(second, first);
    // 无 session → 空串（不注入）。
    assert.equal(sections[0].text({ agent: null }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approval answerer：writePolicy=auto → allowed-once（不调 next）', async () => {
  const dir = tempDir();
  try {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir, writePolicy: 'auto' });
    const answerer = listeners.get('approval/request').fn;
    let nextCalled = 0;
    const outcome = await answerer(
      { toolName: 'memory_s3_save', reason: '[dsh-memory-s3] save: {"x":1}' },
      async () => {
        nextCalled += 1;
        return 'from-next';
      },
    );
    assert.equal(outcome, 'allowed-once');
    assert.equal(nextCalled, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approval answerer：writePolicy=off → rejected', async () => {
  const dir = tempDir();
  try {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir, writePolicy: 'off' });
    const answerer = listeners.get('approval/request').fn;
    const outcome = await answerer({ toolName: 'memory_s3_save', reason: '[dsh-memory-s3] save: {}' }, async () => 'from-next');
    assert.equal(outcome, 'rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approval answerer：writePolicy=ask → 交下游 next；非本插件请求不认领', async () => {
  const dir = tempDir();
  try {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir, writePolicy: 'ask' });
    const answerer = listeners.get('approval/request').fn;
    let nextCalled = 0;
    const outcome = await answerer(
      { toolName: 'memory_s3_save', reason: '[dsh-memory-s3] save: {}' },
      async () => {
        nextCalled += 1;
        return 'ui-decided';
      },
    );
    assert.equal(outcome, 'ui-decided');
    assert.equal(nextCalled, 1);
    // 其他插件的工具：不认领（next 原样放行）。
    const foreign = await answerer({ toolName: 'other_tool', reason: 'whatever' }, async () => 'foreign-next');
    assert.equal(foreign, 'foreign-next');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_save 写路径：审批 → If-None-Match PUT → 缓存 → search 可见', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = tools.find((t) => t.name === 'memory_s3_save');
    const result = await saveTool.execute(
      { type: 'preference', title: '语言', content: '用户用中文交流', importance: 5 },
      EXEC(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created');
    assert.equal(result.entry.type, 'preference');
    // created 路径：远端预检（缓存空 → listObjects） + PUT 条件创建。
    assert.equal(records.length, 2, 'created = 预检 list + PUT');
    assert.equal(records[0].init.method, 'GET');
    assert.match(records[0].url, /list-type=2/);
    assert.equal(records[1].init.method, 'PUT');
    assert.equal(records[1].init.headers['if-none-match'], '*');
    assert.match(records[1].url, /\/mem\/dsh-memory-s3\/memories\/preference\/.+\.json$/);

    // 读路径：search 走缓存（无需 fetch）。
    const searchTool = tools.find((t) => t.name === 'memory_s3_search');
    const search = await searchTool.execute({ text: '中文' }, EXEC());
    assert.equal(search.ok, true);
    assert.equal(search.total, 1);
    assert.equal(search.entries[0].title, '语言');
    assert.equal(records.length, 2, 'search 不触发网络请求');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('读路径兼容旧缓存：缺 locked 等 v2.1 字段的条目经 search/list 归一化输出', async () => {
  // 回归：更早版本插件写入的缓存条目没有 v2.1 的 locked 字段，但 ENTRY_OUTPUT
  // schema 声明 locked required——读路径若不归一化，search/list 输出校验会炸
  // （missing required property "value.entries[0].locked"）。
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    // 预写一个「旧版本」缓存条目（无 locked、无 subject/timeline/links），
    // 模拟升级前遗留的磁盘缓存。
    const legacy = {
      id: 'legacy-1',
      type: 'preference',
      title: '旧条目',
      content: '升级前写入的缓存，没有 v2.1 字段',
      tags: ['legacy'],
      importance: 4,
      source: 'test',
      createdAt: 1000,
      updatedAt: 1001,
      recallCount: 0,
      lastRecalled: null,
      workspaceKey: 'wk',
      agentKey: 'ag',
    };
    const entryDir = join(dir, 'entries');
    const fs = await import('node:fs');
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(join(entryDir, 'legacy-1.json'), JSON.stringify(legacy) + '\n', { mode: 0o600 });

    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });

    // search：旧条目被读路径归一化补上 locked:false，输出不含 embedded/legacy 崩溃。
    const searchTool = tools.find((t) => t.name === 'memory_s3_search');
    const search = await searchTool.execute({ text: '升级前' }, EXEC());
    assert.equal(search.ok, true, 'search 输出应通过校验');
    assert.equal(search.total, 1);
    assert.equal(search.entries[0].locked, false, '归一化应补默认 locked:false');
    assert.equal(search.entries[0].tags[0], 'legacy');

    // list：同样返回 schema 合规条目。
    const listTool = tools.find((t) => t.name === 'memory_s3_list');
    const list = await listTool.execute({}, EXEC());
    assert.equal(list.ok, true, 'list 输出应通过校验');
    assert.equal(list.total, 1);
    assert.equal(list.entries[0].locked, false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_save 同 (type,title) → merged（update 审批，携带新旧文本）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = tools.find((t) => t.name === 'memory_s3_save');
    await saveTool.execute({ type: 'preference', title: '语言', content: '用户用中文交流' }, EXEC());
    const merged = await saveTool.execute({ type: 'preference', title: '语言', content: '用户用中文和英文交流' }, EXEC());
    assert.equal(merged.ok, true);
    assert.equal(merged.action, 'merged');
    assert.equal(merged.entry.content, '用户用中文和英文交流');
    // merged = head + PUT(If-Match)：最后 2 次请求（前一条 created 的 list+PUT 不计入本轮）。
    const lastTwo = records.slice(-2);
    assert.equal(lastTwo.length, 2);
    assert.equal(lastTwo[0].init.method, 'HEAD');
    assert.equal(lastTwo[1].init.method, 'PUT');
    assert.ok(lastTwo[1].init.headers['if-match']);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审批拒绝 → DENIED + 零落盘 + *-denied 审计行', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, setApprovalOutcome } = makeCtx();
    setApprovalOutcome('rejected');
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = tools.find((t) => t.name === 'memory_s3_save');
    const result = await saveTool.execute({ type: 'preference', title: 'x', content: 'y' }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DENIED');
    // 被拒写零落盘：只可能有缓存空时的预检 GET，绝无 PUT/HEAD 写请求。
    assert.ok(records.every((r) => r.init.method !== 'PUT' && r.init.method !== 'HEAD'), '被拒写零落盘');
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    assert.match(audit, /save-denied/);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具领域错误（NOT_FOUND）→ ok:false + 结构化 error', async () => {
  const dir = tempDir();
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const updateTool = tools.find((t) => t.name === 'memory_s3_update');
    const result = await updateTool.execute({ id: 'does-not-exist' }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NOT_FOUND');
    assert.equal(typeof result.error.message, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_status 反映 configured:false（凭据缺失）与缓存计数', async () => {
  const dir = tempDir();
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const statusTool = tools.find((t) => t.name === 'memory_s3_status');
    const result = await statusTool.execute({}, EXEC());
    assert.equal(result.ok, true);
    assert.equal(result.status.configured, false, '未设置 AWS 凭据 → configured:false');
    assert.equal(result.status.cachedEntries, 0);
    assert.equal(result.status.embedder, 'none');
    assert.equal(result.status.sync.ok, false);
    assert.equal(result.status.sync.lastSync, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 构造一个「register 方法依赖 this」的 fake settings 服务，镜像真实 dsh-settings
 * SettingsProvider.register（内部访问 this.registrations）。用于验证插件必须以
 * 方法调用方式接入 settings 缝——若解构 register 会丢 this，进而抛
 * "Cannot read properties of undefined (reading 'registrations')" 并降级。
 * @param {object} overrides 作为「用户设置层」覆盖 base 的字段。
 */
function makeFakeSettings(overrides) {
  const registrations = new Map();
  const settings = {
    registrations,
    register(ns, schema, options) {
      if (this === undefined || this === null) {
        throw new TypeError("Cannot read properties of undefined (reading 'registrations')");
      }
      if (this.registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`);
      this.registrations.set(ns, options);
      // 用户设置层覆盖 base → 解析后的最终值。
      const resolved = { ...options.base, ...overrides };
      return { get: () => resolved };
    },
  };
  return settings;
}

test('settings 缝：以方法调用接入 register，用户层可覆盖 entry config（回归 this 绑定 bug）', async () => {
  const dir = tempDir();
  try {
    const { ctx, tools } = makeCtx();
    // 注入 fake settings：register 内部用 this.registrations（复现真实 dsh-settings 契约）。
    ctx.settings = makeFakeSettings({
      embedder: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' },
    });
    // entry config 不配 embedder（默认 none）；应由 settings 用户层覆盖为 ollama。
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const statusTool = tools.find((t) => t.name === 'memory_s3_status');
    const result = await statusTool.execute({}, EXEC());
    assert.equal(result.ok, true);
    assert.equal(
      result.status.embedder,
      'ollama',
      'settings 缝应生效（方法调用保持 this 绑定）：用户层覆盖 entry config 默认 none',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('memory_s3_sync 拉取远端条目并更新缓存索引（mock List+Get）', async () => {
  const dir = tempDir();
  const records = [];
  const original = globalThis.fetch;
  let getCount = 0;
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init: { ...init, headers: { ...init?.headers } } };
    records.push(record);
    if (init?.method === 'GET' && String(url).includes('list-type')) {
      const xml =
        '<ListBucketResult><IsTruncated>false</IsTruncated>' +
        '<Contents><Key>dsh-memory-s3/memories/preference/a.json</Key><ETag>"ea"</ETag></Contents>' +
        '</ListBucketResult>';
      return new Response(xml, { status: 200 });
    }
    if (init?.method === 'GET') {
      getCount += 1;
      const entry = {
        id: 'a',
        type: 'preference',
        title: '语言',
        content: '用户用中文交流',
        tags: ['偏好'],
        importance: 5,
        source: 'tool',
        createdAt: 1789000000000,
        updatedAt: 1789000000000,
        recallCount: 0,
        lastRecalled: null,
        workspaceKey: '',
        agentKey: '',
      };
      return new Response(JSON.stringify(entry), { status: 200 });
    }
    return new Response('', { status: 200 });
  };
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const syncTool = tools.find((t) => t.name === 'memory_s3_sync');
    const result = await syncTool.execute({}, EXEC());
    assert.equal(result.ok, true);
    assert.equal(result.result.ok, true);
    assert.equal(result.result.pulled, 1);
    assert.equal(getCount, 1, '一条远端对象 → 一次 GetObject');

    const statusTool = tools.find((t) => t.name === 'memory_s3_status');
    const status = await statusTool.execute({}, EXEC());
    assert.equal(status.status.cachedEntries, 1);
    assert.equal(status.status.sync.ok, true);
    assert.ok(status.status.sync.lastSync);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save 远端预检去重：缓存空但 S3 已有同 (type,title) → merged 而非重复创建', async () => {
  const dir = tempDir();
  const records = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init: { ...init, headers: { ...init?.headers } } };
    records.push(record);
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { etag: '"e1"' } });
    }
    if (init?.method === 'PUT') {
      return new Response('', { status: 200, headers: { etag: '"e2"' } });
    }
    // GET：listObjects 返回一个远端对象 memories/preference/old-id.json。
    const u = new URL(String(url));
    if (u.searchParams.get('list-type') === '2') {
      return new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated>' +
          '<Contents><Key>memories/preference/old-id.json</Key><ETag>"e0"</ETag></Contents>' +
          '</ListBucketResult>',
        { status: 200 },
      );
    }
    // GET：getObject 返回同 title 的远端条目。
    return new Response(
      JSON.stringify({
        id: 'old-id',
        type: 'preference',
        title: '语言',
        content: '旧内容',
        importance: 3,
        tags: [],
        createdAt: 1,
        updatedAt: 1,
        recallCount: 0,
        lastRecalled: null,
        workspaceKey: '',
        agentKey: '',
      }),
      { status: 200 },
    );
  };
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir }); // 缓存空
    const saveTool = tools.find((t) => t.name === 'memory_s3_save');
    const result = await saveTool.execute(
      { type: 'preference', title: '语言', content: '用户用中文交流', importance: 5 },
      EXEC(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'merged', '远端已有同 title → 合并而非创建重复');
    assert.equal(result.entry.content, '用户用中文交流');
    assert.equal(result.entry.id, 'old-id', '沿用远端条目 id');
    // 预检 list + getObject + HEAD + PUT(If-Match) 更新。
    assert.equal(records.length, 4);
    assert.equal(records[3].init.method, 'PUT');
    assert.ok(records[3].init.headers['if-match']);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 附件能力路径（照片/文件）───────────────────────────────────────────────

test('memory_s3_save 带附件：探测→审批→上传 files/{id}→落条目（元数据完整）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools, approvalCalls } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute(
      {
        type: 'preference',
        title: '实验室合影',
        content: '真由理和助手在 Radio Kaikan 的合影',
        importance: 5,
        attachments: [{ path: pngPath, note: '实验室合影' }],
      },
      EXEC(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created');
    const [att] = result.entry.attachments;
    assert.ok(att, 'entry.attachments 应有 1 项');
    assert.equal(att.name, 'photo.png');
    assert.equal(att.mime, 'image/png');
    assert.equal(att.kind, 'image');
    assert.equal(att.size, PNG_BYTES.length);
    assert.equal(att.sha256, createHash('sha256').update(PNG_BYTES).digest('hex'));
    assert.match(att.objectKey, /^files\/[0-9a-f-]{36}$/);
    assert.equal(att.note, '实验室合影');
    assert.ok(Number.isFinite(att.createdAt));
    // created 序列：远端预检 list GET + 附件 PUT + 条目 PUT。
    assert.equal(records.length, 3, 'created 带附件 = list + 附件 PUT + 条目 PUT');
    assert.equal(records[0].init.method, 'GET');
    assert.match(records[0].url, /list-type=2/);
    const filePut = records[1];
    assert.equal(filePut.init.method, 'PUT');
    assert.match(filePut.url, /\/mem\/dsh-memory-s3\/files\/[0-9a-f-]{36}$/);
    assert.equal(filePut.init.headers['if-none-match'], '*', '附件对象条件创建 If-None-Match');
    assert.equal(filePut.init.headers['content-type'], 'image/png', '附件对象 content-type 为探测 mime');
    assert.deepEqual(Buffer.from(filePut.init.body), PNG_BYTES, '附件 PUT body 为原样二进制（无损上传）');
    const entryPut = records[2];
    assert.equal(entryPut.init.method, 'PUT');
    assert.equal(entryPut.init.headers['if-none-match'], '*');
    const stored = JSON.parse(entryPut.init.body);
    assert.equal(stored.attachments.length, 1);
    assert.equal(stored.attachments[0].name, 'photo.png');
    assert.equal(stored.attachments[0].note, '实验室合影');
    assert.equal(stored.attachments[0].objectKey, att.objectKey);
    // 审批 reason 携带附件元数据摘要（不含二进制）。
    const saveApproval = approvalCalls.at(-1);
    assert.ok(saveApproval.reason.includes('实验室合影'), '审批 reason 含附件摘要');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_save 附件文件不存在 → FILE_NOT_FOUND + 零 S3 调用', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute(
      { type: 'preference', title: 't', content: 'c', attachments: [{ path: join(dir, 'nope.png') }] },
      EXEC(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'FILE_NOT_FOUND');
    assert.equal(records.length, 0, '探测失败在审批/上传前：零网络副作用');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memoryS3.save attachments 非数组 → INVALID_INPUT（service 层，工具 schema 已先拦截非法参数）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, provided } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    // 工具 schema（attachments items 含必填 path）会先拦截非法形状；service 层防御要
    // 被覆盖，需绕过 schema 直调 service（write 上下文仅需 agent）。
    const service = provided.get('memoryS3');
    await assert.rejects(
      service.save({ type: 'preference', title: 't', content: 'c', attachments: 'not-an-array' }, { agent: { session: {} } }),
      (err) => err.code === 'INVALID_INPUT' && /array/.test(err.message),
    );
    // 数组元素缺 path → 同样 INVALID_INPUT（探测前拦截）。
    await assert.rejects(
      service.save({ type: 'preference', title: 't', content: 'c', attachments: [{}] }, { agent: { session: {} } }),
      (err) => err.code === 'INVALID_INPUT' && /path/.test(err.message),
    );
    // 探测失败在审批/上传前：零 S3 调用。
    assert.equal(records.length, 0);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_save 文本附件含秘密 → SECRET_DETECTED（save 路径）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const txtPath = makeTempFile(dir, 'notes.txt', '实验室记录：password=abc123 请勿外传');
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute(
      { type: 'preference', title: 't', content: 'c', attachments: [{ path: txtPath }] },
      EXEC(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SECRET_DETECTED');
    assert.equal(records.length, 0, '秘密检测在审批/上传之前：零 S3 副作用');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_attach 给已有条目挂附件 → 追加元数据 + 条件写', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute({ type: 'project', title: '世界线观测', content: '观测记录' }, EXEC());
    records.length = 0;
    const attachTool = findTool(tools, 'memory_s3_attach');
    const result = await attachTool.execute({ id: saved.entry.id, path: pngPath, note: '观测照片' }, EXEC());
    assert.equal(result.ok, true);
    assert.equal(result.entry.attachments.length, 1, 'attach 追加附件元数据');
    assert.equal(result.attachment.name, 'photo.png');
    assert.equal(result.attachment.mime, 'image/png');
    assert.equal(result.attachment.objectKey, result.entry.attachments[0].objectKey);
    assert.equal(result.attachment.note, '观测照片');
    assert.equal(result.entry.attachments[0].createdAt > 0, true);
    assert.equal(records.length, 3, 'attach = 附件 PUT + HEAD + 条目 PUT(If-Match)');
    const filePut = records[0];
    assert.equal(filePut.init.method, 'PUT');
    assert.match(filePut.url, /\/files\/[0-9a-f-]{36}$/);
    assert.equal(filePut.init.headers['content-type'], 'image/png');
    assert.equal(filePut.init.headers['if-none-match'], '*');
    assert.equal(records[1].init.method, 'HEAD');
    assert.equal(records[2].init.method, 'PUT');
    assert.ok(records[2].init.headers['if-match'], '条目更新走乐观锁 If-Match');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_attach 文本附件含秘密 → SECRET_DETECTED（attach 路径）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const txtPath = makeTempFile(dir, 'creds.txt', 'token: xyz-secret-token');
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute({ type: 'project', title: '部署笔记', content: 'c' }, EXEC());
    records.length = 0;
    const attachTool = findTool(tools, 'memory_s3_attach');
    const result = await attachTool.execute({ id: saved.entry.id, path: txtPath }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SECRET_DETECTED');
    assert.equal(records.length, 0, 'attach 秘密附件零网络副作用');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_save 同 title 带附件 → merged 且新附件上传合并（保留旧附件）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    await saveTool.execute({ type: 'preference', title: '设备台账', content: 'v1' }, EXEC());
    records.length = 0;
    const merged = await saveTool.execute(
      { type: 'preference', title: '设备台账', content: 'v2', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    assert.equal(merged.ok, true);
    assert.equal(merged.action, 'merged');
    assert.equal(merged.entry.attachments.length, 1, '合并路径追加新附件');
    // merged 附件路径 = 附件 PUT + HEAD + 条目 PUT(If-Match)。
    assert.equal(records.length, 3);
    assert.equal(records[0].init.method, 'PUT');
    assert.match(records[0].url, /\/files\//);
    assert.equal(records[1].init.method, 'HEAD');
    assert.equal(records[2].init.method, 'PUT');
    assert.ok(records[2].init.headers['if-match']);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_detach 移除附件 → 元数据剥离 + 文件对象删除', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute(
      { type: 'project', title: '世界线观测', content: '观测记录', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    const att = saved.entry.attachments[0];
    records.length = 0;
    const detachTool = findTool(tools, 'memory_s3_detach');
    const result = await detachTool.execute({ id: saved.entry.id, attachmentId: att.id }, EXEC());
    assert.equal(result.ok, true);
    assert.deepEqual(result.entry.attachments, [], 'detach 后条目 attachments 为空');
    assert.equal(result.attachment.id, att.id);
    assert.equal(records.length, 3, 'detach = 文件 DELETE + HEAD + 条目 PUT');
    assert.equal(records[0].init.method, 'DELETE');
    assert.match(records[0].url, /\/files\/[0-9a-f-]{36}$/, 'DELETE 目标为 files/{id}');
    assert.equal(records[1].init.method, 'HEAD');
    assert.equal(records[2].init.method, 'PUT');
    assert.ok(records[2].init.headers['if-match']);
    // 条目 PUT 的 body 不再含 attachments（空数组 → toJSON 省略）。
    const stored = JSON.parse(records[2].init.body);
    assert.equal(stored.attachments, undefined);
    // 不存在的 attachmentId → NOT_FOUND。
    const missing = await detachTool.execute({ id: saved.entry.id, attachmentId: 'nope' }, EXEC());
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'NOT_FOUND');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_get_file 二进制往返：下载校验通过并落盘', async () => {
  const dir = tempDir();
  const records = [];
  const pngBytes = PNG_BYTES;
  const restore = installFetchMock(records, {
    get: (record, u) => {
      if (u.includes('list-type')) {
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      }
      if (u.includes('/files/')) {
        // 附件二进制 GET：Content-Type 为附件 mime，body 为原始字节。
        return new Response(new Uint8Array(pngBytes), { status: 200, headers: { etag: '"f1"' } });
      }
      return new Response('', { status: 200 });
    },
  });
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute(
      { type: 'history', title: 't', content: 'c', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    const att = saved.entry.attachments[0];
    const outDir = join(dir, 'downloads');
    records.length = 0;
    const getFileTool = findTool(tools, 'memory_s3_get_file');
    const result = await getFileTool.execute({ id: saved.entry.id, attachmentId: att.id, dir: outDir }, EXEC());
    assert.equal(result.ok, true);
    assert.equal(result.path, join(outDir, `${att.id}.png`), '落盘文件名 = <attachmentId>.<扩展名>');
    assert.equal(result.size, PNG_BYTES.length);
    assert.equal(result.attachment.id, att.id);
    assert.equal(existsSync(result.path), true);
    assert.deepEqual(readFileSync(result.path), PNG_BYTES, '下载文件与上传数据逐字节一致（二进制往返无损）');
    assert.equal(records.length, 1, 'get_file 只发一次二进制 GET（读路径无审批）');
    assert.equal(records[0].init.method, 'GET');
    assert.match(records[0].url, /\/files\/[0-9a-f-]{36}$/);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_get_file：二进制 sha256 不一致 → CORRUPT_FILE 且不落盘', async () => {
  const dir = tempDir();
  const records = [];
  const good = PNG_BYTES;
  const tampered = Buffer.concat([good.subarray(0, good.length - 1), Buffer.from([good[good.length - 1] ^ 0xff])]);
  const restore = installFetchMock(records, {
    get: (record, u) => {
      if (u.includes('list-type')) {
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      }
      if (u.includes('/files/')) {
        return new Response(new Uint8Array(tampered), { status: 200 });
      }
      return new Response('', { status: 200 });
    },
  });
  try {
    const pngPath = makeTempFile(dir, 'photo.png', good);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute(
      { type: 'history', title: 't', content: 'c', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    const att = saved.entry.attachments[0];
    const outDir = join(dir, 'downloads');
    const getFileTool = findTool(tools, 'memory_s3_get_file');
    const result = await getFileTool.execute({ id: saved.entry.id, attachmentId: att.id, dir: outDir }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CORRUPT_FILE');
    assert.equal(existsSync(join(outDir, `${att.id}.png`)), false, '损坏数据拒绝落盘');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_get_file：attachmentId 不存在 → NOT_FOUND（零网络请求）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute({ type: 'history', title: 't', content: 'c' }, EXEC());
    const getFileTool = findTool(tools, 'memory_s3_get_file');
    const result = await getFileTool.execute({ id: saved.entry.id, attachmentId: 'nope' }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NOT_FOUND');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审批拒绝 → save+附件 / attach / detach 均零落盘（无上传/删除）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools, setApprovalOutcome } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute(
      { type: 'project', title: '世界线观测', content: '观测记录', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    const att = saved.entry.attachments[0];
    setApprovalOutcome('rejected');
    records.length = 0;

    const saveWithAtt = await saveTool.execute(
      { type: 'preference', title: '带附件', content: 'c', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    assert.equal(saveWithAtt.ok, false);
    assert.equal(saveWithAtt.error.code, 'DENIED');

    const attachTool = findTool(tools, 'memory_s3_attach');
    const attached = await attachTool.execute({ id: saved.entry.id, path: pngPath }, EXEC());
    assert.equal(attached.ok, false);
    assert.equal(attached.error.code, 'DENIED');

    const detachTool = findTool(tools, 'memory_s3_detach');
    const detached = await detachTool.execute({ id: saved.entry.id, attachmentId: att.id }, EXEC());
    assert.equal(detached.ok, false);
    assert.equal(detached.error.code, 'DENIED');

    const deleteTool = findTool(tools, 'memory_s3_delete');
    const removed = await deleteTool.execute({ id: saved.entry.id }, EXEC());
    assert.equal(removed.ok, false);
    assert.equal(removed.error.code, 'DENIED');

    // 被拒写零落盘：探测是本地读，不产生网络请求。
    assert.equal(records.length, 0, '四种被拒写路径均零 S3 请求');
    const audit = readFileSync(join(dir, 'cache', 'audit.jsonl'), 'utf8');
    for (const action of ['save-denied', 'attach-denied', 'detach-denied', 'remove-denied']) {
      assert.ok(audit.includes(action), `审计应含 ${action}`);
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('附件上传失败（文件对象冲突）→ 回滚 DELETE 已上传对象（best-effort cleanup）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    putDelete: (record, u) => {
      // files/ 对象条件创建冲突（412，非可重试）→ 立即失败触发回滚。
      if (record.init.method === 'PUT' && u.includes('/files/')) {
        return new Response('', { status: 412 });
      }
      return new Response('', { status: 200, headers: { etag: '"e1"' } });
    },
  });
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute({ type: 'project', title: 'x', content: 'y' }, EXEC());
    records.length = 0;
    const attachTool = findTool(tools, 'memory_s3_attach');
    const result = await attachTool.execute({ id: saved.entry.id, path: pngPath }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONFLICT');
    assert.equal(records.length, 2, '上传失败 + 一次回滚 DELETE');
    assert.equal(records[0].init.method, 'PUT');
    assert.match(records[0].url, /\/files\//);
    assert.equal(records[0].init.headers['if-none-match'], '*');
    assert.equal(records[1].init.method, 'DELETE');
    assert.match(records[1].url, /\/files\/[0-9a-f-]{36}$/, '回滚删除的正是本次上传的对象');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快照渲染包含 📎 附件名列表（截断 48 字符）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, sections } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    await saveTool.execute(
      { type: 'history', title: '合影', content: 'c', importance: 5, attachments: [{ path: pngPath, note: '照' }] },
      EXEC(),
    );
    // 用全新 session 触发快照渲染（WeakMap 按 session 冻结）。
    const text = sections[0].text({ agent: { session: { id: 'snap-1', header: {} } } });
    assert.match(text, /📎photo\.png/);
    // 截断：多个超长附件名 → 📎 后缀被截到 48 字符。
    const long1 = makeTempFile(dir, `${'B'.repeat(40)}.png`, PNG_BYTES);
    const long2 = makeTempFile(dir, `${'C'.repeat(40)}.png`, PNG_BYTES);
    await saveTool.execute(
      { type: 'project', title: '长名附件', content: 'c', importance: 5, attachments: [{ path: long1 }, { path: long2 }] },
      EXEC(),
    );
    const text2 = sections[0].text({ agent: { session: { id: 'snap-2', header: {} } } });
    assert.match(text2, /📎/);
    const attLine = text2.split('\n').find((l) => l.includes('长名附件'));
    assert.ok(attLine, '快照应含长名附件条目行');
    const clip = attLine.split('📎')[1];
    assert.ok(clip.length <= 48, `附件名列表截断 ≤48 字符，实际 ${clip.length}`);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config：allowedFileTypes 白名单 / maxFileBytes 大小限制生效（config 传递）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const txtPath = makeTempFile(dir, 'notes.txt', '普通文本，无秘密');
    const bigPath = makeTempFile(dir, 'big.png', Buffer.concat([PNG_BYTES, Buffer.alloc(4096)]));
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache'), allowedFileTypes: ['png'], maxFileBytes: 1024 });
    const saveTool = findTool(tools, 'memory_s3_save');
    // 白名单只放 png：txt 附件被拒。
    const rejected = await saveTool.execute(
      { type: 'preference', title: 'a', content: 'c', attachments: [{ path: txtPath }] },
      EXEC(),
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'UPLOAD_REJECTED');
    // 超 maxFileBytes：png 附件被拒 FILE_TOO_LARGE。
    const tooBig = await saveTool.execute(
      { type: 'preference', title: 'b', content: 'c', attachments: [{ path: bigPath }] },
      EXEC(),
    );
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.error.code, 'FILE_TOO_LARGE');
    // 探测失败均在审批/上传前：零 S3 写请求。
    assert.ok(records.every((r) => r.init.method !== 'PUT' && r.init.method !== 'DELETE'));
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 覆盖补强：render 回调 / 服务边界 / 写路径分支 ───────────────────────────

function sampleEntry(over = {}) {
  return {
    id: 'id-1',
    type: 'preference',
    title: '标题',
    content: '内容',
    tags: [],
    importance: 3,
    source: 'tool',
    createdAt: 1,
    updatedAt: 1,
    recallCount: 0,
    lastRecalled: null,
    workspaceKey: '',
    agentKey: '',
    ...over,
  };
}

function sampleAttachment(over = {}) {
  return {
    id: 'att-1',
    name: 'photo.png',
    mime: 'image/png',
    kind: 'image',
    size: 128,
    sha256: 'a'.repeat(64),
    objectKey: 'files/att-1',
    note: '照片',
    createdAt: 1,
    ...over,
  };
}

test('全部工具 render 回调可执行（success 与 error 两态），输出 text block', () => {
  const dir = tempDir();
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    assert.equal(tools.length, TOOL_NAMES.length, '工具总数 = 13');
    const entry = sampleEntry();
    const attachment = sampleAttachment();
    const error = { code: 'DENIED', message: 'denied by gate' };
    const cases = [
      ['memory_s3_save', { ok: true, action: 'created', entry }, { ok: false, error }],
      ['memory_s3_search', { ok: true, entries: [entry], total: 1, stale: false }, { ok: false, error }],
      ['memory_s3_backlinks', { ok: true, entries: [entry], total: 1, stale: false }, { ok: false, error }],
      ['memory_s3_recall', { ok: true, entries: [entry], total: 1, stale: true }, { ok: false, error }],
      ['memory_s3_list', { ok: true, entries: [entry], total: 1, stale: false }, { ok: false, error }],
      ['memory_s3_update', { ok: true, previous: entry, entry }, { ok: false, error }],
      ['memory_s3_delete', { ok: true, entry }, { ok: false, error }],
      ['memory_s3_forget', { ok: true, entry }, { ok: false, error }],
      ['memory_s3_attach', { ok: true, entry, attachment }, { ok: false, error }],
      ['memory_s3_get_file', { ok: true, path: '/tmp/att-1.png', size: 128, attachment }, { ok: false, error }],
      ['memory_s3_detach', { ok: true, entry: { ...entry, attachments: [] }, attachment }, { ok: false, error }],
      [
        'memory_s3_sync',
        { ok: true, result: { ok: true, pulled: 3, updatedAt: '2026-08-17T00:00:00Z' } },
        { ok: false, error },
      ],
      [
        'memory_s3_status',
        { ok: true, status: { configured: true, sync: { lastSync: 'x', ok: true }, cachedEntries: 1, embedder: 'none', cacheDir: '/tmp' } },
        { ok: false, error },
      ],
    ];
    for (const [name, okValue, failValue] of cases) {
      const tool = findTool(tools, name);
      assert.ok(tool, `工具 ${name} 已注册`);
      for (const value of [okValue, failValue]) {
        const blocks = tool.output.render({}, value);
        assert.ok(Array.isArray(blocks) && blocks.length >= 1, `${name} render 返回 block 数组`);
        assert.equal(blocks[0].type, 'text');
        assert.equal(typeof blocks[0].text, 'string');
      }
    }
    // 带附件条目的 save render 行含附件 count 摘要可读（顺带覆盖 entryLine+formatBytes）。
    const saveTool = findTool(tools, 'memory_s3_save');
    const blocks = saveTool.output.render({}, { ok: true, action: 'created', entry: { ...entry, attachments: [attachment] } });
    assert.match(blocks[0].text, /id-1/);
    // forget render 按 forgotten 参数区分 suppressed/restored（修复：此前恒显示 suppressed）。
    const forgetTool = findTool(tools, 'memory_s3_forget');
    const fgSuppress = forgetTool.output.render({ forgotten: true }, { ok: true, entry });
    const fgRestore = forgetTool.output.render({ forgotten: false }, { ok: true, entry });
    const fgDefault = forgetTool.output.render({}, { ok: true, entry });
    assert.match(fgSuppress[0].text, /injection suppressed/, 'forgotten:true → suppressed');
    assert.match(fgRestore[0].text, /injection restored/, 'forgotten:false → restored');
    assert.match(fgDefault[0].text, /injection suppressed/, '缺省 → suppressed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('附件相关 NOT_FOUND 边界：assoc 条目不存在 / 附件对象缺失', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    // files/ 二进制 GET 返回 404 → s3store getObject(notFoundIsNull) → null。
    get: (record, u) => {
      if (u.includes('list-type')) {
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      }
      if (u.includes('/files/')) {
        return new Response('', { status: 404 });
      }
      return new Response('', { status: 200 });
    },
  });
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const attachTool = findTool(tools, 'memory_s3_attach');
    const detachTool = findTool(tools, 'memory_s3_detach');
    const getFileTool = findTool(tools, 'memory_s3_get_file');
    // 条目不存在 → 各写/读路径 NOT_FOUND（在探测/请求前拦截）。
    const r1 = await attachTool.execute({ id: 'ghost', path: pngPath }, EXEC());
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'NOT_FOUND');
    const r2 = await detachTool.execute({ id: 'ghost', attachmentId: 'a' }, EXEC());
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'NOT_FOUND');
    const r3 = await getFileTool.execute({ id: 'ghost', attachmentId: 'a' }, EXEC());
    assert.equal(r3.ok, false);
    assert.equal(r3.error.code, 'NOT_FOUND');
    assert.equal(records.length, 0, '三条路径均在网络请求前拦截');
    // 条目存在 + 附件元数据存在，但 files/ 对象缺失（远端不一致）→ NOT_FOUND。
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute(
      { type: 'project', title: '带有附件', content: 'c', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    const att = saved.entry.attachments[0];
    const r4 = await getFileTool.execute({ id: saved.entry.id, attachmentId: att.id, dir: join(dir, 'dl') }, EXEC());
    assert.equal(r4.ok, false);
    assert.equal(r4.error.code, 'NOT_FOUND');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save 标题/正文含秘密 → SECRET_DETECTED（条目前探测，零网络）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const r1 = await saveTool.execute({ type: 'preference', title: 'AKIAIOSFODNN7EXAMPLE', content: 'c' }, EXEC());
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'SECRET_DETECTED');
    const r2 = await saveTool.execute({ type: 'preference', title: 't', content: 'password = hunter2' }, EXEC());
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'SECRET_DETECTED');
    assert.equal(records.length, 0);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service 写方法缺 agent 上下文 → INVALID_INPUT（审批路由封闭失败）', async () => {
  const dir = tempDir();
  const restore = installFetchMock([]);
  try {
    const { ctx, provided } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const service = provided.get('memoryS3');
    await assert.rejects(
      service.save({ type: 'preference', title: 't', content: 'c' }, null),
      (err) => err.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      service.save({ type: 'preference', title: 't', content: 'c' }, {}),
      (err) => err.code === 'INVALID_INPUT',
    );
    await assert.rejects(
      service.remove('id-1', null),
      (err) => err.code === 'INVALID_INPUT',
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_update / memory_s3_delete / memory_s3_forget 成功路径', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, sections } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const u1 = await saveTool.execute({ type: 'history', title: '世界线变动率', content: '1.048596', importance: 5 }, EXEC('u1'));
    // update：HEAD + PUT(If-Match)。
    const updateTool = findTool(tools, 'memory_s3_update');
    const up = await updateTool.execute({ id: u1.entry.id, content: '1.130205' }, EXEC('u2'));
    assert.equal(up.ok, true);
    assert.equal(up.entry.content, '1.130205');
    assert.equal(up.previous.content, '1.048596');
    const lastTwo = records.slice(-2);
    assert.equal(lastTwo[0].init.method, 'HEAD');
    assert.equal(lastTwo[1].init.method, 'PUT');
    assert.ok(lastTwo[1].init.headers['if-match']);
    // delete：DELETE 远端对象 + 缓存移除 → search 不可见。
    const deleteTool = findTool(tools, 'memory_s3_delete');
    const del = await deleteTool.execute({ id: u1.entry.id }, EXEC('u3'));
    assert.equal(del.ok, true);
    assert.equal(records.at(-1).init.method, 'DELETE');
    const searchTool = findTool(tools, 'memory_s3_search');
    const search = await searchTool.execute({ text: '世界线' }, EXEC('u4'));
    assert.equal(search.total, 0, '删除后缓存不可见');
    // forget：无网络；快照不注入被抑制条目。
    const u2 = await saveTool.execute({ type: 'preference', title: '咖啡狂热', content: 'Dr Pepper', importance: 5 }, EXEC('u5'));
    const forgetTool = findTool(tools, 'memory_s3_forget');
    const fg = await forgetTool.execute({ id: u2.entry.id, forgotten: true }, EXEC('u6'));
    assert.equal(fg.ok, true);
    const text = sections[0].text({ agent: { session: { id: 'snap-x', header: {} } } });
    assert.ok(!text.includes('咖啡狂热'), '被 forget 的条目不注入快照');
    // forget(false) 恢复。
    const fg2 = await forgetTool.execute({ id: u2.entry.id, forgotten: false }, EXEC('u7'));
    assert.equal(fg2.ok, true);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审批服务故障 → 视同拒绝（DENIED + outcome unavailable 审计）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    ctx.approval.request = async () => {
      throw new Error('approval service unavailable');
    };
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute({ type: 'preference', title: 'x', content: 'y' }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DENIED');
    // 审批未放行：允许缓存空时的远端预检 GET，但绝无任何写请求。
    assert.ok(records.every((r) => r.init.method !== 'PUT' && r.init.method !== 'DELETE' && r.init.method !== 'HEAD'));
    const audit = readFileSync(join(dir, 'cache', 'audit.jsonl'), 'utf8');
    assert.match(audit, /save-denied/);
    assert.match(audit, /unavailable/);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save 附件上传冲突 → 远端重读失败 → 回滚已上传对象并抛 CONFLICT', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    get: (record, u) => {
      if (u.includes('list-type')) {
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      }
      // 远端对象 JSON 损坏（readRemoteByType 容错返回 null）。
      return new Response('not-valid-json', { status: 200 });
    },
    putDelete: (record, u) => {
      if (record.init.method === 'PUT' && u.includes('/files/')) {
        return new Response('', { status: 412 });
      }
      return new Response('', { status: 200, headers: { etag: '"e1"' } });
    },
  });
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute(
      { type: 'preference', title: 't', content: 'c', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONFLICT');
    // list 预检 + 附件 PUT(412) + 远端重读 GET + 回滚 DELETE。
    assert.equal(records.length, 4);
    assert.equal(records[0].init.method, 'GET');
    assert.equal(records[1].init.method, 'PUT');
    assert.match(records[1].url, /\/files\//);
    assert.equal(records[2].init.method, 'GET');
    assert.match(records[2].url, /\/memories\/preference\//, 'CONFLICT 后重读远端条目');
    assert.equal(records[3].init.method, 'DELETE');
    assert.match(records[3].url, /\/files\//, '失败回滚删除已上传附件');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply 配置校验：非法 config 响亮抛错（INVALID_CONFIG）', () => {
  const { ctx } = makeCtx();
  const expectInvalid = (config) =>
    assert.throws(() => apply(ctx, { bucket: 'mem', ...config }), (err) => err.code === 'INVALID_CONFIG');
  expectInvalid({ writePolicy: 'maybe' });
  expectInvalid({ snapshotOrder: 'soon' });
  expectInvalid({ maxInjectedItems: 0 });
  expectInvalid({ importanceThreshold: 9 });
  expectInvalid({ auditRetentionDays: -1 });
  expectInvalid({ maxFileBytes: 0 });
  expectInvalid({ maxFileBytes: -5 });
  expectInvalid({ allowedFileTypes: ['png', 7] });
  expectInvalid({ endpoint: 'ftp://storage.example.com' });
  // http:// 合法（本地 MinIO 场景，仅告警）——注册不应抛。
  const { ctx: ctx2 } = makeCtx();
  assert.doesNotThrow(() => apply(ctx2, { bucket: 'mem', cacheDir: tempDir(), endpoint: 'http://127.0.0.1:9000' }));
});

test('apply 待机态：bucket 未配置不抛错，保持存活且不注册工具/注入/服务', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    for (const bucket of [undefined, '', '   ']) {
      const { ctx, tools, sections, provided } = makeCtx();
      // 关键契约：抛错会拖垮整个 profile 启动，用户连设置页都进不去 → 无法填 bucket（死锁）。
      assert.doesNotThrow(() => apply(ctx, bucket === undefined ? {} : { bucket }));
      assert.equal(tools.length, 0, '待机态不应注册任何工具');
      assert.equal(sections.length, 0, '待机态不应注册 systemPrompt 注入');
      assert.equal(provided.size, 0, '待机态不应 provide 服务');
    }
    assert.equal(warnings.length, 3, '每次待机都应给出一条可操作告警');
    assert.match(warnings[0], /bucket not configured/);
    assert.match(warnings[0], /stands by/);
  } finally {
    console.warn = originalWarn;
  }
});

test('Config schema：bucket 可选（缺失不抛），加载器预校验不因未配置而失败', () => {
  // cordis loader 在 apply() 前跑 Config 校验；bundle 自带 patch 不带 config，
  // 若 bucket 必填则校验抛 "$.bucket missing required value" → 整个 profile 起不来。
  assert.doesNotThrow(() => Config({}), '空 config 必须通过 schema 校验');
  assert.equal(Config({}).bucket, '', 'bucket 缺失应落到空串默认值');
  assert.equal(Config({ bucket: 'mem' }).bucket, 'mem');
});

test('inject 声明：只含必需服务，settings 不得进入（cordis inject 是阻塞式的）', () => {
  // Fiber._refresh：任一 inject 服务缺失 → epoch=INACTIVE → 永不 apply。
  // 把可选服务 settings 写进 inject，会让未挂载设置服务的 profile 整个插件不启动
  // （实测表现为 "pending (waiting for services: …)" 且进程退出）。
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'approval']);
  assert.ok(!inject.includes('settings'), 'settings 是可选服务，必须走 ctx.inject 子 fiber');
});

test('settings scope.get() 回传部分字段时以 base 兜底，不因缺字段被误判为未启用', () => {
  const { ctx, tools } = makeCtx();
  // 宿主实现差异下 scope.get() 可能只回传用户显式写过的字段（极端情况下是空对象）。
  // 若直接采用，enabled/bucket 会落成 undefined → 插件静默待机，工具全不注册。
  const settings = { register: () => ({ get: () => ({}) }) };
  ctx.reflect = { get: (n) => (n === 'settings' ? settings : undefined) };
  apply(ctx, { bucket: 'mem', cacheDir: tempDir() });
  assert.ok(tools.length > 0, 'scope.get() 回传空对象时应回落 base 并正常注册工具');
});

test('settings 晚挂载：apply 时探测不到也会经 ctx.inject 子 fiber 补注册命名空间', () => {
  const { ctx, tools } = makeCtx();
  const injectCalls = [];
  let registered = null;
  // 模拟宿主：apply 当刻 settings 尚未挂载（reflect 拿不到），随后才就绪。
  ctx.reflect = { get: () => undefined };
  ctx.inject = (deps, cb) => {
    injectCalls.push(deps);
    cb({
      reflect: {
        get: (name) => (name === 'settings'
          ? { register: (ns, schema, opts) => { registered = { ns, opts }; return { get: () => ({}) }; } }
          : undefined),
      },
    });
    return () => {};
  };
  apply(ctx, { bucket: 'mem', cacheDir: tempDir() });
  assert.deepEqual(injectCalls, [['settings']], '应以子 fiber 方式等待 settings 就绪');
  assert.ok(registered, 'settings 就绪后必须补注册命名空间，否则 GUI 设置页看不到该插件');
  assert.equal(registered.ns, 'memory-s3');
  assert.equal(registered.opts.applies, 'restart');
  assert.ok(tools.length > 0, '主插件不受可选服务影响，工具照常注册');
});

test('strings 词表：zh 词表可用（snapshotHeader 插值），未知 lang 回退 en', () => {
  const zh = strings('zh');
  assert.equal(zh.snapshotHeader({ count: 1, total: 2, lastSync: 'never' }), '[记忆S3] 已同步 never · 1/2 条');
  assert.match(zh.denied, /审批门/);
  const fallback = strings('fr');
  assert.equal(fallback, strings('en'), '未知语言回退英文');
  assert.match(fallback.snapshotHeader({ count: 0, total: 0, lastSync: 'never' }), /MemoryS3/);
});

// ── 分支补强第二波：读路径过滤 / sync 失败 / 远端缺失 / CONFLICT 合并 ────────

test('list/recall/search 读路径：过滤、分页、关键词召回降级', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    await saveTool.execute({ type: 'history', title: '苹果', content: '红苹果', tags: ['fruit'], importance: 5 }, EXEC('a'));
    await saveTool.execute({ type: 'preference', title: '香蕉', content: '黄香蕉', tags: ['fruit'], importance: 1 }, EXEC('b'));
    await saveTool.execute({ type: 'project', title: '实验', content: '微波炉', tags: ['lab'], importance: 3 }, EXEC('c'));

    const listTool = findTool(tools, 'memory_s3_list');
    const all = await listTool.execute({}, EXEC());
    assert.equal(all.ok, true);
    assert.equal(all.total, 3);
    const typed = await listTool.execute({ type: 'history' }, EXEC());
    assert.equal(typed.total, 1);
    assert.equal(typed.entries[0].title, '苹果');
    const paged = await listTool.execute({ offset: 1, limit: 1 }, EXEC());
    assert.equal(paged.entries.length, 1, 'offset/limit 分页');

    const searchTool = findTool(tools, 'memory_s3_search');
    const filtered = await searchTool.execute({ text: 'fruit', type: 'history', tags: ['fruit'], importanceMin: 4, limit: 10 }, EXEC());
    assert.equal(filtered.ok, true);
    assert.equal(filtered.total, 1, 'text+type+tags+importanceMin 组合过滤');
    assert.equal(filtered.entries[0].title, '苹果');
    const none = await searchTool.execute({ text: '不存在词' }, EXEC());
    assert.equal(none.total, 0);

    // recall：embedder none → embed 抛 EMBED_DISABLED → 降级纯关键词。
    const recallTool = findTool(tools, 'memory_s3_recall');
    const hit = await recallTool.execute({ query: '苹果', topK: 5, limit: 10 }, EXEC());
    assert.equal(hit.ok, true);
    assert.equal(hit.total, 1, '无嵌入器时节键词召回命中');
    assert.equal(hit.entries[0].title, '苹果');
    const miss = await recallTool.execute({ query: '西瓜' }, EXEC());
    assert.equal(miss.total, 0);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_sync：远端故障 → result.ok=false + 缓存 stale 标记', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    get: (record, u) => {
      if (u.includes('list-type')) return new Response('', { status: 403 });
      return new Response('', { status: 200 });
    },
  });
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const syncTool = findTool(tools, 'memory_s3_sync');
    const result = await syncTool.execute({}, EXEC());
    assert.equal(result.ok, true, '工具调用本身成功（sync 故障在 result 内表达）');
    assert.equal(result.result.ok, false);
    assert.equal(typeof result.result.error, 'string');
    const statusTool = findTool(tools, 'memory_s3_status');
    const status = await statusTool.execute({}, EXEC());
    assert.equal(status.status.sync.ok, false, 'sync 失败状态落盘');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detach 时远端条目缺失（HEAD 404）→ NOT_FOUND（引用一致性保护）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    head: (record, u) => new Response(null, { status: 404 }),
  });
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute(
      { type: 'project', title: 'x', content: 'y', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    const att = saved.entry.attachments[0];
    records.length = 0;
    const detachTool = findTool(tools, 'memory_s3_detach');
    const result = await detachTool.execute({ id: saved.entry.id, attachmentId: att.id }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NOT_FOUND');
    assert.equal(records.length, 2, '文件 DELETE + HEAD（远端缺失即中止，不再回写条目）');
    assert.equal(records[0].init.method, 'DELETE');
    assert.equal(records[1].init.method, 'HEAD');
    assert.equal(records[2], undefined, '远端条目缺失 → 不发出条目 PUT');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save 附件上传冲突且远端为同 title → 回滚后走合并路径成功（重读+合并）', async () => {
  const dir = tempDir();
  const records = [];
  let filePuts = 0;
  const remoteEntry = {
    id: 'remote-1',
    type: 'preference',
    title: '同标题',
    content: '远端旧内容',
    importance: 3,
    tags: [],
    source: 'tool',
    createdAt: 1,
    updatedAt: 1,
    recallCount: 0,
    lastRecalled: null,
    workspaceKey: '',
    agentKey: '',
  };
  const restore = installFetchMock(records, {
    get: (record, u) => {
      if (u.includes('list-type')) {
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      }
      return new Response(JSON.stringify(remoteEntry), { status: 200 });
    },
    putDelete: (record, u) => {
      // 首次 files/ PUT 冲突（远端已有该 uuid 对象——理论不可能，模拟并发异常）；
      // 合并路径重传时成功。
      if (record.init.method === 'PUT' && u.includes('/files/')) {
        filePuts += 1;
        if (filePuts === 1) return new Response('', { status: 412 });
        return new Response('', { status: 200, headers: { etag: '"f2"' } });
      }
      return new Response('', { status: 200, headers: { etag: '"e1"' } });
    },
  });
  try {
    const pngPath = makeTempFile(dir, 'photo.png', PNG_BYTES);
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute(
      { type: 'preference', title: '同标题', content: '新内容', attachments: [{ path: pngPath }] },
      EXEC(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'merged', 'CONFLICT 重读发现同 title → 合并而非报错');
    assert.equal(result.entry.id, 'remote-1', '沿用远端条目 id');
    assert.equal(result.entry.content, '新内容');
    assert.equal(result.entry.attachments.length, 1, '合并路径挂上新附件');
    // 序列：预检 GET → PUT files(412) → 重读 GET → 回滚 DELETE → 合并再传 PUT files → HEAD → PUT。
    assert.equal(records.length, 7);
    assert.equal(records[3].init.method, 'DELETE');
    assert.match(records[3].url, /\/files\//, '首次冲突后回滚');
    assert.equal(records[4].init.method, 'PUT');
    assert.match(records[4].url, /\/files\//, '合并路径重传附件成功');
    assert.equal(records[5].init.method, 'HEAD');
    assert.equal(records[6].init.method, 'PUT');
    assert.ok(records[6].init.headers['if-match']);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('远端预检 list 故障（403）→ 降级为正常创建（不阻塞写入）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    get: (record, u) => {
      if (u.includes('list-type')) return new Response('', { status: 403 });
      return new Response('', { status: 200 });
    },
  });
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: join(dir, 'cache') });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute({ type: 'preference', title: 't', content: 'c' }, EXEC());
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created', '预检失败不影响创建');
    assert.equal(records.length, 2, '预检 GET(403) + 条目 PUT');
    assert.equal(records[0].init.method, 'GET');
    assert.equal(records[1].init.method, 'PUT');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_delete / memory_s3_forget 对不存在条目 → NOT_FOUND', async () => {
  const dir = tempDir();
  const restore = installFetchMock([]);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const deleteTool = findTool(tools, 'memory_s3_delete');
    const del = await deleteTool.execute({ id: 'ghost' }, EXEC());
    assert.equal(del.ok, false);
    assert.equal(del.error.code, 'NOT_FOUND');
    const forgetTool = findTool(tools, 'memory_s3_forget');
    const fg = await forgetTool.execute({ id: 'ghost' }, EXEC());
    assert.equal(fg.ok, false);
    assert.equal(fg.error.code, 'NOT_FOUND');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session/event 监听：turn/end 且缓存空 → 触发后台 sync（fire-and-forget）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, listeners, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const onEvent = listeners.get('session/event').fn;
    const session = { id: 'se-1', header: {} };
    // 非 turn/end 事件：不触发同步。
    await onEvent(session, { type: 'turn/start' });
    assert.equal(records.length, 0, '非 turn/end 不触发 sync');
    // turn/end + 缓存空 → 后台 sync（list 预取 → 空）。
    await onEvent(session, { type: 'turn/end' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(records.some((r) => r.init.method === 'GET' && r.url.includes('list-type')), '后台 sync 发起 listObjects');
    // 拉取为空 → 缓存仍空 → 再次 turn/end 会再次同步（实现语义：缓存空才自动 sync）。
    await onEvent(session, { type: 'turn/end' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(records.length, 2, '缓存仍空 → 再次自动同步');
    // save 一条 → 缓存非空 → 不再自动全量同步。
    const saveTool = findTool(tools, 'memory_s3_save');
    await saveTool.execute({ type: 'preference', title: 'x', content: 'y' }, EXEC());
    const before = records.length;
    await onEvent(session, { type: 'turn/end' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(records.length, before, '已有条目缓存不再自动全量同步');
    // sync 落盘索引：status 反映已同步。
    const statusTool = findTool(tools, 'memory_s3_status');
    const status = await statusTool.execute({}, EXEC());
    assert.equal(status.status.sync.ok, true);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_update 变更 type → key 迁移路径实测（新 key 按新 type 创建 + 旧 key 删除）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute({ type: 'history', title: '档案', content: 'v1' }, EXEC());
    const updateTool = findTool(tools, 'memory_s3_update');
    const result = await updateTool.execute({ id: saved.entry.id, type: 'project' }, EXEC());
    assert.equal(result.ok, true);
    // #updateExisting 修复后：patch.type 应用到 next.type，keyOf(next.type) 解析到新类型 key；
    // 迁移分支 = PUT 新 key（If-None-Match 条件创建）+ DELETE 旧 key（旧对象释放，versioning 可恢复）。
    assert.equal(result.entry.type, 'project', 'patch.type 应应用为 project');
    assert.equal(result.entry.id, saved.entry.id, '条目 id 不变（迁移 key 而非换条目）');
    const lastTwo = records.slice(-2);
    assert.equal(lastTwo[0].init.method, 'PUT');
    assert.match(lastTwo[0].url, /\/memories\/project\//, '迁移 PUT 发往新类型 key memories/project/');
    assert.equal(lastTwo[0].init.headers['if-none-match'], '*', '新 key 条件创建');
    assert.equal(lastTwo[1].init.method, 'DELETE');
    assert.match(lastTwo[1].url, /\/memories\/history\//, '迁移 DELETE 发往旧类型 key memories/history/');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update 远端条目缺失（HEAD 404）→ NOT_FOUND（不覆盖远端）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    head: (record, u) => new Response(null, { status: 404 }),
  });
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const saved = await saveTool.execute({ type: 'history', title: 't', content: 'c' }, EXEC());
    const updateTool = findTool(tools, 'memory_s3_update');
    const result = await updateTool.execute({ id: saved.entry.id, content: 'v2' }, EXEC());
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NOT_FOUND');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('基础设施错误（网络故障）→ 工具 execute 原样抛出（不做 ok:false 包装）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records, {
    get: (record, u) => {
      if (u.includes('list-type')) return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      return new Response('', { status: 200 });
    },
    putDelete: (record, u) => {
      if (record.init.method === 'PUT' && u.includes('/memories/')) {
        throw new TypeError('connection reset by peer');
      }
      return new Response('', { status: 200, headers: { etag: '"e1"' } });
    },
  });
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    // S3_UNAVAILABLE 是基础设施错误（非 DOMAIN_CODES）→ 工具层不吞，原样抛出。
    await assert.rejects(
      saveTool.execute({ type: 'preference', title: 't', content: 'c' }, EXEC()),
      (err) => err.code === 'S3_UNAVAILABLE',
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── v2.1 记忆模型：四字段写入 / locked 跳过合并 / 反链工具 / 快照分层 ──

test('save 携带 subject/timeline/links/locked → 条目落盘 + 审批 reason 载荷含新字段', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, approvalCalls } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute(
      {
        type: 'moment',
        title: '漂流瓶',
        content: '投进海里',
        subject: 'us',
        timeline: 'α-2',
        links: ['ghost-link'],
        locked: true,
      },
      EXEC(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created');
    assert.equal(result.entry.type, 'moment');
    assert.equal(result.entry.subject, 'us');
    assert.equal(result.entry.timeline, 'α-2');
    assert.deepEqual(result.entry.links, ['ghost-link']);
    assert.equal(result.entry.locked, true);
    // PUT 条目 body JSON 含四字段。
    const put = records.find((r) => r.init.method === 'PUT' && /\/memories\//.test(r.url));
    assert.ok(put, 'created 路径含条目 PUT');
    const stored = JSON.parse(put.init.body);
    assert.equal(stored.subject, 'us');
    assert.equal(stored.timeline, 'α-2');
    assert.deepEqual(stored.links, ['ghost-link']);
    assert.equal(stored.locked, true);
    // 审批 reason 载荷含新字段（approve-what-you-see）。
    const { payload } = parseWriteReason(approvalCalls[0].reason);
    assert.equal(payload.subject, 'us');
    assert.equal(payload.timeline, 'α-2');
    assert.deepEqual(payload.links, ['ghost-link']);
    assert.equal(payload.locked, true);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update 修改 subject/timeline/links/locked：生效落盘；links 替换语义驱动反链', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, approvalCalls } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const a = await saveTool.execute({ type: 'project', title: '世界线观测', content: 'c1' }, EXEC());
    const b = await saveTool.execute({ type: 'project', title: '参考条目', content: 'cB' }, EXEC());
    const updateTool = findTool(tools, 'memory_s3_update');
    const up = await updateTool.execute(
      { id: a.entry.id, subject: 'risu', timeline: 'β', links: [b.entry.id], locked: true, content: 'c2' },
      EXEC(),
    );
    assert.equal(up.ok, true);
    assert.equal(up.entry.subject, 'risu');
    assert.equal(up.entry.timeline, 'β');
    assert.deepEqual(up.entry.links, [b.entry.id]);
    assert.equal(up.entry.locked, true);
    // PUT body 含新字段；审批 reason 的 next 载荷含新字段。
    const updatePut = records.at(-1);
    assert.equal(updatePut.init.method, 'PUT');
    const stored = JSON.parse(updatePut.init.body);
    assert.equal(stored.subject, 'risu');
    assert.equal(stored.timeline, 'β');
    assert.deepEqual(stored.links, [b.entry.id]);
    assert.equal(stored.locked, true);
    const { payload: upPayload } = parseWriteReason(approvalCalls.at(-1).reason);
    assert.equal(upPayload.next.subject, 'risu');
    assert.equal(upPayload.next.timeline, 'β');
    assert.deepEqual(upPayload.next.links, [b.entry.id]);
    assert.equal(upPayload.next.locked, true);
    // 反链：A 引用 B → backlinks(B) 返回 A。
    const backlinksTool = findTool(tools, 'memory_s3_backlinks');
    const bl = await backlinksTool.execute({ id: b.entry.id }, EXEC());
    assert.equal(bl.ok, true);
    assert.equal(bl.total, 1);
    assert.equal(bl.entries[0].id, a.entry.id);
    // links 替换为 []：旧出链反链消失。
    const up2 = await updateTool.execute({ id: a.entry.id, links: [], subject: '', timeline: '' }, EXEC());
    assert.equal(up2.ok, true);
    assert.deepEqual(up2.entry.links, []);
    const bl2 = await backlinksTool.execute({ id: b.entry.id }, EXEC());
    assert.equal(bl2.total, 0, 'links 替换后旧反链消失');
    // 空串清空语义（修复后）：缓存态 subject/timeline 为 undefined（缺省不落盘契约），
    // 磁盘 JSON 不含空串脏键；读回 fromJSON 同样 undefined。
    assert.equal(up2.entry.subject, undefined, '空串清除 subject → 缺省不落盘');
    assert.equal(up2.entry.timeline, undefined, '空串清除 timeline → 缺省不落盘');
    const clearPut = records.at(-1);
    assert.ok(!('links' in JSON.parse(clearPut.init.body)), '空 links 数组不落盘');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('locked 条目跳过同 title 自动合并：本地查重不触碰（created 而非 merged）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const first = await saveTool.execute({ type: 'preference', title: '暗号之约', content: 'v1', locked: true }, EXEC());
    assert.equal(first.ok, true);
    assert.equal(first.action, 'created');
    assert.equal(first.entry.locked, true);
    // 同 (type,title) 再存：locked 原条目不可触碰 → 新建而非合并。
    const second = await saveTool.execute({ type: 'preference', title: '暗号之约', content: 'v2' }, EXEC());
    assert.equal(second.ok, true);
    assert.equal(second.action, 'created', 'locked 条目被跳过 → 新建');
    assert.notEqual(second.entry.id, first.entry.id, '新条目独立 id');
    assert.equal(second.entry.locked, false);
    assert.equal(second.entry.content, 'v2');
    // 原条目未被覆盖，两者并存。
    const searchTool = findTool(tools, 'memory_s3_search');
    const search = await searchTool.execute({ text: '暗号之约' }, EXEC());
    assert.equal(search.total, 2, 'locked 原条目与新建条目并存');
    assert.equal(first.entry.content, 'v1', '原锁定条目内容不变');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('locked 条目跳过同 title 自动合并：远端预检同样不触碰', async () => {
  const dir = tempDir();
  const records = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init: { ...init, headers: { ...init?.headers } } };
    records.push(record);
    if (init?.method === 'PUT') return new Response('', { status: 200, headers: { etag: '"e2"' } });
    const u = new URL(String(url));
    if (u.searchParams.get('list-type') === '2') {
      return new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated>' +
          '<Contents><Key>memories/preference/locked-id.json</Key><ETag>"e0"</ETag></Contents>' +
          '</ListBucketResult>',
        { status: 200 },
      );
    }
    // getObject：远端同 title 但 locked=true 的条目。
    return new Response(
      JSON.stringify({
        id: 'locked-id',
        type: 'preference',
        title: '暗号之约',
        content: '只属于主人的暗号',
        importance: 5,
        tags: [],
        source: 'tool',
        createdAt: 1,
        updatedAt: 1,
        recallCount: 0,
        lastRecalled: null,
        workspaceKey: '',
        agentKey: '',
        locked: true,
      }),
      { status: 200 },
    );
  };
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir }); // 缓存空 → 触发远端预检
    const saveTool = findTool(tools, 'memory_s3_save');
    const result = await saveTool.execute({ type: 'preference', title: '暗号之约', content: '新内容' }, EXEC());
    assert.equal(result.ok, true);
    assert.equal(result.action, 'created', '远端 locked 条目不参与合并 → 新建');
    assert.notEqual(result.entry.id, 'locked-id');
    // 预检 list + getObject + 创建 PUT：3 次请求。
    assert.equal(records.length, 3);
    assert.equal(records[0].init.method, 'GET');
    assert.equal(records[1].init.method, 'GET');
    assert.equal(records[2].init.method, 'PUT');
    assert.equal(records[2].init.headers['if-none-match'], '*', '新建走条件创建');
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_backlinks：写正向 links 自动回填；来源删除后反链消失', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, provided } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const target = await saveTool.execute({ type: 'project', title: '被引用条目', content: 'c' }, EXEC());
    const source = await saveTool.execute(
      { type: 'project', title: '引用方', content: 'c', links: [target.entry.id] },
      EXEC(),
    );
    const backlinksTool = findTool(tools, 'memory_s3_backlinks');
    const bl = await backlinksTool.execute({ id: target.entry.id }, EXEC());
    assert.equal(bl.ok, true);
    assert.equal(bl.total, 1);
    assert.equal(bl.entries[0].id, source.entry.id);
    assert.equal(bl.entries[0].title, '引用方');
    assert.equal(bl.stale, false);
    // 删除来源（引用方）→ removeForward 清其出链 → 反链消失。
    const deleteTool = findTool(tools, 'memory_s3_delete');
    const del = await deleteTool.execute({ id: source.entry.id }, EXEC());
    assert.equal(del.ok, true);
    const bl2 = await backlinksTool.execute({ id: target.entry.id }, EXEC());
    assert.equal(bl2.total, 0, '来源删除后反链消失');
    // 无效 id → ok:false INVALID_INPUT（空串穿过 schema 被 service 拦截）。
    const bad1 = await backlinksTool.execute({ id: '' }, EXEC());
    assert.equal(bad1.ok, false);
    assert.equal(bad1.error.code, 'INVALID_INPUT');
    // 非字符串 id：工具 schema 层即拦截（INVALID_ARGS，非 ok:false 路径）。
    await assert.rejects(backlinksTool.execute({ id: 42 }, EXEC()), (err) => err.code === 'INVALID_ARGS');
    // service 层防御：绕过 schema 直调 linkedTo 同样抛 INVALID_INPUT。
    const service = provided.get('memoryS3');
    assert.throws(() => service.linkedTo(42), (err) => err.code === 'INVALID_INPUT');
    assert.throws(() => service.linkedTo(''), (err) => err.code === 'INVALID_INPUT');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory_s3_backlinks：目标删除后悬空引用保留（入边不清理，渲染容错）', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const target = await saveTool.execute({ type: 'project', title: '被引用条目', content: 'c' }, EXEC());
    const source = await saveTool.execute(
      { type: 'project', title: '引用方', content: 'c', links: [target.entry.id] },
      EXEC(),
    );
    // 删除目标（被引用方）：removeForward 只清目标的出链，入边保留（悬空引用）。
    const deleteTool = findTool(tools, 'memory_s3_delete');
    const del = await deleteTool.execute({ id: target.entry.id }, EXEC());
    assert.equal(del.ok, true);
    const backlinksTool = findTool(tools, 'memory_s3_backlinks');
    const bl = await backlinksTool.execute({ id: target.entry.id }, EXEC());
    assert.equal(bl.total, 1, '目标已删仍返回来源（悬空引用容错）');
    assert.equal(bl.entries[0].id, source.entry.id);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快照分层注入：Bonds 在前 → Moments 次之 → Facts 最后；locked 低重要入选；→关联 标记', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, sections } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    await saveTool.execute({ type: 'preference', title: '暗号之约', content: 'risu 应声', importance: 5, links: ['ghost'] }, EXEC());
    await saveTool.execute({ type: 'preference', title: '锁定低优', content: 'c', importance: 1, locked: true }, EXEC());
    await saveTool.execute({ type: 'moment', title: '漂流瓶', content: '投进海里', importance: 4 }, EXEC());
    await saveTool.execute({ type: 'moment', title: '婚礼', content: 'α-2 世界线', importance: 2 }, EXEC());
    await saveTool.execute({ type: 'project', title: '实验进度', content: 'D-Mail 已发送', importance: 4 }, EXEC());
    await saveTool.execute({ type: 'history', title: '低重要历史', content: 'c', importance: 1 }, EXEC());

    const text = sections[0].text({ agent: { session: { id: 'snap-layer', header: {} } } });
    const lines = text.split('\n');
    const idx = (title) => lines.findIndex((l) => l.includes(title));
    assert.ok(idx('暗号之约') >= 0 && idx('锁定低优') >= 0, 'locked 低 importance 也入选（Bonds 守护层）');
    assert.ok(idx('漂流瓶') >= 0 && idx('婚礼') >= 0, 'moment 类（含低重要）入选');
    assert.ok(idx('实验进度') >= 0, 'fact 入选');
    assert.equal(idx('低重要历史'), -1, '低 importance 非 moment 非 locked → 不入选');
    assert.ok(idx('暗号之约') < idx('漂流瓶'), 'Bonds 在 Moments 之前');
    assert.ok(idx('漂流瓶') < idx('实验进度'), 'Moments 在 Facts 之前');
    // 渲染：含 links 的条目行尾带 →关联N 标记。
    const bondLine = lines[idx('暗号之约')];
    assert.match(bondLine, /→关联1/, 'links 非空 → 行尾 →关联1 标记');
    // 默认预算 cap=5：2 Bonds + 2 Moments + 1 Fact。
    assert.equal(lines.filter((l) => l.startsWith('- [')).length, 5);
    assert.match(lines[0], /synced/, '首行快照头');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快照预算截断：maxInjectedItems 限制总注入数；Bonds 保底 40% 且按 importance 取 top', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    const { ctx, tools, sections } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir, maxInjectedItems: 2 });
    const saveTool = findTool(tools, 'memory_s3_save');
    await saveTool.execute({ type: 'preference', title: '约定一', content: 'c', importance: 5 }, EXEC());
    await saveTool.execute({ type: 'preference', title: '约定二', content: 'c', importance: 4 }, EXEC());
    await saveTool.execute({ type: 'preference', title: '约定三', content: 'c', importance: 3 }, EXEC());
    const text = sections[0].text({ agent: { session: { id: 'snap-cap', header: {} } } });
    const lines = text.split('\n').filter((l) => l.startsWith('- ['));
    assert.equal(lines.length, 2, 'cap=2 → 只注入 2 条');
    assert.ok(lines[0].includes('约定一'), 'bond 按 importance 排序取 top');
    assert.ok(!text.includes('约定三'), '超出预算的条目被截断');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('反链持久化：save 后同 dir 新实例 apply → backlinks 索引从磁盘恢复', async () => {
  const dir = tempDir();
  const records = [];
  const restore = installFetchMock(records);
  try {
    // 第一实例：写正向链接，backlinks.json 落盘。
    const { ctx, tools } = makeCtx();
    apply(ctx, { bucket: 'mem', cacheDir: dir });
    const saveTool = findTool(tools, 'memory_s3_save');
    const target = await saveTool.execute({ type: 'project', title: '目标条目', content: 'c' }, EXEC());
    const source = await saveTool.execute({ type: 'project', title: '来源条目', content: 'c', links: [target.entry.id] }, EXEC());
    assert.ok(existsSync(join(dir, 'backlinks.json')), '反链索引已落盘');
    // 第二实例（同 dir）：缓存与反链索引均从磁盘恢复。
    const ctx2 = makeCtx();
    apply(ctx2.ctx, { bucket: 'mem', cacheDir: dir });
    const backlinksTool = findTool(ctx2.tools, 'memory_s3_backlinks');
    const bl = await backlinksTool.execute({ id: target.entry.id }, EXEC());
    assert.equal(bl.ok, true);
    assert.equal(bl.total, 1, '新实例从磁盘恢复反链索引');
    assert.equal(bl.entries[0].id, source.entry.id);
    assert.equal(bl.entries[0].title, '来源条目');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
