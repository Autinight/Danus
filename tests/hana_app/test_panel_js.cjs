const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const uiRoot = path.join(root, 'apps/hana-danus/ui');
const source = fs.readFileSync(path.join(uiRoot, 'assets/panel.js'), 'utf8');
const panelHtml = fs.readFileSync(path.join(uiRoot, 'panel.html'), 'utf8');
const panelCss = fs.readFileSync(path.join(uiRoot, 'assets/panel.css'), 'utf8');
const originalHtml = fs.readFileSync(path.join(root, 'danus/observability/static/index.html'), 'utf8');
const originalJs = fs.readFileSync(path.join(root, 'danus/observability/static/app.js'), 'utf8');
const RUN_KEY = 'danus-owned-run-v1';
const jsonResponse = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function loadBridge({ fetchImpl, projects = [], ownedRun = null, hash = '', themeReady = Promise.resolve() } = {}) {
  const apiCalls = [];
  const nativeCalls = [];
  const storageReads = [];
  const subscriptions = new Set();
  const handlers = new Map();
  const reloads = [];
  const mounts = [];
  const themeStarts = [];
  const timers = new Set();
  const banner = { hidden: true, textContent: 'Original connection banner' };
  let currentProjects = projects;
  let currentRun = ownedRun;
  const storage = {
    get: async (key, options) => { storageReads.push({ key, options }); return structuredClone(currentRun); },
    onChanged(callback) { subscriptions.add(callback); return () => subscriptions.delete(callback); },
  };
  const context = {
    __hana: {
      ready: async () => {},
      storage: { global: storage },
      api: { fetch: async (...args) => {
        apiCalls.push(args);
        if (fetchImpl) return fetchImpl(...args);
        if (args[0] === '/monitor/start') return jsonResponse({ state: 'ready' });
        if (args[0] === '/monitor/state') return jsonResponse({ state: 'ready', service: 'ready' });
        if (args[0] === '/monitor/projects') return jsonResponse({ projects: currentProjects });
        return { source: 'hana' };
      } },
    },
    window: {
      location: { href: 'https://hana.local/panel.html', hash, reload: () => reloads.push('reload') },
      echarts: {}, katex: {}, markdownit: {},
      setTimeout(callback, delay) {
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
        timers.add(timer);
        return timer;
      },
      clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
      addEventListener(type, callback) { const listeners = handlers.get(type) || []; listeners.push(callback); handlers.set(type, listeners); },
      fetch: async (...args) => { nativeCalls.push(args); return { source: 'native' }; },
    },
    document: {
      querySelector(selector) { assert.equal(selector, '#conn-banner', 'only the original banner may be accessed'); return banner; },
    },
    __startDashboardTheme: (hana) => { themeStarts.push(hana); return { ready: themeReady }; },
    __mountOriginal: async () => { assert.equal(themeStarts.length, 1, 'theme adapter starts before the upstream renderer'); mounts.push('original'); },
    URL,
    AbortController,
  };
  const executable = source
    .replace(/^import \{ hana \} from '\.\/sdk\.js';\s*/m, 'const hana = globalThis.__hana;\n')
    .replace(/^import \{ startDashboardTheme \} from '\.\/theme\.js';\s*/m, 'const startDashboardTheme = globalThis.__startDashboardTheme;\n')
    .replace(/\bexport\s+/g, '')
    .replace("await import('../dashboard/app.js');", 'await globalThis.__mountOriginal();')
    .replace(/\nstart\(\);\s*$/, '\n')
    + '\nglobalThis.testApi = { validProjectId, chooseProjectId, mapDashboardRequest, installDashboardFetch, reloadForProject, bootstrapDashboard, createProjectFollower, requestJson, start };\n';
  vm.runInNewContext(executable, context, { filename: 'panel.js' });
  return {
    bridge: context.testApi, window: context.window, storage, apiCalls, nativeCalls, storageReads, subscriptions, reloads, mounts, banner, timers,
    setProjects(value) { currentProjects = value; },
    setOwnedRun(value) { currentRun = value; },
    async emitStorage(keys = [RUN_KEY]) { await Promise.all([...subscriptions].map((callback) => callback(keys))); },
    async emitWindow(type, event = {}) { await Promise.all((handlers.get(type) || []).map((callback) => callback(event))); },
  };
}

