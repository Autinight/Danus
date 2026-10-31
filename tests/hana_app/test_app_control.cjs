const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AsyncLocalStorage } = require('node:async_hooks');

// Simulated canonical records only; not real verifier-accepted mathematics.
const simulatedFactId = '0123456789abcdef';
const simulatedMarkdown = '---\npredecessors: [aaaaaaaaaaaaaaaa]\n---\n## statement\nSIMULATED ONLY\n## proof\n' + '完整软件夹具，非真实证明。  \n'.repeat(3000) + 'END OF FIXTURE\n';
const root = path.resolve(__dirname, '../..');
const modulePromise = import(pathToFileURL(path.join(root, 'apps/hana-danus/index.js')).href);

async function fixture(t, { autoSchedule = true, taskSupport = true, registerFailure = null } = {}) {
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, 'runtime/hana-control-test-'));
  const entries = new Map();
  const watchers = new Map();
  const stored = new Map();
  const starts = [];
  const stops = [];
  const fetches = [];
  const canonicalFacts = new Map();
  const tools = [];
  const routes = new Map();
  const taskHandlers = new Map();
  const schedules = [];
  const unschedules = [];
  const taskResults = [];
  const hostContext = new AsyncLocalStorage();
  const startContexts = [];
  async function fireSchedule(schedule) {
    const handler = taskHandlers.get(schedule.handlerKey);
    if (!handler) throw Object.assign(new Error('fixture missing handler'), { code: 'APP_TASK_HANDLER_NOT_FOUND' });
    // Test-only model of the host's public App-scope callback boundary.
    return hostContext.run(undefined, async () => {
      const result = await handler.run({ kind: 'schedule', input: structuredClone(schedule.payload), scheduleId: schedule.scheduleId });
      taskResults.push(result);
      return result;
    });
  }
  const encoder = new TextEncoder();
  let loggedIn = true;
  let failure = null;
  let verifierStopped;
  const stoppedVerifier = new Promise((resolve) => { verifierStopped = resolve; });
  function update(runtimeId, state) {
    const info = { ...entries.get(runtimeId), state };
    entries.set(runtimeId, info);
    for (const stream of watchers.get(runtimeId) || []) {
      stream.enqueue(encoder.encode(JSON.stringify({ type: 'runtime', runtime: info }) + '\n'));
      if (['stopped', 'exited', 'failed'].includes(state)) stream.close();
    }
    if (['stopped', 'exited', 'failed'].includes(state)) watchers.delete(runtimeId);
    return info;
  }
  const sdk = {
    dataDir,
    storage: { global: {
      get: async (key) => structuredClone(stored.get(key)),
      set: async (key, value) => { stored.set(key, structuredClone(value)); },
    } },
    logger: { warn() {}, error() {} },
    routes: { register: async (callback) => callback({
      get: (route, handler) => routes.set('GET ' + route, handler),
      post: (route, handler) => routes.set('POST ' + route, handler),
    }) },
    tools: { register: async (tool) => { tools.push(tool); } },
    ...(taskSupport ? { tasks: {
      registerHandler: async (key, handler) => {
        if (registerFailure) throw registerFailure;
        taskHandlers.set(key, handler);
        return () => taskHandlers.delete(key);
      },
      schedule: async (input) => {
        if (!taskHandlers.has(input.handlerKey)) throw Object.assign(new Error('fixture missing handler'), { code: 'APP_TASK_HANDLER_NOT_FOUND' });
        const schedule = { ...structuredClone(input), enabled: true, scheduleId: 'schedule-' + (schedules.length + 1) };
        schedules.push(schedule);
        if (autoSchedule && !input.intervalMs) queueMicrotask(() => { fireSchedule(schedule).catch(() => {}); });
        return schedule;
      },
      getSchedule: async (id) => schedules.find((item) => item.scheduleId === id && !unschedules.includes(id)) || null,
      unschedule: async (id) => {
        if (!schedules.some((item) => item.scheduleId === id) || unschedules.includes(id)) {
          throw Object.assign(new Error('fixture schedule not found'), { code: 'APP_TASK_SCHEDULE_NOT_FOUND' });
        }
        unschedules.push(id);
        return { ok: true };
      },
    } } : {}),
    runtime: {
      list: async () => [...entries.values()],
      get: async (id) => entries.get(id) || null,
      start: async (input) => {
        startContexts.push(hostContext.getStore());
        if (hostContext.getStore()?.callToken) throw Object.assign(new Error('fixture local-machine callToken rejected'), { code: 'APP_RUNTIME_SCOPE_MISMATCH' });
        starts.push(input);
        if (failure && input.args.some((value) => value.endsWith('/worker.py'))) throw failure;
        const runtimeId = 'runtime-' + starts.length;
        const info = { runtimeId, state: 'ready', startedAt: new Date().toISOString(), ...(input.service ? { service: { ...input.service, state: 'ready' } } : {}) };
        entries.set(runtimeId, info);
        return info;
      },
      stop: async (id) => {
        stops.push(id);
        const info = update(id, 'stopped');
        if (info.service?.id === 'danus-verifier') verifierStopped(info);
        return info;
      },
      watch: async (id) => new Response(new ReadableStream({
        start(controller) {
          const info = entries.get(id);
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'runtime', runtime: info }) + '\n'));
          if (['stopped', 'exited', 'failed'].includes(info.state)) {
            controller.close();
            return;
          }
          const current = watchers.get(id) || [];
          current.push(controller);
          watchers.set(id, current);
        },
        cancel() { watchers.delete(id); },
      })),
      fetch: async (_id, endpoint, init) => {
        fetches.push({ endpoint, init });
        let result;
        if (endpoint === '/control/account') result = { logged_in: loggedIn, model: 'configured-model', account_source: 'system_codex', engine: 'bundled', storage: 'app' };
        else if (endpoint === '/control/projects') {
          const body = JSON.parse(init.body);
          result = { project: body.project || 'generated-project', model: body.model || 'configured-model', workers: ['high'], engine: 'bundled', storage: 'app' };
        } else if (endpoint.startsWith('/control/status')) {
          const active = [...entries.values()].some((entry) => !entry.service && !['stopped', 'exited', 'failed'].includes(entry.state));
          const project = new URL(endpoint, 'http://fixture').searchParams.get('project');
          const ids = [...canonicalFacts.values()].filter((fact) => fact.project === project).map((fact) => fact.fact_id);
          result = { project, workers: [{ worker: 'high', alive: active, state: active ? 'running' : 'max_rounds', last_rc: 0 }], fact_count: ids.length, verified_fact_ids: ids, engine: 'bundled', storage: 'app' };
        } else if (endpoint.startsWith('/control/result?')) {
          const params = new URL(endpoint, 'http://fixture').searchParams;
          result = canonicalFacts.get(params.get('project') + ':' + params.get('fact_id'));
          if (!result) return new Response(JSON.stringify({ error: { code: 'fact_not_found' } }), { status: 404 });
        } else result = { projects: [] };
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      },
    },
  };
  const { setupDanus } = await modulePromise;
  const app = await setupDanus(sdk);
  t.after(async () => {
    for (const entry of entries.values()) if (!['stopped', 'exited', 'failed'].includes(entry.state)) update(entry.runtimeId, 'stopped');
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...app, sdk, starts, stops, fetches, tools, entries, routes, update, stoppedVerifier,
    hostContext, startContexts, taskHandlers, schedules, unschedules, taskResults, fireSchedule, stored, watchers, canonicalFacts,
    setLoggedIn: (value) => { loggedIn = value; }, setFailure: (value) => { failure = value; } };
}

