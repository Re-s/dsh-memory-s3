// test/index.test.mjs — 插件入口集成测试（mock ctx + mock fetch，不真实连网）。
//
// 覆盖：enabled:false 整体消失、九工具与服务注册、systemPrompt 同步快照提供者
// （WeakMap 冻结）、approval answerer 三态裁决（auto/off/ask）、save 写路径
// （审批 → If-None-Match PUT）、审批拒绝 → DENIED + *-denied 审计行、读路径缓存、
// 工具领域错误 → {ok:false, error}。依赖 @deepseek-ai/*（npm install 后可用）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../index.mjs';

const TOOL_NAMES = [
  'memory_s3_save',
  'memory_s3_search',
  'memory_s3_recall',
  'memory_s3_list',
  'memory_s3_update',
  'memory_s3_delete',
  'memory_s3_forget',
  'memory_s3_sync',
  'memory_s3_status',
];

/** 构造 mock ctx：记录注册面，approval 结果可编程。 */
function makeCtx() {
  const tools = [];
  const sections = [];
  const listeners = new Map();
  const provided = new Map();
  let approvalOutcome = 'allowed-once';
  const ctx = {
    approval: {
      request: async () => approvalOutcome,
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
    setApprovalOutcome(outcome) {
      approvalOutcome = outcome;
    },
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-s3-test-'));
}

/** mock fetch：记录调用；S3 PUT 成功，List/Get 返回空列表。 */
function installFetchMock(records) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init: { ...init, headers: { ...init?.headers } } };
    records.push(record);
    if (init?.method === 'PUT' || init?.method === 'DELETE') {
      return new Response('', { status: 200, headers: { etag: '"e1"' } });
    }
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { etag: '"e1"' } });
    }
    // GET（getObject/listObjects）
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
    assert.equal(records.length, 1, 'created 路径只发一次 PUT');
    assert.equal(records[0].init.method, 'PUT');
    assert.equal(records[0].init.headers['if-none-match'], '*');
    assert.match(records[0].url, /\/mem\/dsh-memory-s3\/memories\/preference\/.+\.json$/);

    // 读路径：search 走缓存（无需 fetch）。
    const searchTool = tools.find((t) => t.name === 'memory_s3_search');
    const search = await searchTool.execute({ text: '中文' }, EXEC());
    assert.equal(search.ok, true);
    assert.equal(search.total, 1);
    assert.equal(search.entries[0].title, '语言');
    assert.equal(records.length, 1, 'search 不触发网络请求');
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
    // merged = head + PUT(If-Match)：共 2 次请求（前一条 created 的 PUT 不计入本轮断言）。
    const lastTwo = records.slice(1);
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
    assert.equal(records.length, 0, '被拒写零落盘');
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