function body(html) { return html.slice(html.indexOf('<body>')); }

async function assertAllReadRoutes(f, project) {
  for (const [upstream, monitor] of [
    ['/api/overview', '/monitor/overview'],
    ['/api/factgraph', '/monitor/factgraph'],
    ['/api/channels', '/monitor/channels'],
    ['/api/channel/conclusion', '/monitor/channel/conclusion'],
  ]) {
    await f.window.fetch(upstream);
    assert.equal(f.apiCalls.at(-1)[0], `${monitor}?project=${project}`);
    assert.equal(f.apiCalls.at(-1)[1].method || 'GET', 'GET');
  }
}

test('entire upstream body is identical after only normalizing the final bootstrap script', () => {
  const normalized = panelHtml.replace('  <script type="module" src="./assets/panel.js"></script>', '  <script defer src="/static/app.js"></script>');
  assert.equal(body(normalized), body(originalHtml));
  assert.doesNotMatch(panelHtml, /<form\b|<button\b|<select\b|<textarea\b|<input\b|task-controls|project-picker|conn-message/);
  assert.equal((panelHtml.match(/href="\.\/assets\/panel\.css"/g) || []).length, 1);
  assert.ok(panelCss.includes('--danus-accent'));
  const assetPairs = [
    ['https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css', './vendor/katex.min.css'],
    ['https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js', './vendor/echarts.min.js'],
    ['https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js', './vendor/katex.min.js'],
    ['https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js', './vendor/markdown-it.min.js'],
    ['/static/style.css', './dashboard/style.css'],
  ];
  let fullyNormalized = normalized.replace('  <link rel="stylesheet" href="./assets/panel.css" />\n', '');
  for (const [original, local] of assetPairs) fullyNormalized = fullyNormalized.replace(local, original);
  assert.equal(fullyNormalized, originalHtml, 'the document changes only asset URLs, App colour CSS, and the final script');
  assert.ok(source.includes("await import('../dashboard/app.js')"));
  assert.ok(originalJs.includes('async function loadOverview()'));
  for (const renderer of ['loadOverview', 'loadGraph', 'showFact', 'loadMemory', 'loadChannel', 'mdmath', 'function bars']) {
    assert.ok(!source.includes(renderer), `bridge does not reimplement ${renderer}`);
  }
  assert.doesNotMatch(source, /\/danus\/|setInterval|createStatusPoller|createElement|innerHTML|projectsRoot|confirm\(/);
});

test('valid existing owned project outranks stale hash; hash and first project are fallback only', () => {
  const { bridge } = loadBridge();
  const projects = [{ id: 'history' }, { id: 'latest.v2' }, { id: '../escape' }];
  assert.equal(bridge.chooseProjectId(projects, '#history', { project: 'latest.v2' }), 'latest.v2');
  assert.equal(bridge.chooseProjectId(projects, '#latest%2Ev2', { project: 'history' }), 'history');
  for (const hash of ['', '#missing', '#%broken', '#../escape']) {
    assert.equal(bridge.chooseProjectId(projects, hash, { project: 'latest.v2' }), 'latest.v2');
  }
  for (const run of [null, {}, { project: '../escape' }, { project: 'missing' }]) {
    assert.equal(bridge.chooseProjectId(projects, '#latest%2Ev2', run), 'latest.v2');
    assert.equal(bridge.chooseProjectId(projects, '#missing', run), 'history');
    assert.equal(bridge.chooseProjectId([], '#latest.v2', run), '');
  }
  assert.equal(bridge.chooseProjectId([{ id: '../escape' }], '#../escape', { project: '../escape' }), '');
});

test('only exact same-origin dashboard GET endpoints map to project-scoped Hana routes', () => {
  const { bridge } = loadBridge();
  const base = 'https://hana.local/panel.html';
  for (const [input, route] of [
    ['/api/overview', '/monitor/overview'],
    ['/api/factgraph', '/monitor/factgraph'],
    ['/api/channels', '/monitor/channels'],
    ['/api/channel/conclusion', '/monitor/channel/conclusion'],
    ['https://hana.local/api/overview', '/monitor/overview'],
  ]) assert.equal(bridge.mapDashboardRequest(input, {}, base, 'alpha.beta'), `${route}?project=alpha.beta`);
  assert.equal(bridge.mapDashboardRequest({ url: '/api/overview', method: 'GET' }, {}, base, 'alpha'), '/monitor/overview?project=alpha');
  for (const [input, init] of [
    ['/api/projects', {}], ['/api/overview?extra=1', {}], ['/api/overview?', {}],
    ['/api/overview#fragment', {}], ['/api/overview#', {}], ['/api/overview', { method: 'POST' }],
    ['/api/channel/invalid-kind!', {}], ['https://elsewhere.test/api/overview', {}],
    ['https://user:secret@hana.local/api/overview', {}],
  ]) assert.equal(bridge.mapDashboardRequest(input, init, base, 'alpha'), null, `${input} is not intercepted`);
  assert.throws(() => bridge.mapDashboardRequest('/api/overview', {}, base, ''), /not initialized/);
});

test('fetch uses Hana for mapped reads and native fetch for unrelated requests', async () => {
  const f = loadBridge();
  f.bridge.installDashboardFetch('alpha');
  assert.deepEqual(await f.window.fetch('/api/overview'), { source: 'hana' });
  assert.equal(f.apiCalls[0][0], '/monitor/overview?project=alpha');
  assert.equal(f.apiCalls[0][1].cache, 'no-store');
  await f.window.fetch('/api/overview?extra=1');
  await f.window.fetch('/api/overview', { method: 'POST' });
  assert.equal(f.nativeCalls.length, 2);
  assert.equal(f.apiCalls.length, 1);
});

test('bootstrap waits for Hana, local vendors, and monitor readiness before following storage', async () => {
  const { bridge } = loadBridge();
  const events = [];
  let releaseReady;
  let releaseVendors;
  let vendorsEntered;
  const entered = new Promise((resolve) => { vendorsEntered = resolve; });
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const vendors = new Promise((resolve) => { releaseVendors = resolve; });
  const task = bridge.bootstrapDashboard({
    ready: () => { events.push('ready'); return ready; },
    loadVendors: () => { events.push('vendors'); vendorsEntered(); return vendors; },
    startMonitor: async () => { events.push('monitor'); return 30000; },
    followProjects: async (deadline) => { assert.equal(deadline, 30000); events.push('follow'); },
  });
  assert.deepEqual(events, ['ready']);
  releaseReady();
  await entered;
  assert.deepEqual(events, ['ready', 'vendors']);
  releaseVendors();
  await task;
  assert.deepEqual(events, ['ready', 'vendors', 'monitor', 'follow']);
});

test('stale cube-minus-n-live hash binds all four reads to current cube-minus-n-app-live on initial load', async () => {
  const f = loadBridge({ projects: [{ id: 'cube-minus-n-live' }, { id: 'cube-minus-n-app-live' }], ownedRun: { project: 'cube-minus-n-app-live', runtimeIds: ['owned-runtime'] }, hash: '#cube-minus-n-live' });
  await f.bridge.start();
  assert.deepEqual(f.mounts, ['original']);
  assert.deepEqual(f.apiCalls.map(([route]) => route), ['/monitor/start', '/monitor/state', '/monitor/projects']);
  assert.equal(f.storageReads[0].key, RUN_KEY);
  assert.equal(f.storageReads[0].options.timeoutMs, 20000);
  assert.equal(f.subscriptions.size, 1);
  assert.equal(f.banner.hidden, true);
  assert.equal(f.timers.size, 0, 'there is no additional status timer after bootstrap');
  await assertAllReadRoutes(f, 'cube-minus-n-app-live');
  assert.equal(f.reloads.length, 0);
  await f.emitWindow('pagehide');
  assert.equal(f.subscriptions.size, 0);
  f.setProjects([{ id: 'cube-minus-n-live' }, { id: 'cube-minus-n-app-live' }, { id: 'resumed-run' }]);
  f.setOwnedRun({ project: 'resumed-run' });
  await f.emitWindow('pageshow', { persisted: true });
  assert.equal(f.subscriptions.size, 1);
  assert.equal(f.window.location.hash, '#resumed-run');
  assert.deepEqual(f.reloads, ['reload']);
  assert.equal(f.timers.size, 0);
  await f.emitStorage();
  assert.equal(f.reloads.length, 1, 'same-owned update after persisted remount does not reload again');
  await f.emitWindow('pagehide');
});

test('current owned run beats history; same-owned updates are stable and a real project change reloads read-only', async () => {
  const f = loadBridge({ projects: [{ id: 'history' }, { id: 'current' }], ownedRun: { project: 'current' }, hash: '#history' });
  await f.bridge.start();
  await f.window.fetch('/api/factgraph');
  assert.equal(f.apiCalls.at(-1)[0], '/monitor/factgraph?project=current');
  await f.emitStorage();
  assert.equal(f.reloads.length, 0, 'same-owned-project updates do not reload');
  f.setProjects([{ id: 'history' }, { id: 'current' }, { id: 'new-run' }]);
  f.setOwnedRun({ project: 'new-run', launching: true });
  await f.emitStorage();
  assert.equal(f.window.location.hash, '#new-run');
  assert.deepEqual(f.reloads, ['reload']);
  assert.deepEqual(f.mounts, ['original']);
  await f.emitStorage();
  assert.equal(f.reloads.length, 1, 'updates to the same run do not reload repeatedly');
  assert.ok(f.apiCalls.every(([route]) => route.startsWith('/monitor/')));
  await f.emitWindow('pagehide');
  const fresh = loadBridge({ projects: [{ id: 'history' }, { id: 'current' }, { id: 'new-run' }], ownedRun: { project: 'new-run' }, hash: f.window.location.hash });
  await fresh.bridge.start();
  await assertAllReadRoutes(fresh, 'new-run');
  assert.deepEqual(fresh.mounts, ['original']);
  assert.equal(fresh.reloads.length, 0);
  await fresh.emitWindow('pagehide');
});

test('a page closed during an agent run reopens on the current project without any new storage event', async () => {
  const projects = [{ id: 'cube-minus-n-live' }, { id: 'cube-minus-n-app-live' }];
  const closed = loadBridge({ projects, ownedRun: { project: 'cube-minus-n-live' }, hash: '#cube-minus-n-live' });
  await closed.bridge.start();
  await assertAllReadRoutes(closed, 'cube-minus-n-live');
  await closed.emitWindow('pagehide');
  assert.equal(closed.subscriptions.size, 0);
  const readsBeforeRun = closed.storageReads.length;
  closed.setOwnedRun({ project: 'cube-minus-n-app-live' });
  await closed.emitStorage();
  assert.equal(closed.storageReads.length, readsBeforeRun, 'unmounted page receives no new-run notification');

  const reopened = loadBridge({ projects, ownedRun: { project: 'cube-minus-n-app-live' }, hash: closed.window.location.hash });
  await reopened.bridge.start();
  await assertAllReadRoutes(reopened, 'cube-minus-n-app-live');
  assert.deepEqual(reopened.mounts, ['original']);
  assert.equal(reopened.reloads.length, 0, 'fresh storage read binds current project without needing an event or reload');
  assert.equal(reopened.timers.size, 0);
  await reopened.emitStorage();
  assert.equal(reopened.reloads.length, 0, 'same-owned notification after reopening stays stable');
  await reopened.emitWindow('pagehide');
});

test('missing or invalid current run falls back to existing hash without inventing projects', async () => {
  for (const ownedRun of [null, {}, { project: '../escape' }, { project: 'missing' }]) {
    const f = loadBridge({ projects: [{ id: 'first' }, { id: 'history' }], ownedRun, hash: '#history' });
    await f.bridge.start();
    await assertAllReadRoutes(f, 'history');
    assert.deepEqual(f.mounts, ['original']);
    assert.equal(f.reloads.length, 0);
    await f.emitWindow('pagehide');
  }
});

test('empty App keeps untouched shells, subscribes, and mounts original renderer on first agent-run event', async () => {
  const f = loadBridge();
  await f.bridge.start();
  assert.deepEqual(f.mounts, []);
  assert.equal(f.banner.hidden, true);
  assert.equal(f.banner.textContent, 'Original connection banner');
  assert.equal(f.subscriptions.size, 1);
  assert.equal(f.timers.size, 0, 'empty state waits for storage events, not polling');
  f.setProjects([{ id: 'first' }]);
  f.setOwnedRun({ project: 'first' });
  await f.emitStorage();
  assert.deepEqual(f.mounts, ['original']);
  await f.window.fetch('/api/channels');
  assert.equal(f.apiCalls.at(-1)[0], '/monitor/channels?project=first');
  assert.ok(f.apiCalls.every(([route]) => route.startsWith('/monitor/')));
  await f.emitWindow('pagehide');
});

test('unrelated, invalid, or removed owned-run storage values do not switch to an invented project', async () => {
  const f = loadBridge({ projects: [{ id: 'alpha' }], ownedRun: { project: 'alpha' } });
  await f.bridge.start();
  const reads = f.storageReads.length;
  await f.emitStorage(['unrelated']);
  assert.equal(f.storageReads.length, reads);
  for (const run of [null, { project: '../escape' }, { project: 'missing' }]) {
    f.setOwnedRun(run);
    await f.emitStorage();
  }
  assert.equal(f.reloads.length, 0);
  assert.deepEqual(f.mounts, ['original']);
  await f.emitWindow('pagehide');
});

test('storage changes during initialization are reconciled without losing the latest project', async () => {
  const f = loadBridge({ ownedRun: { project: 'old' } });
  let release;
  let reads = 0;
  const firstRead = new Promise((resolve) => { release = resolve; });
  const mounted = [];
  const reloaded = [];
  const follower = f.bridge.createProjectFollower({
    storage: f.storage,
    loadProjects: () => ++reads === 1 ? firstRead : Promise.resolve([{ id: 'new' }]),
    hash: () => '',
    mountDashboard: async (project) => mounted.push(project),
    reload: (project) => reloaded.push(project),
    onError: (error) => { throw error; },
  });
  const starting = follower.start();
  f.setOwnedRun({ project: 'new' });
  const changed = f.emitStorage();
  release([{ id: 'old' }]);
  await Promise.all([starting, changed]);
  assert.deepEqual(mounted, ['old']);
  assert.deepEqual(reloaded, ['new']);
  follower.dispose();
});

test('theme ready gates monitor/storage/renderer startup and failures use only the original banner', async () => {
  let release;
  const themeReady = new Promise((resolve) => { release = resolve; });
  const f = loadBridge({ themeReady, projects: [{ id: 'current' }] });
  const starting = f.bridge.start();
  await new Promise(setImmediate);
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.storageReads.length, 0);
  assert.equal(f.subscriptions.size, 0);
  assert.deepEqual(f.mounts, []);
  release(); await starting;
  assert.deepEqual(f.mounts, ['original']);
  await f.emitWindow('pagehide');

  let fail;
  const failed = loadBridge({ themeReady: new Promise((resolve, reject) => { fail = reject; }), projects: [{ id: 'current' }] });
  const startup = failed.bridge.start();
  fail(Object.assign(new Error('Unable to load Hana theme'), { uiMessage: 'Unable to load Hana theme' }));
  await startup;
  assert.equal(failed.banner.hidden, false);
  assert.equal(failed.banner.textContent, 'Unable to load Hana theme');
  assert.equal(failed.apiCalls.length, 0);
  assert.equal(failed.storageReads.length, 0);
  assert.deepEqual(failed.mounts, []);
});

test('bootstrap safe errors appear only as text in the original connection banner', async () => {
  const f = loadBridge({ fetchImpl: async () => jsonResponse({ error: { code: 'engine_missing', message: 'Bundled engine unavailable.' } }, 503) });
  await f.bridge.start();
  assert.equal(f.banner.hidden, false);
  assert.equal(f.banner.textContent, 'engine_missing: Bundled engine unavailable.');
  assert.deepEqual(f.mounts, []);
  assert.equal(f.subscriptions.size, 0);
});

test('expired bootstrap requests fail immediately and never send API requests', async () => {
  const f = loadBridge();
  await assert.rejects(f.bridge.requestJson('/monitor/projects', {}, Date.now() - 1), /timed out/);
  assert.equal(f.apiCalls.length, 0);
});

test('project reload changes only the hash and reloads without any task API calls', () => {
  const f = loadBridge();
  f.bridge.reloadForProject(f.window.location, 'beta.v2');
  assert.equal(f.window.location.hash, '#beta.v2');
  assert.deepEqual(f.reloads, ['reload']);
  assert.equal(f.apiCalls.length, 0);
});