test('App registers its real Danus tool without reading settings or starting inference on activation', async (t) => {
  const f = await fixture(t);
  assert.equal(f.tools.length, 1);
  assert.equal(f.tools[0].name, 'danus');
  assert.ok(f.taskHandlers.has('danus-operation-v1'));
  assert.ok(f.taskHandlers.has('danus-supervision-v1'));
  const source = await fs.readFile(path.join(root, 'apps/hana-danus/index.js'), 'utf8');
  const wait = Number(source.match(/const OPERATION_TIMEOUT = (\d+);/)[1]);
  const cleanup = Number(source.match(/const OPERATION_CLEANUP_TIMEOUT = (\d+);/)[1]);
  assert.equal(wait, 20000);
  assert.equal(cleanup, 2000);
  assert.ok(wait + cleanup <= 22000 && wait + cleanup < 30000);
  assert.match(source, /bounded\(sdk\.tasks\.unschedule\(scheduleId\), OPERATION_CLEANUP_TIMEOUT\)/);
  assert.equal(f.schedules.length, 0);
  assert.equal(f.starts.length, 0);
  assert.ok(f.routes.has('POST /danus/run'));
  assert.ok(f.routes.has('GET /danus/status'));
  const token = await fs.readFile(path.join(f.sdk.dataDir, 'monitor-auth-token'), 'utf8');
  assert.match(token.trim(), /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(path.join(f.sdk.dataDir, 'monitor-auth-token'))).mode & 0o777, 0o600);
});

test('run uses only bundled entrypoints and App-owned data, then stops verifier after worker exit', async (t) => {
  const f = await fixture(t);
  const result = await f.dispatch({ action: 'run', problem: 'A symbolic theorem supplied by the operator.' });
  assert.equal(result.project, 'generated-project');
  assert.equal(result.max_rounds, 1);
  assert.equal(f.starts.length, 3);
  for (const input of f.starts) {
    assert.equal(input.profile, 'local-machine');
    assert.equal(input.network, 'external');
    assert.equal(input.cwd, f.sdk.dataDir);
    assert.ok(input.command.endsWith('/apps/hana-danus/dependencies/python/bin/python3'));
    assert.equal(input.args[input.args.indexOf('--data-dir') + 1], f.sdk.dataDir);
    assert.ok(!input.args.includes('--projects-root'));
    assert.ok(!('writeRoots' in input));
  }
  assert.ok(f.starts[0].args.some((value) => value.endsWith('/service/engine.py')));
  assert.ok(f.starts[1].args.some((value) => value.endsWith('/service/verify.py')));
  assert.ok(f.starts[1].args.includes('--token-file'));
  assert.ok(f.starts[2].args.some((value) => value.endsWith('/service/worker.py')));
  assert.ok(f.fetches.every((request) => /^Bearer [a-f0-9]{64}$/.test(request.init.headers.authorization)));
  assert.ok(!JSON.stringify(result).includes('Bearer'));
  // A kernel/host lifecycle record, not a mathematical or model simulation.
  f.update('runtime-3', 'exited');
  await f.fireSchedule(f.schedules.find((item) => item.handlerKey === 'danus-supervision-v1'));
  await f.stoppedVerifier;
  assert.ok(f.stops.includes('runtime-2'));
});

test('a second run is rejected while the owned worker is alive and explicit stop uses host runtime stop', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'A symbolic theorem.' });
  await assert.rejects(f.dispatch({ action: 'run', problem: 'Another theorem.' }), (error) => error.code === 'run_active');
  const result = await f.dispatch({ action: 'stop' });
  assert.ok(f.stops.includes('runtime-3'));
  assert.ok(f.stops.includes('runtime-2'));
  assert.equal(result.fact_count, 0);
  assert.notEqual(result.state, 'running');
});

test('host runtime tracks a launcher before worker control files are initialized, then reports a host failure', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'A theorem.' });
  const fetch = f.sdk.runtime.fetch;
  f.sdk.runtime.fetch = async (id, endpoint, init) => endpoint.startsWith('/control/status')
    ? new Response(JSON.stringify({ project: 'generated-project', workers: [{ worker: 'high', state: 'created', alive: false }], fact_count: 0, verified_fact_ids: [] }))
    : fetch(id, endpoint, init);
  assert.equal((await f.dispatch({ action: 'status' })).state, 'running');
  f.entries.set('runtime-3', { ...f.entries.get('runtime-3'), exitCode: 1 });
  f.update('runtime-3', 'failed');
  assert.equal((await f.dispatch({ action: 'status' })).state, 'error');
});

test('missing login fails before creating a project or launching verifier/worker', async (t) => {
  const f = await fixture(t);
  f.setLoggedIn(false);
  await assert.rejects(f.dispatch({ action: 'run', problem: 'A theorem.' }), (error) => error.code === 'codex_login_required');
  assert.equal(f.starts.length, 1); // authenticated engine/account status only
  assert.ok(!f.fetches.some((request) => request.endpoint === '/control/projects'));
});

test('partial startup failure rolls back the verifier and does not expose raw host errors', async (t) => {
  const f = await fixture(t);
  f.setFailure(Object.assign(new Error('private/path/credential=value'), { kind: 'permission', code: 'APP_CAPABILITY_DENIED' }));
  const response = await f.tools[0].execute({ action: 'run', problem: 'A theorem.' });
  assert.equal(response.isError, true);
  assert.equal(response.details.error.code, 'APP_CAPABILITY_DENIED');
  assert.ok(f.stops.includes('runtime-2'));
  assert.ok(!JSON.stringify(response).includes('private/path'));
});

test('concurrent account and monitoring requests start one managed engine', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 5 }, () => f.dispatch({ action: 'account' })));
  assert.equal(f.starts.length, 1);
});

test('a verifier readiness observation failure rolls back the already-owned service', async (t) => {
  const f = await fixture(t);
  const original = f.sdk.runtime.start;
  f.sdk.runtime.start = async (input) => {
    const info = await original(input);
    if (input.service?.id === 'danus-verifier') {
      info.state = 'starting';
      info.service.state = 'pending';
    }
    return info;
  };
  f.sdk.runtime.watch = async () => { throw new Error('fixture watch failure'); };
  await assert.rejects(f.dispatch({ action: 'run', problem: 'A theorem.' }));
  assert.ok(f.stops.includes('runtime-2'));
  assert.equal(f.entries.get('runtime-2').state, 'stopped');
  assert.equal((await f.dispatch({ action: 'status' })).state, 'error');
  await f.dispatch({ action: 'stop' });
  assert.notEqual((await f.dispatch({ action: 'status' })).state, 'running');
});

test('one worker stop failure does not skip verifier cleanup', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'A theorem.' });
  const original = f.sdk.runtime.stop;
  f.sdk.runtime.stop = async (id) => {
    if (id === 'runtime-3') throw new Error('fixture worker stop failure');
    return original(id);
  };
  await assert.rejects(f.dispatch({ action: 'stop' }), (error) => error.code === 'runtime_cleanup_failed');
  assert.ok(f.stops.includes('runtime-2'));
  const schedule = f.schedules.find((item) => item.handlerKey === 'danus-supervision-v1');
  assert.ok(f.unschedules.includes(schedule.scheduleId));
});

test('project traversal is rejected without contacting the engine', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.dispatch({ action: 'status', project: '../outside' }), (error) => error.code === 'invalid_project');
  assert.equal(f.starts.length, 0);
});

test('every tool action crosses the public App schedule boundary without persisting input or call context', async (t) => {
  const f = await fixture(t);
  const context = { callToken: 'private-invocation-proof', sessionId: 'private-session' };
  for (const input of [
    { action: 'account' },
    { action: 'status', project: 'generated-project' },
    { action: 'run', problem: 'PRIVATE symbolic task input, no actual inference.' },
    { action: 'stop' },
  ]) {
    const result = await f.hostContext.run(context, () => f.tools[0].execute({ ...input, context }));
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    assert.equal(f.hostContext.getStore(), undefined);
  }
  const operations = f.schedules.filter((item) => item.handlerKey === 'danus-operation-v1');
  const supervision = f.schedules.filter((item) => item.handlerKey === 'danus-supervision-v1');
  assert.equal(operations.length, 4);
  assert.equal(supervision.length, 1);
  assert.deepEqual(new Set(f.unschedules), new Set(f.schedules.map((item) => item.scheduleId)));
  assert.deepEqual(Object.keys(supervision[0].payload), ['runId']);
  for (const schedule of operations) {
    assert.deepEqual(Object.keys(schedule).sort(), ['enabled', 'handlerKey', 'label', 'payload', 'runAt', 'scheduleId', 'scope']);
    assert.equal(schedule.scope, 'app');
    assert.equal(schedule.handlerKey, 'danus-operation-v1');
    assert.equal(schedule.label, 'Danus operation');
    assert.equal(typeof schedule.runAt, 'number');
    assert.deepEqual(Object.keys(schedule.payload), ['requestId']);
    assert.match(schedule.payload.requestId, /^[a-f0-9]{32}$/);
  }
  assert.equal(new Set(operations.map((item) => item.payload.requestId)).size, 4);
  assert.ok(!JSON.stringify(f.schedules).includes('private-'));
  assert.ok(!JSON.stringify(f.schedules).includes('PRIVATE'));
  assert.ok(!JSON.stringify(f.schedules).includes(f.sdk.dataDir));
  assert.ok(f.starts.length >= 3);
  assert.ok(f.startContexts.every((value) => value === undefined));
  assert.ok(f.starts.every((input) => !('scope' in input) && !('taskId' in input) && !('callToken' in input)));
  assert.ok(f.taskResults.every((result) => JSON.stringify(result) === '{"status":"completed"}'));
  assert.ok(f.stops.includes('runtime-3') && f.stops.includes('runtime-2'));
  const create = f.fetches.find((item) => item.endpoint === '/control/projects');
  assert.ok(!create.init.body.includes('context') && !create.init.body.includes('private-invocation-proof'));
});

test('a scheduled request is consumed once and stale schedules after reload cannot dispatch', async (t) => {
  const f = await fixture(t, { autoSchedule: false });
  const result = f.tools[0].execute({ action: 'account' });
  await new Promise(setImmediate);
  const schedule = f.schedules[0];
  const outcomes = await Promise.all([f.fireSchedule(schedule), f.fireSchedule(schedule)]);
  assert.deepEqual(outcomes, [{ status: 'completed' }, { status: 'ignored' }]);
  assert.equal((await result).details.logged_in, true);
  assert.equal(f.fetches.length, 1);
  const { setupDanus } = await modulePromise;
  await setupDanus(f.sdk);
  assert.deepEqual(await f.fireSchedule(schedule), { status: 'ignored' });
  assert.deepEqual(await f.taskHandlers.get('danus-operation-v1').run({ kind: 'retry', input: schedule.payload }), { status: 'ignored' });
  assert.equal(f.starts.length, 1);
  assert.equal(f.fetches.length, 1);
});

test('schedule failure preserves safe tool error semantics and removes the pending request', async (t) => {
  const f = await fixture(t);
  let payload;
  f.sdk.tasks.schedule = async (input) => {
    payload = input.payload;
    throw Object.assign(new Error('private task permission detail'), { kind: 'permission', code: 'APP_CAPABILITY_DENIED' });
  };
  const result = await f.tools[0].execute({ action: 'run', problem: 'Symbolic fixture only.' });
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, 'APP_CAPABILITY_DENIED');
  assert.ok(!JSON.stringify(result).includes('private task permission detail'));
  assert.deepEqual(await f.taskHandlers.get('danus-operation-v1').run({ kind: 'schedule', input: payload }), { status: 'ignored' });
  assert.equal(f.starts.length, 0);
  assert.equal(f.unschedules.length, 0);
});

test('missing public task support or failed handler registration never falls back to dispatch', async (t) => {
  for (const options of [
    { taskSupport: false },
    { registerFailure: Object.assign(new Error('private registration detail'), { code: 'APP_TASK_HANDLER_NOT_FOUND' }) },
  ]) {
    const f = await fixture(t, options);
    const result = await f.tools[0].execute({ action: 'account' });
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, options.taskSupport === false ? 'operation_unavailable' : 'APP_TASK_HANDLER_NOT_FOUND');
    assert.ok(!JSON.stringify(result).includes('private registration detail'));
    assert.equal(f.starts.length, 0);
  }
});

test('a handler unavailable at schedule time returns a controlled tool error without inference', async (t) => {
  const f = await fixture(t);
  f.taskHandlers.clear();
  const result = await f.tools[0].execute({ action: 'account' });
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, 'APP_TASK_HANDLER_NOT_FOUND');
  assert.equal(f.starts.length, 0);
});

test('timeout cancels an unstarted request and cleans up even a late schedule acknowledgement', async (t) => {
  const f = await fixture(t, { autoSchedule: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let acknowledge;
  f.sdk.tasks.schedule = (input) => {
    const schedule = { ...input, scheduleId: 'late-schedule' };
    f.schedules.push(schedule);
    return new Promise((resolve) => { acknowledge = () => resolve(schedule); });
  };
  const pending = f.tools[0].execute({ action: 'run', problem: 'Symbolic fixture only.' });
  await new Promise(setImmediate);
  t.mock.timers.tick(20000);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, 'operation_timeout');
  assert.deepEqual(await f.fireSchedule(f.schedules[0]), { status: 'ignored' });
  assert.equal(f.starts.length, 0);
  acknowledge();
  await new Promise(setImmediate);
  assert.deepEqual(f.unschedules, ['late-schedule']);
});

test('timeout during an accepted run does not replay it and leaves ownership/status and stop intact', async (t) => {
  const f = await fixture(t, { autoSchedule: false });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = f.sdk.runtime.start;
  let releaseWorker;
  f.sdk.runtime.start = async (input) => {
    if (input.args.some((value) => value.endsWith('/worker.py'))) await new Promise((resolve) => { releaseWorker = resolve; });
    return original(input);
  };
  const pending = f.tools[0].execute({ action: 'run', problem: 'Symbolic fixture only.' });
  await new Promise(setImmediate);
  const callback = f.fireSchedule(f.schedules[0]);
  await new Promise(setImmediate);
  assert.equal(typeof releaseWorker, 'function');
  t.mock.timers.tick(20000);
  const result = await pending;
  assert.equal(result.details.error.code, 'operation_timeout');
  assert.match(result.details.error.message, /status/);
  assert.deepEqual(await f.fireSchedule(f.schedules[0]), { status: 'ignored' });
  releaseWorker();
  assert.deepEqual(await callback, { status: 'completed' });
  assert.equal(f.starts.length, 3);
  assert.equal((await f.dispatch({ action: 'status' })).state, 'running');
  const duplicate = f.tools[0].execute({ action: 'run', problem: 'Do not blindly restart an owned run.' });
  await new Promise(setImmediate);
  assert.deepEqual(await f.fireSchedule(f.schedules.filter((item) => item.handlerKey === 'danus-operation-v1')[1]), { status: 'failed' });
  assert.equal((await duplicate).details.error.code, 'run_active');
  assert.equal(f.starts.length, 3);
  await f.dispatch({ action: 'stop' });
  assert.ok(f.stops.includes('runtime-3') && f.stops.includes('runtime-2'));
});

test('active worker tools and lifecycle checks leave no long watch RPC for host drain', async (t) => {
  const f = await fixture(t);
  const outgoingReads = [];
  let watchCalls = 0;
  f.sdk.runtime.watch = async () => {
    watchCalls++;
    return new Response(new ReadableStream({
      pull() { const read = new Promise(() => {}); outgoingReads.push(read); return read; },
    }));
  };
  async function hostExecute(input) {
    const result = await f.tools[0].execute(input);
    // Model the host's global RPC drain after registered-tool execution.
    await Promise.all(outgoingReads);
    return result;
  }
  const run = await hostExecute({ action: 'run', problem: 'Symbolic fixture only.' });
  assert.equal(run.details.state, 'running');
  assert.equal((await hostExecute({ action: 'status' })).details.state, 'running');
  const schedule = f.schedules.find((item) => item.handlerKey === 'danus-supervision-v1');
  assert.deepEqual(await f.fireSchedule(schedule), { status: 'active' });
  assert.equal(watchCalls, 0);
  assert.equal(outgoingReads.length, 0);
  assert.equal(f.watchers.size, 0);
  assert.equal(f.starts.length, 3);
  assert.equal(schedule.scope, 'app');
  assert.equal(schedule.intervalMs, 10000);
  assert.deepEqual(Object.keys(schedule.payload), ['runId']);
  await hostExecute({ action: 'stop' });
  assert.ok(f.unschedules.includes(schedule.scheduleId));
});

test('supervisor recovery reuses a valid schedule and rearms a missing schedule without inference', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
  const record = f.stored.get('danus-owned-run-v1');
  assert.equal(typeof record.supervisionDeadline, 'number');
  assert.equal(typeof record.supervisionScheduleId, 'string');
  const { setupDanus } = await modulePromise;
  const recovered = await setupDanus(f.sdk);
  assert.equal(f.schedules.filter((item) => item.handlerKey === 'danus-supervision-v1').length, 1);
  assert.equal(f.starts.length, 3);
  assert.equal((await recovered.dispatch({ action: 'status' })).state, 'running');
  await f.sdk.tasks.unschedule(record.supervisionScheduleId);
  const rearmed = await setupDanus(f.sdk);
  const updated = f.stored.get('danus-owned-run-v1');
  assert.notEqual(updated.supervisionScheduleId, record.supervisionScheduleId);
  assert.equal(updated.supervisionDeadline, record.supervisionDeadline);
  const stale = f.schedules.find((item) => item.scheduleId === record.supervisionScheduleId);
  assert.deepEqual(await f.fireSchedule(stale), { status: 'ignored' });
  assert.equal(f.stops.length, 0);
  assert.equal(f.starts.length, 3);
  assert.equal(f.watchers.size, 0);
  await rearmed.dispatch({ action: 'stop' });
  assert.ok(f.unschedules.includes(updated.supervisionScheduleId));
});

test('a stale lifecycle tick only removes itself and never stops the newer verifier', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'First symbolic fixture.' });
  const oldSchedule = f.schedules.find((item) => item.handlerKey === 'danus-supervision-v1');
  await f.dispatch({ action: 'stop' });
  await f.dispatch({ action: 'run', problem: 'Second symbolic fixture.' });
  const current = f.stored.get('danus-owned-run-v1');
  const before = f.stops.length;
  assert.deepEqual(await f.fireSchedule(oldSchedule), { status: 'ignored' });
  assert.equal(f.stops.length, before);
  assert.equal(f.entries.get(current.verifierRuntimeId).state, 'ready');
  assert.ok(f.unschedules.includes(oldSchedule.scheduleId));
  await f.dispatch({ action: 'stop' });
});

test('the lifecycle deadline cleans workers, verifier and its schedule without launching anything', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
  const record = f.stored.get('danus-owned-run-v1');
  const schedule = f.schedules.find((item) => item.scheduleId === record.supervisionScheduleId);
  t.mock.method(Date, 'now', () => record.supervisionDeadline + 1);
  assert.deepEqual(await f.fireSchedule(schedule), { status: 'stopped' });
  assert.ok(f.stops.includes('runtime-3') && f.stops.includes('runtime-2'));
  assert.ok(f.unschedules.includes(schedule.scheduleId));
  assert.equal(f.stored.get('danus-owned-run-v1').supervisionScheduleId, undefined);
  assert.equal(f.starts.length, 3);
});

test('unknown workers finish lifecycle supervision and stop only the owned verifier', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
  const schedule = f.schedules.find((item) => item.handlerKey === 'danus-supervision-v1');
  f.entries.delete('runtime-3');
  assert.deepEqual(await f.fireSchedule(schedule), { status: 'completed' });
  assert.deepEqual(f.stops, ['runtime-2']);
  assert.ok(f.unschedules.includes(schedule.scheduleId));
  assert.equal(f.starts.length, 3);
});

test('supervision schedule arming failure rolls back worker and verifier ownership', async (t) => {
  const f = await fixture(t);
  const original = f.sdk.tasks.schedule;
  f.sdk.tasks.schedule = async (input) => {
    if (input.handlerKey === 'danus-supervision-v1') throw Object.assign(new Error('private supervision failure'), { code: 'APP_CAPABILITY_DENIED' });
    return original(input);
  };
  const result = await f.tools[0].execute({ action: 'run', problem: 'Symbolic fixture only.' });
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, 'APP_CAPABILITY_DENIED');
  assert.ok(!JSON.stringify(result).includes('private supervision failure'));
  assert.ok(f.stops.includes('runtime-3') && f.stops.includes('runtime-2'));
  assert.equal(f.stored.get('danus-owned-run-v1').startupFailed, true);
  assert.equal((await f.dispatch({ action: 'status' })).state, 'error');
  assert.equal(f.watchers.size, 0);
});

test('recovery arming failure stops existing owned inference instead of leaving it unsupervised', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
  const record = f.stored.get('danus-owned-run-v1');
  await f.sdk.tasks.unschedule(record.supervisionScheduleId);
  f.sdk.tasks.schedule = async () => { throw Object.assign(new Error('simulated schedule failure'), { code: 'APP_CAPABILITY_DENIED' }); };
  const { setupDanus } = await modulePromise;
  await assert.rejects(setupDanus(f.sdk), (error) => error.code === 'APP_CAPABILITY_DENIED');
  assert.ok(f.stops.includes('runtime-3') && f.stops.includes('runtime-2'));
  assert.equal(f.stored.get('danus-owned-run-v1').interrupted, true);
  assert.equal(f.stored.get('danus-owned-run-v1').startupFailed, true);
  assert.equal(f.stored.get('danus-owned-run-v1').supervisionScheduleId, undefined);
  assert.equal(f.starts.length, 3);
});

test('recovery of an uncommitted launch stops owned runtimes and removes its schedule', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
  const record = f.stored.get('danus-owned-run-v1');
  f.stored.set('danus-owned-run-v1', { ...record, launching: true, runtimeIds: [] });
  const { setupDanus } = await modulePromise;
  await setupDanus(f.sdk);
  assert.ok(f.stops.includes('runtime-3') && f.stops.includes('runtime-2'));
  assert.ok(f.unschedules.includes(record.supervisionScheduleId));
  assert.equal(f.stored.get('danus-owned-run-v1').interrupted, true);
  assert.equal(f.starts.length, 3);
});

test('missing lifecycle records allow explicit stop and interrupted recovery to clear stale ownership fields', async (t) => {
  for (const recovering of [false, true]) {
    const f = await fixture(t);
    await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
    const record = f.stored.get('danus-owned-run-v1');
    await f.sdk.tasks.unschedule(record.supervisionScheduleId);
    await assert.rejects(f.sdk.tasks.unschedule(record.supervisionScheduleId), (error) => error.code === 'APP_TASK_SCHEDULE_NOT_FOUND');
    await assert.rejects(f.sdk.tasks.unschedule('nonexistent-id'), (error) => error.code === 'APP_TASK_SCHEDULE_NOT_FOUND');
    if (recovering) {
      f.stored.set('danus-owned-run-v1', { ...record, launching: true });
      const { setupDanus } = await modulePromise;
      await setupDanus(f.sdk);
    } else {
      assert.equal((await f.dispatch({ action: 'stop' })).state, 'stopped');
    }
    const saved = f.stored.get('danus-owned-run-v1');
    assert.equal(saved.supervisionScheduleId, undefined);
    assert.equal(saved.launching, false);
    assert.equal(saved.interrupted, recovering ? true : undefined);
    assert.ok(f.stops.includes('runtime-3') && f.stops.includes('runtime-2'));
    assert.equal(f.starts.length, 3);
  }
});

test('a lifecycle removal race succeeds only after confirming the schedule is absent', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
  const record = f.stored.get('danus-owned-run-v1');
  const original = f.sdk.tasks.unschedule;
  f.sdk.tasks.unschedule = async (id) => {
    await original(id); // Simulate another remover winning after getSchedule.
    throw Object.assign(new Error('fixture already removed'), { code: 'APP_TASK_SCHEDULE_NOT_FOUND' });
  };
  assert.equal((await f.dispatch({ action: 'stop' })).state, 'stopped');
  assert.equal(await f.sdk.tasks.getSchedule(record.supervisionScheduleId), null);
  assert.equal(f.stored.get('danus-owned-run-v1').supervisionScheduleId, undefined);
  assert.deepEqual(await f.fireSchedule(f.schedules.find((item) => item.scheduleId === record.supervisionScheduleId)), { status: 'ignored' });
});

test('real lifecycle permission failures are preserved unless absence is confirmed', async (t) => {
  for (const recheckFails of [false, true]) {
    const f = await fixture(t);
    await f.dispatch({ action: 'run', problem: 'Symbolic fixture only.' });
    f.update('runtime-3', 'exited');
    const record = f.stored.get('danus-owned-run-v1');
    const denied = Object.assign(new Error('private permission failure'), { kind: 'permission', code: 'APP_CAPABILITY_DENIED' });
    const originalRemove = f.sdk.tasks.unschedule;
    const originalGet = f.sdk.tasks.getSchedule;
    let lookups = 0;
    f.sdk.tasks.getSchedule = async (id) => {
      if (++lookups > 1 && recheckFails) throw new Error('private recheck failure');
      return originalGet(id);
    };
    f.sdk.tasks.unschedule = async () => { throw denied; };
    await assert.rejects(f.dispatch({ action: 'run', problem: 'Must not start another fixture.' }), (error) => error === denied);
    assert.equal(lookups, 2);
    assert.equal(f.stored.get('danus-owned-run-v1').supervisionScheduleId, record.supervisionScheduleId);
    assert.equal(f.starts.length, 3);
    f.sdk.tasks.unschedule = originalRemove;
    f.sdk.tasks.getSchedule = originalGet;
    await f.dispatch({ action: 'stop' });
  }
});

test('result exposes the narrow tool schema and validates project/fact IDs before contacting engine', async (t) => {
  const f = await fixture(t);
  const tool = f.tools[0];
  assert.ok(tool.parameters.properties.action.enum.includes('result'));
  assert.deepEqual(tool.parameters.properties.fact_id, {
    type: 'string', minLength: 16, maxLength: 16, pattern: '^[a-f0-9]{16}$',
    description: 'Required for result: one canonical ID from status.verified_fact_ids. Returns the complete accepted fact markdown and predecessors.',
  });
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.match(tool.description, /natural-language mathematical proof/);
  assert.match(tool.description, /run → status → result/);
  assert.match(tool.description, /omit project\/model.*default workers=1/);
  assert.match(tool.description, /save the project returned by run/);
  assert.match(tool.description, /result\.predecessors/);
  assert.match(tool.description, /complete requested target/);
  assert.match(tool.description, /finished is only a lifecycle state/);
  assert.match(tool.description, /ID ordering does not identify the target theorem/);
  for (const [input, code] of [
    [{ fact_id: simulatedFactId }, 'project_required'],
    [{ project: '../outside', fact_id: simulatedFactId }, 'invalid_project'],
    [{ project: '', fact_id: simulatedFactId }, 'invalid_project'],
    [{ project: 'alpha', fact_id: undefined }, 'invalid_fact_id'],
    ...['A'.repeat(16), 'a'.repeat(15), 'a'.repeat(17), '../outside', 'a'.repeat(16) + '\n', 'a'.repeat(16) + '\r', 'a'.repeat(16) + '\r\n', 'a'.repeat(16) + '\u2028', 'a'.repeat(16) + '\u2029', null, 123].map((fact_id) => [{ project: 'alpha', fact_id }, 'invalid_fact_id']),
  ]) {
    await assert.rejects(f.dispatch({ action: 'result', ...input }), (error) => error.code === code && error.status === 400);
    const result = await tool.execute({ action: 'result', ...input });
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, code);
  }
  assert.equal(f.starts.length, 0);
  assert.equal(f.fetches.length, 0);
});

test('simulated run → status → result returns the entire canonical proof repeatedly with no additional inference', async (t) => {
  const f = await fixture(t);
  const tool = f.tools[0];
  const run = await tool.execute({ action: 'run', problem: 'Software fixture, no real mathematics.' });
  assert.equal(run.details.state, 'running');
  const fact = { project: run.details.project, fact_id: simulatedFactId, markdown: simulatedMarkdown,
    predecessors: ['aaaaaaaaaaaaaaaa'], source: 'fact_graph', engine: 'bundled', storage: 'app' };
  f.canonicalFacts.set(fact.project + ':' + fact.fact_id, fact);
  f.update('runtime-3', 'exited');
  await f.fireSchedule(f.schedules.find((item) => item.handlerKey === 'danus-supervision-v1'));
  const status = await tool.execute({ action: 'status' });
  assert.equal(status.details.state, 'finished');
  assert.deepEqual(status.details.verified_fact_ids, [simulatedFactId]);
  const count = f.starts.length;
  for (let i = 0; i < 2; i++) {
    const response = await tool.execute({ action: 'result', fact_id: status.details.verified_fact_ids[0] });
    assert.notEqual(response.isError, true);
    assert.deepEqual(response.details, fact);
    assert.deepEqual(JSON.parse(response.content[0].text), fact);
    const request = f.fetches.at(-1);
    assert.equal(request.endpoint, '/control/result?project=generated-project&fact_id=' + simulatedFactId);
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.body, undefined);
    assert.ok(!JSON.stringify(response).includes('Bearer'));
  }
  assert.equal(f.starts.length, count);
  assert.equal(count, 3);
  const missing = await tool.execute({ action: 'result', fact_id: 'ffffffffffffffff' });
  assert.equal(missing.isError, true);
  assert.equal(missing.details.error.code, 'fact_not_found');
});

test('GET result route forwards explicit historical project or defaults current and preserves safe errors', async (t) => {
  const f = await fixture(t);
  const fact = { project: 'history-1', fact_id: simulatedFactId, markdown: simulatedMarkdown,
    predecessors: [], source: 'fact_graph', engine: 'bundled', storage: 'app' };
  f.canonicalFacts.set(fact.project + ':' + fact.fact_id, fact);
  const route = f.routes.get('GET /danus/result');
  const context = (query) => ({ req: { query: (name) => query[name] } });
  const response = await route(context({ project: 'history-1', fact_id: simulatedFactId }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), fact);
  assert.equal(f.fetches.at(-1).endpoint, '/control/result?project=history-1&fact_id=' + simulatedFactId);
  const missing = await route(context({ fact_id: simulatedFactId }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'project_required');
  const invalid = await route(context({ project: '../outside', fact_id: simulatedFactId }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_project');
  await f.dispatch({ action: 'run', problem: 'Software fixture only.' });
  f.canonicalFacts.set('generated-project:' + simulatedFactId, { ...fact, project: 'generated-project' });
  const current = await route(context({ fact_id: simulatedFactId }));
  assert.equal((await current.json()).project, 'generated-project');
  await f.dispatch({ action: 'stop' });
});

test('result is read-only and does not queue behind an in-flight run serial section', async (t) => {
  const f = await fixture(t);
  const original = f.sdk.runtime.start;
  let release;
  f.sdk.runtime.start = async (input) => {
    if (input.args.some((value) => value.endsWith('/worker.py'))) await new Promise((resolve) => { release = resolve; });
    return original(input);
  };
  const run = f.dispatch({ action: 'run', problem: 'Software fixture only.' });
  await new Promise(setImmediate);
  assert.equal(typeof release, 'function');
  const fact = { project: 'generated-project', fact_id: simulatedFactId, markdown: simulatedMarkdown,
    predecessors: [], source: 'fact_graph', engine: 'bundled', storage: 'app' };
  f.canonicalFacts.set(fact.project + ':' + fact.fact_id, fact);
  assert.deepEqual(await f.dispatch({ action: 'result', fact_id: simulatedFactId }), fact);
  assert.equal(f.starts.length, 2);
  release();
  await run;
  await f.dispatch({ action: 'stop' });
});

test('unschedule failure cannot replace the original result or authorize a replay', async (t) => {
  const f = await fixture(t);
  f.sdk.tasks.unschedule = async () => { throw new Error('private unschedule detail'); };
  const result = await f.tools[0].execute({ action: 'account' });
  assert.equal(result.details.logged_in, true);
  assert.deepEqual(await f.fireSchedule(f.schedules[0]), { status: 'ignored' });
  assert.equal(f.fetches.length, 1);
});
