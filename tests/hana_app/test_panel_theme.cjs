const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'apps/hana-danus/ui/assets');
const themeModule = import(pathToFileURL(path.join(assets, 'theme.js')).href);
const css = fs.readFileSync(path.join(assets, 'panel.css'), 'utf8');
// Only the public colour parser is used, not a renderer or a computational experiment.
const vendor = require(path.join(root, 'apps/hana-danus/ui/vendor/echarts.min.js'));
const { color } = vendor;
const light = {
  '--bg': '#f6f6f4', '--bg-card': '#fcfcfb', '--accent': '#5b6b8c', '--accent-hover': '#4a5877', '--accent-light': '#5b6b8c14',
  '--link': '#4a5877', '--link-hover': '#3e4a66', '--text': '#33363b', '--text-light': '#5f646c', '--text-muted': '#83888f',
  '--border': '#c9ccd1', '--shadow': '#33363b17', '--green': '#4f8a6a', '--coral': '#e0857f', '--danger': '#9b4a44',
};
const dark = {
  '--bg': '#17191d', '--bg-card': '#25282e', '--accent': '#b7a6de', '--accent-hover': '#d2bffa', '--accent-light': '#b7a6de26',
  '--link': '#b9caed', '--link-hover': '#d5e1fa', '--text': '#efede8', '--text-light': '#c9c6be', '--text-muted': '#9a9eab',
  '--border': '#454954', '--shadow': '#090b10aa', '--green': '#9acaad', '--coral': '#edb084', '--danger': '#f599a0',
};
const custom = { ...dark, '--bg': '#13282a', '--bg-card': '#193436', '--accent': '#f8c369', '--accent-hover': '#f9db9b', '--text': '#fbf4df', '--border': '#587f7e', '--shadow': '#deedcf33', '--danger': '#e6a9cd' };

const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, declarations]) => ({
  selector: selector.trim(), properties: Object.fromEntries(declarations.split(';').map((line) => line.trim()).filter(Boolean).map((line) => {
    const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  })),
}));
const rootRules = rules.find((rule) => rule.selector === ':root').properties;
const bodyRules = rules.find((rule) => rule.selector === 'body').properties;

// Resolve custom-property inheritance at its defining scope, including nested var fallbacks.
function resolve(value, variables, stack = []) {
  while (value.includes('var(')) {
    const start = value.indexOf('var(');
    let depth = 1;
    let end = start + 4;
    for (; end < value.length && depth; end += 1) {
      if (value[end] === '(') depth += 1;
      if (value[end] === ')') depth -= 1;
    }
    assert.equal(depth, 0, 'balanced CSS var()');
    const inside = value.slice(start + 4, end - 1);
    const comma = inside.indexOf(',');
    const name = (comma < 0 ? inside : inside.slice(0, comma)).trim();
    assert.ok(!stack.includes(name), `no custom-property cycle: ${[...stack, name].join(' -> ')}`);
    const raw = variables[name] ?? (comma < 0 ? '' : inside.slice(comma + 1).trim());
    value = value.slice(0, start) + resolve(raw, variables, [...stack, name]) + value.slice(end);
  }
  return value;
}

function computedTokens(tokens) {
  const variables = { ...tokens, ...rootRules };
  const aliases = Object.fromEntries(Object.keys(rootRules).map((name) => [name, resolve(variables[name], variables)]));
  const inherited = { ...tokens, ...aliases, ...bodyRules };
  return { root: { ...tokens, ...aliases }, body: Object.fromEntries(Object.keys(bodyRules).map((name) => [name, resolve(inherited[name], inherited)])) };
}

const clone = (value) => Array.isArray(value) ? value.map(clone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
function merge(left, right, field = '') {
  if (Array.isArray(right)) return ['series', 'tooltip'].includes(field) ? right.map((item, index) => merge(left?.[index], item)) : clone(right);
  if (!right || typeof right !== 'object') return right;
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) result[key] = merge(left?.[key], value, key);
  return result;
}
function fakeEcharts() {
  const charts = [];
  const inits = [];
  const echarts = {
    color,
    init: function (...args) {
      inits.push({ self: this, args });
      let option = {};
      const chart = {
        calls: [], disposed: false,
        setOption: function (next, ...rest) {
          assert.equal(this, chart, 'setOption receiver preserved');
          chart.calls.push({ option: next, rest });
          option = rest[0] === true || rest[0]?.notMerge ? clone(next) : merge(option, next);
          if (option.series && !Array.isArray(option.series)) option.series = [option.series];
          return 'setOption-result';
        },
        getOption: function () { assert.equal(this, chart); return clone(option); },
        isDisposed: () => chart.disposed,
        dispose() { throw new Error('theme must not dispose'); },
        on() { throw new Error('theme must not change handlers'); },
        off() { throw new Error('theme must not change handlers'); },
        resize() { throw new Error('theme must not resize'); },
      };
      charts.push(chart);
      return chart;
    },
  };
  return { echarts, charts, inits };
}

function stylesheetTokens(text) {
  return Object.fromEntries([...text.matchAll(/:root\s*\{([^}]*)\}/g)].flatMap(([, body]) => body.split(';').map((line) => {
    const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }).filter(([name]) => name.startsWith('--'))));
}
const themeCss = (tokens) => `:root { ${Object.entries(tokens).map(([name, value]) => `${name}: ${value};`).join(' ')} }`;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const cssResponse = (text, ok = true) => ({ ok, text: async () => text });
const turn = () => new Promise(setImmediate);

function fixture(tokens = light, initialSnapshot = { theme: 'same-id', cssUrl: 'host-owned-url', appearance: 'light' }) {
  const library = fakeEcharts();
  let currentTokens = tokens;
  let snapshot = { ...initialSnapshot };
  let snapshotReads = 0;
  let nextFrame = 0;
  const frames = new Map();
  const subscribers = new Set();
  const handlers = new Map();
  const headHandlers = new Map();
  const observers = [];
  const styleWrites = [];
  const timers = new Map();
  const mutate = (records) => { for (const observer of observers) if (!observer.disconnected) observer.callback(records); };
  const add = (target, type, callback) => { const callbacks = target.get(type) || new Set(); callbacks.add(callback); target.set(type, callbacks); };
  const document = {
    documentElement: { nodeName: 'HTML', matches: (selector) => selector.split(',').some((part) => [':root', 'html'].includes(part.trim())) }, body: Object.freeze({ nodeName: 'BODY' }),
    head: {
      nodeName: 'HEAD', children: [],
      addEventListener: (type, callback) => add(headHandlers, type, callback), removeEventListener: (type, callback) => headHandlers.get(type)?.delete(callback),
      appendChild(node) {
        const previous = this.children.indexOf(node);
        if (previous >= 0) this.children.splice(previous, 1);
        this.children.push(node); node.parentElement = this;
        mutate([{ type: 'childList', target: this, addedNodes: [node] }]);
        return node;
      },
    },
    createElement(tag) {
      assert.ok(['style', 'link'].includes(tag));
      let text = '';
      const sheet = {
        disabled: false,
        get cssRules() {
          return [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selectorText, body]) => {
            const tokens = Object.fromEntries(body.split(';').filter((line) => line.includes(':')).map((line) => {
              const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
            }));
            return { selectorText: selectorText.trim(), style: { getPropertyValue: (name) => tokens[name] || '' } };
          });
        },
      };
      return {
        nodeName: tag.toUpperCase(), attributes: {}, media: '', loaded: tag === 'style',
        get sheet() { return this.loaded ? sheet : null; },
        get textContent() { return text; },
        set textContent(value) { text = value; mutate([{ type: 'characterData', target: this }]); },
        setAttribute(name, value) { this.attributes[name] = value; },
        remove() {
          const index = document.head.children.indexOf(this);
          if (index >= 0) {
            document.head.children.splice(index, 1);
            mutate([{ type: 'childList', target: document.head, removedNodes: [this] }]);
          }
        },
      };
    },
    querySelector(selector) {
      const attribute = selector.match(/^style\[([^\]]+)\]$/)?.[1];
      assert.ok(attribute, 'the bundled SDK may query its own style generically');
      return document.head.children.find((node) => Object.hasOwn(node.attributes, attribute)) || null;
    },
  };
  let colorScheme = '';
  const writeScheme = (value) => {
    colorScheme = value;
    styleWrites.push(value);
    // Real root style writes are observable too; an unconditional writer would loop/churn here.
    for (const observer of observers) if (!observer.disconnected) observer.callback([{ type: 'attributes', target: document.documentElement, attributeName: 'style' }]);
  };
  document.documentElement.style = {
    get colorScheme() { return colorScheme; },
    set colorScheme(value) { writeScheme(value); },
    removeProperty(name) { assert.equal(name, 'color-scheme'); const previous = colorScheme; writeScheme(''); return previous; },
  };
  const window = {
    document, echarts: library.echarts,
    getComputedStyle(element) {
      const effective = Object.assign({}, currentTokens, ...document.head.children.filter((node) => node.sheet && !node.sheet.disabled && (!node.media || this.matchMedia(node.media).matches)).map((node) => stylesheetTokens(node.textContent)));
      const resolved = computedTokens(effective);
      const scope = element === document.documentElement ? resolved.root : { ...resolved.root, ...resolved.body };
      return {
        getPropertyValue: (name) => resolve(scope[name] || '', scope),
        color: effective['--text'] || 'rgb(0, 0, 0)', backgroundColor: effective['--bg'] || 'rgb(255, 255, 255)',
      };
    },
    matchMedia: (media) => ({ matches: media !== 'not all' }),
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener: (type, callback) => add(handlers, type, callback),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
      observe(target, options) { this.targets.push({ target, options }); }
      disconnect() { this.disconnected = true; }
    },
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    removeEventListener: (type, callback) => handlers.get(type)?.delete(callback),
    fetch() { throw new Error('Unexpected initial theme request'); },
  };
  const hana = { theme: {
    getSnapshot() { snapshotReads += 1; return snapshot; },
    subscribe(callback) { subscribers.add(callback); callback(snapshot); return () => subscribers.delete(callback); },
  } };
  return {
    ...library, document, window, hana, frames, subscribers, observers, handlers, headHandlers, styleWrites, timers,
    expireTimers() { const pending = [...timers.values()]; timers.clear(); for (const { callback } of pending) callback(); },
    get snapshotReads() { return snapshotReads; },
    setTokens(value) { currentTokens = value; },
    notify(next = snapshot) { snapshot = next; for (const callback of subscribers) callback(snapshot); },
    mutate(records = [{ type: 'characterData', target: { parentElement: { nodeName: 'STYLE' } } }]) { for (const observer of observers) if (!observer.disconnected) observer.callback(records); },
    flush() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    event(type, event = {}) { for (const callback of handlers.get(type) || []) callback(event); },
    headLoad() { for (const callback of headHandlers.get('load') || []) callback({ target: { nodeName: 'LINK' } }); },
  };
}

function bundledSdk(f, cssUrl) {
  const callbacks = new Set();
  const sent = [];
  const errors = [];
  const url = new URL('https://hana.local/api/apps/hana-danus/ui/panel.html');
  url.searchParams.set('hana-theme', 'fixture-classic');
  if (cssUrl !== undefined) url.searchParams.set('hana-css', cssUrl);
  url.searchParams.set('hana-theme-appearance', 'light');
  f.window.location = url;
  const sdkSource = fs.readFileSync(path.join(assets, 'sdk.js'), 'utf8');
  const context = {
    window: f.window, URL, URLSearchParams, Headers, AbortController, TextEncoder, TextDecoder,
    fetch: (...args) => f.window.fetch(...args),
    console: { error: (...args) => errors.push(args) },
  };
  // Exercise the bundled public factory without modifying SDK source or using host I/O.
  vm.runInNewContext(sdkSource.replace(/\nexport \{[\s\S]*?\};\s*$/, '\nglobalThis.factory = createHanaAppUiSdk;'), context, { filename: 'bundled-sdk.js' });
  const hana = context.factory({
    targetWindow: f.window, targetOrigin: url.origin,
    messageTransport: {
      postMessage(message) { sent.push(message); },
      onMessage(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    },
  });
  return {
    hana, sent, errors,
    change(payload) { for (const callback of callbacks) callback({ protocol: 'hana.plugin.ui', version: 1, kind: 'event', type: 'hana.theme.changed', payload }); },
  };
}

function graph() {
  return {
    tooltip: { formatter: (item) => item.data.id, padding: 7, textStyle: { fontSize: 13 }, shadowBlur: 12 },
    series: [{
      id: 'facts', type: 'graph', layout: 'force', roam: true, draggable: true, zoom: 1.75, center: [120, 90],
      force: { repulsion: 160, edgeLength: 80, gravity: 0.06 },
      label: { show: false }, emphasis: { focus: 'adjacency', label: { show: false } },
      lineStyle: { color: '#cbd5e1', width: 1, opacity: 0.55, curveness: 0.05 }, edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 5,
      data: [
        { id: 'root', depth: 0, name: 'Root', author: 'worker', x: 20, y: 30, fixed: true, symbolSize: 6, itemStyle: { color: 'hsl(248,50%,80%)', opacity: 0.9 } },
        { id: 'middle', depth: 1, name: 'Middle', author: 'worker', symbolSize: 8, itemStyle: { color: 'hsl(248,60%,60%)' } },
        { id: 'deep', depth: 3, name: 'Deep', author: 'worker', symbolSize: 12, itemStyle: { color: 'hsl(248,76%,28%)' } },
      ],
      links: [{ source: 'root', target: 'middle', value: 'dependency' }, { source: 'middle', target: 'deep' }],
    }],
  };
}

const colourKeys = new Set(['color', 'backgroundColor', 'borderColor', 'shadowColor', 'textBorderColor', 'textShadowColor']);
function nonColours(value) {
  if (Array.isArray(value)) return value.map(nonColours);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (colourKeys.has(key)) continue;
    const stripped = nonColours(item);
    if (stripped && typeof stripped === 'object' && !Array.isArray(stripped) && !Object.keys(stripped).length) continue;
    result[key] = stripped;
  }
  return result;
}
const nativeColour = (value) => { assert.match(value, /^rgba?\([\d., ]+\)$/); assert.ok(color.parse(value)); };

test('CSS maps all host theme tokens without shadowing root tokens or changing any layout property', () => {
  assert.ok(Object.keys(rootRules).filter((name) => name.startsWith('--')).every((name) => name.startsWith('--danus-')));
  for (const rule of rules) for (const name of Object.keys(rule.properties)) {
    assert.ok(name.startsWith('--') || ['color', 'background', 'border-color', 'scrollbar-color', 'outline-color'].includes(name), `${name} is colour-only`);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\(\s*[\d.]/i);
  for (const tokens of [light, dark, custom]) {
    const result = computedTokens(tokens);
    for (const [upstream, host] of Object.entries({
      '--bg-primary': '--bg-card', '--bg-secondary': '--bg', '--text-primary': '--text', '--text-secondary': '--text-light',
      '--text-muted': '--text-muted', '--border': '--border', '--accent': '--accent', '--accent-strong': '--accent-hover',
      '--accent-bg': '--accent-light', '--blue': '--link', '--green': '--green', '--orange': '--coral', '--red': '--danger',
    })) assert.equal(result.body[upstream], tokens[host], `${upstream} follows ${host}`);
    for (const value of Object.values(result.body)) assert.ok(!value.includes('var('), 'all upstream aliases resolve, including colliding names');
  }
});

test('CSS covers inherited links/hover, status rgba literals, original inline legend, banner text and KaTeX error', () => {
  const rule = (selector) => rules.find((item) => item.selector === selector).properties;
  assert.equal(rule('body a, body a:visited').color, 'var(--danus-link)');
  assert.equal(rule('body a:hover').color, 'var(--danus-link-hover)');
  assert.equal(rule('.pred-link:hover, .more:hover').color, 'var(--danus-hover)');
  assert.equal(rule('.conn-banner').color, 'var(--danus-text)');
  assert.ok(rule('.conn-banner').background.includes('--danus-danger'));
  for (const [selector, token] of [['.tag.correct', '--danus-success'], ['.tag.wrong', '--danus-danger'], ['.tag.cost', '--danus-warning']]) {
    assert.ok(rule(selector)['border-color'].includes(token));
    assert.ok(rule(selector).background.includes(token));
    assert.ok(rule(selector).background.includes('--danus-card'));
  }
  assert.match(rule('.graph-toolbar > .legend + span[style]').background, /linear-gradient.*--danus-graph-low.*--danus-graph-high.*!important/);
  assert.equal(rule('.katex-error').color, 'var(--danus-danger) !important');
  assert.match(rootRules['scrollbar-color'], /--danus-accent.*--danus-border.*--danus-bg/);
  assert.equal(rule('::selection').color, 'var(--danus-text)');
  assert.match(rule('::selection').background, /--danus-accent.*--danus-card/);
  assert.deepEqual(rule(':focus-visible'), { 'outline-color': 'var(--danus-hover)' });
});

test('bundled SDK cold ready makes no CSS request; the App initial bridge supplies canonical colours before rendering', async (t) => {
  const { startDashboardTheme, readThemePalette } = await themeModule;
  const originalCss = fs.readFileSync(path.join(root, 'danus/observability/static/style.css'), 'utf8');
  const f = fixture({ ...stylesheetTokens(originalCss), '--hana-text': '#f0bb99' });
  const pending = deferred();
  const calls = [];
  const cssUrl = 'https://hana.local/api/apps/theme.css?theme=fixture%3Aclassic&opaque=%2F%20';
  f.window.fetch = (url, options) => { calls.push({ url, options }); return pending.promise; };
  const sdk = bundledSdk(f, cssUrl);
  await sdk.hana.ready();
  const unsubscribe = sdk.hana.theme.subscribe(() => {});
  unsubscribe();
  assert.equal(sdk.hana.theme.getSnapshot().cssUrl, cssUrl);
  assert.equal(sdk.sent[0].type, 'hana.ready');
  assert.equal(calls.length, 0, 'default SDK initial ready/subscription never follows its initial cssUrl');
  assert.equal(f.document.head.children.length, 0);
  assert.equal(f.window.getComputedStyle(f.document.body).getPropertyValue('--accent'), '#6366f1');

  const echarts = { ...vendor };
  f.window.echarts = echarts;
  const controller = startDashboardTheme(sdk.hana, f.window, f.document);
  let ready = false; controller.ready.then(() => { ready = true; }, () => {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, cssUrl, 'consume the public URL byte-for-byte');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(f.document.head.children[0].textContent, '', 'reserve cascade position before network completion');
  await turn(); assert.equal(ready, false);
  pending.resolve(cssResponse(themeCss({ ...light, '--hana-text': '#f0bb99' })));
  await controller.ready; f.flush();
  assert.equal(f.timers.size, 0);
  const body = f.window.getComputedStyle(f.document.body);
  assert.equal(body.getPropertyValue('--bg-secondary'), light['--bg']);
  assert.equal(body.getPropertyValue('--accent'), light['--accent']);
  assert.deepEqual(readThemePalette(echarts, f.document, f.window).text, color.parse(light['--text']), 'chat --hana-text must not override canonical --text');
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 400, height: 300 });
  t.after(() => chart.dispose());
  const option = graph(); option.animation = false; option.series[0].layout = 'none';
  option.series[0].data.forEach((node, index) => { node.x = index * 40; node.y = index * 30; });
  chart.setOption(option);
  assert.equal(chart.getOption().series[0].data[0].itemStyle.color, 'rgb(204, 209, 218)');
  assert.ok(chart.renderToSVGString().replace(/\s/g, '').includes('rgb(204,209,218)'));
  const initialStyle = f.document.head.children[0];
  assert.equal(startDashboardTheme(sdk.hana, f.window, f.document), controller);
  f.event('pagehide', { persisted: true });
  assert.equal(f.frames.size, 0);
  assert.ok(f.observers.every((observer) => observer.disconnected));
  f.event('pageshow', { persisted: true }); f.flush();
  await controller.ready;
  assert.equal(f.document.head.children[0], initialStyle);
  assert.equal(calls.length, 1, 'repeated starts and bfcache restore never repeat the initial request');
  assert.equal(sdk.errors.length, 0);
  controller.stop();
});

test('initial optional native tokens retire only after the later bundled SDK stylesheet actually applies', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture({}); const next = deferred(); let calls = 0;
  const warm = { '--bg': '#f5efe2', '--text': '#483e34', '--accent': '#987653' };
  f.window.fetch = () => {
    calls += 1;
    return calls === 1 ? Promise.resolve(cssResponse(themeCss({ ...light, '--old-only-colour': '#123456' }))) : next.promise;
  };
  const sdk = bundledSdk(f, '/initial.css');
  const controller = startDashboardTheme(sdk.hana, f.window, f.document);
  await controller.ready; f.flush();
  const initialStyle = f.document.head.children[0];
  const chart = f.echarts.init({}); chart.setOption(graph());
  const native = (name) => f.window.getComputedStyle(f.document.documentElement).getPropertyValue(name);
  assert.equal(native('--link'), light['--link']);
  sdk.change({ theme: 'warm-paper', cssUrl: '/later.css', appearance: 'light' });
  f.flush();
  assert.ok(f.document.head.children.includes(initialStyle), 'notification alone must not remove the only applied theme');
  assert.equal(native('--bg'), light['--bg']);
  assert.equal(native('--link'), light['--link']);
  next.resolve(cssResponse(themeCss(warm))); await turn(); f.flush(); f.flush();
  assert.equal(f.document.head.children.length, 1);
  assert.ok(!f.document.head.children.includes(initialStyle));
  assert.equal(native('--link'), '', 'old native optional colour must really disappear');
  assert.equal(native('--old-only-colour'), '');
  assert.equal(native('--bg'), warm['--bg']);
  assert.equal(native('--danus-link'), warm['--accent'], 'alias now falls back to the new accent');
  assert.equal(f.window.getComputedStyle(f.document.body).getPropertyValue('--blue'), warm['--accent']);
  assert.equal(chart.getOption().series[0].itemStyle.color, 'rgb(152, 118, 83)');
  assert.equal(f.frames.size, 0, 'retirement mutation settles instead of creating a RAF loop');
  const merges = chart.calls.length;
  sdk.change({ theme: 'warm-paper', cssUrl: '/later.css', appearance: 'light' });
  await turn(); f.flush(); f.flush();
  assert.equal(chart.calls.length, merges, 'repeated identical SDK styles do not merge again');
  assert.equal(f.frames.size, 0);
  assert.equal(f.observers.length, 1);
  assert.equal(f.headHandlers.get('load').size, 1);
  assert.equal(sdk.errors.length, 0);
  controller.stop();
});

test('only a later active host sheet that can stand independently retires initial CSS', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture({});
  f.window.fetch = async () => cssResponse(themeCss({ ...light, '--initial-only-bg': light['--bg'], '--initial-only-text': light['--text'] }));
  const controller = startDashboardTheme(f.hana, f.window, f.document);
  await controller.ready; f.flush();
  const initialStyle = f.document.head.children[0];
  for (const text of [':root { --danus-bg: var(--bg); --danus-text: var(--text); }', 'body { --bg: red; --text: blue; }', ':root { --bg: red; }', ':root { --bg: var(--initial-only-bg); --text: var(--initial-only-text); }']) {
    const style = f.document.createElement('style'); style.textContent = text; f.document.head.appendChild(style); f.flush();
    assert.ok(f.document.head.children.includes(initialStyle));
    assert.equal(f.window.getComputedStyle(f.document.documentElement).getPropertyValue('--text'), light['--text'], 'an unsuccessful handoff probe restores the initial sheet');
    style.remove(); f.flush();
  }
  const later = f.document.createElement('style'); later.media = 'not all';
  later.textContent = themeCss({ '--bg': dark['--bg'], '--text': dark['--text'], '--accent': dark['--accent'] });
  f.document.head.appendChild(later); f.flush();
  assert.ok(f.document.head.children.includes(initialStyle));
  assert.equal(f.window.getComputedStyle(f.document.documentElement).getPropertyValue('--bg'), light['--bg']);
  later.media = ''; later.sheet.disabled = true;
  f.mutate([{ type: 'attributes', target: later }]); f.flush();
  assert.ok(f.document.head.children.includes(initialStyle));
  later.sheet.disabled = false;
  f.mutate([{ type: 'attributes', target: later }]); f.flush(); f.flush();
  assert.ok(!f.document.head.children.includes(initialStyle));
  assert.equal(f.window.getComputedStyle(f.document.documentElement).getPropertyValue('--link'), '');
  assert.equal(f.frames.size, 0);
  assert.equal(f.subscribers.size, 1);
  controller.stop();
});

test('a later host stylesheet link retires initial CSS only once its public rules are loaded', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture({}); f.window.fetch = async () => cssResponse(themeCss(light));
  const controller = startDashboardTheme(f.hana, f.window, f.document);
  await controller.ready; f.flush();
  const initialStyle = f.document.head.children[0];
  const link = f.document.createElement('link');
  link.textContent = themeCss({ '--bg': custom['--bg'], '--text': custom['--text'], '--accent': custom['--accent'] });
  f.document.head.appendChild(link); f.headLoad(); f.flush();
  assert.ok(f.document.head.children.includes(initialStyle), 'unloaded sheet does not establish a replacement');
  link.loaded = true; f.headLoad(); f.flush(); f.flush();
  assert.ok(!f.document.head.children.includes(initialStyle));
  const rootStyle = f.window.getComputedStyle(f.document.documentElement);
  assert.equal(rootStyle.getPropertyValue('--link'), '');
  assert.equal(rootStyle.getPropertyValue('--danus-link'), custom['--accent']);
  assert.equal(rootStyle.getPropertyValue('--bg'), custom['--bg']);
  assert.equal(f.frames.size, 0);
  assert.equal(f.headHandlers.get('load').size, 1);
  controller.stop();
});

test('a slow initial response fills only its retired orphan without reviving optional colours after a later SDK theme', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture({});
  const initial = deferred();
  const calls = [];
  const nextTheme = { ...dark }; delete nextTheme['--link']; delete nextTheme['--link-hover'];
  f.window.fetch = (url) => {
    calls.push(url);
    return calls.length === 1 ? initial.promise : Promise.resolve(cssResponse(themeCss(calls.length === 2 ? nextTheme : custom)));
  };
  const sdk = bundledSdk(f, '/public-initial.css?opaque=fixture');
  sdk.hana.ready();
  const controller = startDashboardTheme(sdk.hana, f.window, f.document);
  const first = f.document.head.children[0];
  sdk.change({ theme: 'new-theme', cssUrl: '/public-new.css', appearance: 'dark' });
  await turn(); f.flush(); f.flush();
  assert.equal(f.document.head.children.length, 1);
  assert.ok(!f.document.head.children.includes(first));
  assert.equal(f.window.getComputedStyle(f.document.body).getPropertyValue('--bg-secondary'), dark['--bg']);
  initial.resolve(cssResponse(themeCss(light)));
  await controller.ready; f.flush();
  assert.equal(first.textContent, themeCss(light));
  assert.ok(!f.document.head.children.includes(first), 'late initial completion must not append its retired style');
  assert.equal(f.document.head.children.length, 1);
  assert.equal(f.window.getComputedStyle(f.document.documentElement).getPropertyValue('--link'), '');
  assert.equal(f.window.getComputedStyle(f.document.documentElement).getPropertyValue('--danus-link'), dark['--accent']);
  assert.equal(f.window.getComputedStyle(f.document.body).getPropertyValue('--bg-secondary'), dark['--bg']);
  const chart = f.echarts.init({}); chart.setOption(graph());
  assert.equal(chart.getOption().series[0].itemStyle.color, 'rgb(183, 166, 222)');
  sdk.change({ theme: 'new-theme', cssUrl: '/public-edited.css', appearance: 'dark' });
  await turn(); f.flush();
  assert.equal(chart.getOption().series[0].itemStyle.color, 'rgb(248, 195, 105)');
  assert.equal(f.window.getComputedStyle(f.document.body).getPropertyValue('--accent'), custom['--accent']);
  assert.equal(calls.length, 3, 'one initial App request; later requests remain SDK-owned');
  assert.equal(sdk.errors.length, 0);
  controller.stop();
});

test('initial bridge skips already-applied canonical App tokens, never mistakes chat tokens for an App palette, and never guesses a URL', async () => {
  const { startDashboardTheme } = await themeModule;
  const applied = fixture({ ...light, '--hana-text': '#f0bb99' }, {});
  const controller = startDashboardTheme(applied.hana, applied.window, applied.document);
  await controller.ready;
  assert.equal(applied.document.head.children.length, 0);
  assert.equal(applied.timers.size, 0);
  controller.stop();
  for (const snapshot of [{}, { cssUrl: '' }, { cssUrl: '   ' }]) {
    const f = fixture({ '--hana-text': '#f0bb99' }, snapshot);
    const missing = startDashboardTheme(f.hana, f.window, f.document);
    await assert.rejects(missing.ready, { message: 'Unable to load Hana theme', uiMessage: 'Unable to load Hana theme' });
    assert.equal(f.document.head.children.length, 0);
    assert.equal(f.timers.size, 0);
    missing.stop();
  }
});

test('initial theme HTTP/network/empty/not-found/invalid CSS failures reject safely and release resources', async () => {
  const { startDashboardTheme } = await themeModule;
  const failures = [
    async () => { throw new Error('private host URL and transport details'); },
    async () => ({ ok: false, text() { throw new Error('HTTP failure body must not be read'); } }),
    ...['', '  \n ', '/* Theme not found */', ':root {} /* theme-not-found */', '/* only comments */', '<html>Login required</html>', ':root { --hana-text: pink; }'].map((text) => async () => cssResponse(text)),
  ];
  for (const fetch of failures) {
    const f = fixture({}); let signal;
    f.window.fetch = (url, options) => { signal = options.signal; return fetch(); };
    const controller = startDashboardTheme(f.hana, f.window, f.document);
    await assert.rejects(controller.ready, (error) => {
      assert.equal(error.message, 'Unable to load Hana theme');
      assert.equal(error.uiMessage, 'Unable to load Hana theme');
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(signal.aborted, true, 'failure also aborts any unconsumed response body');
    assert.equal(f.timers.size, 0);
    assert.equal(f.document.head.children.length, 0);
    controller.stop();
    assert.equal(f.frames.size, 0);
    assert.equal(f.subscribers.size, 0);
  }
});

test('initial theme timeout bounds both fetch and body consumption and ignores late completion', async () => {
  const { startDashboardTheme } = await themeModule;
  for (const hangBody of [false, true]) {
    const f = fixture({}); const pending = deferred(); let signal;
    f.window.fetch = async (url, options) => { signal = options.signal; return hangBody ? { ok: true, text: () => pending.promise } : pending.promise; };
    const controller = startDashboardTheme(f.hana, f.window, f.document);
    await turn();
    assert.deepEqual([...f.timers.values()].map(({ delay }) => delay), [10000]);
    f.expireTimers();
    await assert.rejects(controller.ready, { uiMessage: 'Unable to load Hana theme' });
    assert.equal(signal.aborted, true);
    pending.resolve(hangBody ? themeCss(light) : cssResponse(themeCss(light)));
    await turn();
    assert.equal(f.document.head.children.length, 0);
    assert.equal(f.window.getComputedStyle(f.document.documentElement).getPropertyValue('--bg'), '');
    assert.equal(f.timers.size, 0);
    controller.stop();
  }
});

test('persisted pagehide preserves pending initial ready; pageshow resumes one subscription and the same successful load', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture({}); const pending = deferred(); let calls = 0; let signal;
  f.window.fetch = (url, options) => { calls += 1; signal = options.signal; return pending.promise; };
  const controller = startDashboardTheme(f.hana, f.window, f.document);
  const ready = controller.ready;
  const timer = [...f.timers.keys()][0];
  const initialStyle = f.document.head.children[0];
  let settled = false; ready.then(() => { settled = true; }, () => { settled = true; });
  f.event('pagehide', { persisted: true }); await turn();
  assert.equal(signal.aborted, false);
  assert.equal(settled, false, 'a bfcache pause must not reject the bootstrap promise');
  assert.equal(f.timers.get(timer).delay, 10000, 'the original bound remains active');
  assert.equal(f.frames.size, 0);
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.headHandlers.get('load').size, 0);
  assert.ok(f.observers.every((observer) => observer.disconnected));
  f.event('pageshow', { persisted: true });
  f.event('pageshow', { persisted: true });
  assert.equal(startDashboardTheme(f.hana, f.window, f.document).ready, ready);
  assert.deepEqual([...f.timers.keys()], [timer], 'restore does not reset the initial timeout');
  assert.equal(f.subscribers.size, 1);
  assert.equal(f.headHandlers.get('load').size, 1);
  assert.equal(f.observers.filter((observer) => !observer.disconnected).length, 1);
  assert.equal(f.observers.length, 2, 'duplicate restore/start does not add listeners');
  pending.resolve(cssResponse(themeCss(light))); await ready; f.flush();
  assert.equal(settled, true);
  assert.equal(signal.aborted, false);
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.document.head.children, [initialStyle]);
  const body = f.window.getComputedStyle(f.document.body);
  assert.equal(body.getPropertyValue('--bg-secondary'), light['--bg']);
  assert.equal(body.getPropertyValue('--accent'), light['--accent']);
  const chart = f.echarts.init({}); chart.setOption(graph());
  assert.equal(chart.getOption().series[0].itemStyle.color, 'rgb(91, 107, 140)');
  assert.equal(f.subscribers.size, 1);
  assert.equal(f.frames.size, 0);
  controller.stop();
  assert.equal(f.subscribers.size, 0);
});

test('nonpersisted pagehide and explicit stop still abort unfinished initial loads and ignore late CSS', async () => {
  const { startDashboardTheme } = await themeModule;
  for (const explicit of [false, true]) {
    const f = fixture({}); const pending = deferred(); let calls = 0; let signal;
    f.window.fetch = (url, options) => { calls += 1; signal = options.signal; return pending.promise; };
    const controller = startDashboardTheme(f.hana, f.window, f.document);
    if (explicit) controller.stop();
    else f.event('pagehide', { persisted: false });
    await assert.rejects(controller.ready, { uiMessage: 'Unable to load Hana theme' });
    assert.equal(signal.aborted, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.frames.size, 0);
    assert.equal(f.subscribers.size, 0);
    assert.equal(f.headHandlers.get('load').size, 0);
    assert.ok(f.observers.every((observer) => observer.disconnected));
    pending.resolve(cssResponse(themeCss(light))); await turn();
    assert.equal(calls, 1);
    assert.equal(f.document.head.children.length, 0);
    assert.equal(f.window.getComputedStyle(f.document.documentElement).getPropertyValue('--bg'), '');
  }
});

test('a bfcache pause or restore never removes or resets the bounded initial theme timeout', async () => {
  const { startDashboardTheme } = await themeModule;
  for (const restoreBeforeTimeout of [false, true]) {
    const f = fixture({}); let calls = 0; let signal;
    f.window.fetch = (url, options) => { calls += 1; signal = options.signal; return new Promise(() => {}); };
    const controller = startDashboardTheme(f.hana, f.window, f.document);
    const ready = controller.ready;
    const timer = [...f.timers.keys()][0];
    f.event('pagehide', { persisted: true });
    if (restoreBeforeTimeout) f.event('pageshow', { persisted: true });
    assert.deepEqual([...f.timers.keys()], [timer]);
    assert.equal(f.timers.get(timer).delay, 10000);
    f.expireTimers();
    await assert.rejects(ready, { uiMessage: 'Unable to load Hana theme' });
    assert.equal(controller.ready, ready);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.document.head.children.length, 0);
    controller.stop();
  }
});

test('initial colour scheme uses only public light/dark appearance and otherwise leaves CSS defaults', async () => {
  const { startDashboardTheme } = await themeModule;
  for (const [snapshot, expected] of [
    [{ theme: 'custom', appearance: 'dark' }, 'dark'],
    [{ theme: 'custom-dark-name', appearance: 'light' }, 'light'],
    [{ theme: 'custom-dark-name' }, ''],
    [{ theme: 'custom-light-name', appearance: 'auto' }, ''],
  ]) {
    const f = fixture(light, snapshot);
    const controller = startDashboardTheme(f.hana, f.window, f.document);
    assert.equal(f.document.documentElement.style.colorScheme, expected);
    assert.deepEqual(f.styleWrites, expected ? [expected] : [], 'snapshot plus immediate subscription does not duplicate style writes');
    assert.equal(f.frames.size, 1);
    f.flush();
    assert.equal(f.frames.size, 0, 'root-style observation settles after one coalesced frame');
    f.mutate([{ type: 'attributes', target: f.document.documentElement, attributeName: 'style' }]);
    f.flush();
    assert.equal(f.frames.size, 0);
    assert.deepEqual(f.styleWrites, expected ? [expected] : []);
    controller.stop();
  }
});

test('same theme ID appearance transitions clear missing/invalid metadata without redundant chart updates or RAF loops', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  const controller = startDashboardTheme(f.hana, f.window, f.document);
  const chart = f.echarts.init({}); chart.setOption(graph()); f.flush();
  for (const appearance of ['dark', 'dark', 'light', undefined, 'auto']) {
    f.notify({ theme: 'same-id', appearance });
    const expected = ['light', 'dark'].includes(appearance) ? appearance : '';
    assert.equal(f.document.documentElement.style.colorScheme, expected);
    f.flush();
    assert.equal(f.frames.size, 0);
    assert.equal(chart.calls.length, 1, 'scheme-only changes do not recolour unchanged graph visuals');
  }
  assert.deepEqual(f.styleWrites, ['light', 'dark', 'light', '']);
  f.notify({ theme: 'light-name-is-not-authoritative', appearance: 'dark' });
  f.flush();
  assert.equal(f.document.documentElement.style.colorScheme, 'dark');
  assert.deepEqual(f.styleWrites, ['light', 'dark', 'light', '', 'dark']);
  assert.equal(f.frames.size, 0);
  controller.stop();
});

test('light, dark and custom themes produce native graph colours and preserve all non-colour data/layout/options', async () => {
  const { startDashboardTheme } = await themeModule;
  for (const tokens of [light, dark, custom]) {
    const f = fixture(tokens);
    startDashboardTheme(f.hana, f.window, f.document);
    const args = [{ id: 'graph-dom' }, null, { renderer: 'canvas', width: 700 }];
    const chart = f.echarts.init(...args);
    assert.equal(f.inits[0].self, f.echarts);
    assert.deepEqual(f.inits[0].args, args);
    const original = graph();
    const before = clone(original);
    const opts = { notMerge: false, lazyUpdate: false };
    assert.equal(chart.setOption(original, opts, 'extra'), 'setOption-result');
    const option = chart.getOption();
    assert.deepEqual(chart.calls[0].rest, [opts, 'extra']);
    assert.deepEqual(original, before, 'input never mutated');
    assert.deepEqual(nonColours(option), nonColours(original), 'only colours differ');
    assert.equal(option.tooltip.formatter, original.tooltip.formatter);
    assert.equal(option.series[0].data[0].itemStyle.opacity, 0.9);
    assert.notEqual(option.series[0].data[0].itemStyle.color, option.series[0].data[2].itemStyle.color);
    for (const node of option.series[0].data) {
      nativeColour(node.itemStyle.color);
      for (const state of ['emphasis', 'blur', 'select']) {
        nativeColour(node[state].itemStyle.color);
        nativeColour(node[state].label.color);
      }
    }
    assert.equal(option.series[0].emphasis.lineStyle.color, `rgb(${color.parse(tokens['--accent-hover']).slice(0, 3).join(', ')})`);
    assert.equal(option.tooltip.backgroundColor, `rgb(${color.parse(tokens['--bg-card']).slice(0, 3).join(', ')})`);
    assert.equal(option.tooltip.textStyle.color, `rgb(${color.parse(tokens['--text']).slice(0, 3).join(', ')})`);
    nativeColour(option.tooltip.shadowColor);
    nativeColour(option.series[0].lineStyle.color);
    nativeColour(option.series[0].links[0].emphasis.lineStyle.color);
    f.flush();
    assert.equal(chart.calls.length, 1, 'unchanged applied colours do not resend options');
  }
});

test('non-graph charts pass through unchanged and repeat installation does not wrap init/setOption again', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  const controller = startDashboardTheme(f.hana, f.window, f.document);
  const wrappedInit = f.echarts.init;
  assert.equal(startDashboardTheme(f.hana, f.window, f.document), controller);
  assert.equal(f.echarts.init, wrappedInit);
  assert.equal(f.subscribers.size, 1);
  const chart = f.echarts.init({});
  const setOption = chart.setOption;
  const option = { tooltip: { backgroundColor: '#fff' }, series: [{ type: 'bar', data: [2], itemStyle: { color: '#123456' } }] };
  assert.equal(chart.setOption(option, true, false), 'setOption-result');
  assert.equal(chart.calls[0].option, option);
  assert.deepEqual(chart.calls[0].rest, [true, false]);
  f.setTokens(dark); f.notify(); f.flush();
  assert.equal(chart.calls.length, 1);
  assert.equal(chart.setOption, setOption);
});

test('notify-before-CSS race and same theme ID colour edits refresh after head mutation, not by ID', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  startDashboardTheme(f.hana, f.window, f.document);
  const chart = f.echarts.init({});
  const raw = graph();
  chart.setOption(raw);
  f.flush();
  const old = chart.getOption();
  f.notify({ theme: 'same-id', appearance: 'dark', cssUrl: 'sdk-loads-this' });
  assert.equal(f.document.documentElement.style.colorScheme, 'dark', 'public appearance applies before asynchronous CSS');
  assert.deepEqual(f.styleWrites, ['light', 'dark']);
  f.flush();
  assert.equal(f.frames.size, 0, 'the observed root style write cannot sustain a RAF loop');
  assert.equal(chart.calls.length, 1, 'notification alone still reads old CSS');
  f.setTokens(dark);
  f.mutate(); f.mutate(); f.notify();
  assert.equal(f.frames.size, 1, 'head mutations and notifications coalesce in one RAF');
  f.flush();
  assert.equal(chart.calls.length, 2);
  const darkOption = chart.getOption();
  assert.notEqual(darkOption.series[0].data[0].itemStyle.color, old.series[0].data[0].itemStyle.color);
  assert.deepEqual(nonColours(darkOption), nonColours(raw));
  const patch = chart.calls[1].option;
  // Options/identity stay intact; public setOption can still resume force convergence from existing points.
  assert.ok(!Object.keys(patch.series[0]).some((key) => ['layout', 'force', 'roam', 'zoom', 'center', 'type'].includes(key)));
  assert.ok(!('formatter' in patch.tooltip));
  assert.ok(!('padding' in patch.tooltip));
  assert.ok(!('focus' in patch.series[0].emphasis));
  assert.deepEqual(chart.calls[1].rest, [{ lazyUpdate: true, silent: true }]);
  f.setTokens(custom); // No theme ID change, and no notification is needed for the CSS write.
  f.mutate([{ type: 'childList', target: f.document.head, addedNodes: [{ nodeName: 'STYLE' }] }]);
  f.flush();
  assert.equal(chart.calls.length, 3);
  assert.notEqual(chart.getOption().series[0].data[0].itemStyle.color, darkOption.series[0].data[0].itemStyle.color);
  f.mutate(); f.notify(); f.flush();
  assert.equal(chart.calls.length, 3, 'identical resolved colours skip setOption');
  f.setTokens({ ...custom, '--bg': '#0b3035', '--link': '#c9aadd', '--green': '#aacccc' });
  f.mutate(); f.flush();
  assert.equal(chart.calls.length, 3, 'CSS-only colours that do not affect graph visuals do not resend chart options');
  assert.equal(f.document.documentElement.style.colorScheme, 'dark');
  assert.deepEqual(f.styleWrites, ['light', 'dark'], 'same-theme notifications and after-CSS mutations do not rewrite root style');
  assert.equal(f.frames.size, 0);
});

test('charts created after a theme change and repeated upstream hard-colour setOption calls stay themed', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  startDashboardTheme(f.hana, f.window, f.document);
  f.setTokens(dark); f.mutate(); f.flush();
  const chart = f.echarts.init({});
  const raw = graph();
  chart.setOption(raw);
  const themed = chart.getOption();
  chart.setOption(raw);
  assert.deepEqual(chart.getOption(), themed);
  assert.notEqual(themed.series[0].lineStyle.color, '#cbd5e1');
  f.setTokens(custom); // Even a setOption before the next notification reads current CSS.
  chart.setOption(graph());
  assert.notEqual(chart.getOption().series[0].data[0].itemStyle.color, themed.series[0].data[0].itemStyle.color);
  f.notify(); f.flush();
  assert.equal(chart.calls.length, 3, 'no duplicate theme merge after a freshly themed upstream update');
});

test('generic link load/style edits and root custom-token changes are observed without private SDK attributes', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  startDashboardTheme(f.hana, f.window, f.document);
  const chart = f.echarts.init({}); chart.setOption(graph()); f.flush();
  assert.ok(f.observers[0].targets.some(({ target, options }) => target === f.document.head && options.characterData && options.subtree && options.attributes));
  f.mutate([{ type: 'attributes', target: { nodeName: 'LINK' }, attributeName: 'href' }]); f.flush();
  assert.equal(chart.calls.length, 1);
  f.setTokens(dark); f.headLoad(); f.flush();
  assert.equal(chart.calls.length, 2, 'stylesheet load after href mutation sees applied values');
  f.setTokens(custom); f.mutate([{ type: 'attributes', target: f.document.documentElement, attributeName: 'style' }]); f.flush();
  assert.equal(chart.calls.length, 3);
  const source = fs.readFileSync(path.join(assets, 'theme.js'), 'utf8');
  assert.doesNotMatch(source, /data-hana-theme|setInterval|dispose\(|reinit|location\.|querySelector\(['"]#(?:fact|tab)/);
  const initial = source.match(/  const loadInitialTheme = async \(\) => \{[\s\S]*?\n  const refresh =/)[0];
  assert.doesNotMatch(source.replace(initial, ''), /fetch\(|cssUrl\s*[,)]|setTimeout/);
  assert.equal([...source.matchAll(/\bfetch\(/g)].length, 1, 'the sole fetch is the explicit initial loader, never theme polling');
  assert.equal([...source.matchAll(/\bsetTimeout\(/g)].length, 1, 'only the bounded initial request timeout is allowed');
  assert.match(initial, /window\.fetch\(cssUrl, \{ credentials: 'same-origin', signal: abort.signal \}\)/);
});

test('pagehide cancels frame/subscription/observer; persisted pageshow resumes once without repatching charts', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  const controller = startDashboardTheme(f.hana, f.window, f.document);
  const chart = f.echarts.init({}); chart.setOption(graph()); f.flush();
  const init = f.echarts.init;
  const setOption = chart.setOption;
  f.notify();
  assert.equal(f.frames.size, 1);
  f.event('pagehide');
  assert.equal(f.frames.size, 0);
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.headHandlers.get('load').size, 0);
  assert.ok(f.observers[0].disconnected);
  f.setTokens(dark); f.mutate(); f.notify({ theme: 'custom-dark-no-appearance' }); f.flush();
  assert.equal(chart.calls.length, 1);
  assert.equal(f.document.documentElement.style.colorScheme, 'light', 'unsubscribed hidden page does not consume notifications');
  f.event('pageshow', { persisted: false });
  assert.equal(f.subscribers.size, 0);
  f.event('pageshow', { persisted: true });
  f.event('pageshow', { persisted: true });
  assert.equal(f.subscribers.size, 1);
  assert.equal(f.headHandlers.get('load').size, 1);
  assert.equal(f.observers.length, 2);
  assert.equal(f.echarts.init, init);
  assert.equal(chart.setOption, setOption);
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(chart.calls.length, 2);
  assert.equal(f.inits.length, 1, 'chart was not recreated');
  assert.equal(f.snapshotReads, 2);
  assert.equal(f.document.documentElement.style.colorScheme, '', 'resume without authoritative appearance clears the stale inline scheme');
  assert.deepEqual(f.styleWrites, ['light', '']);
  assert.equal(f.frames.size, 0);
  controller.stop(); controller.stop();
  assert.equal(f.frames.size, 0);
});

test('mixed charts retain non-graph series and graph custom edge/hover/tooltip colours cannot leak old palette', async () => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  startDashboardTheme(f.hana, f.window, f.document);
  const chart = f.echarts.init({});
  const option = graph();
  option.series[0].data[1].emphasis = { itemStyle: { color: '#ffffff', opacity: 0.6 } };
  option.series[0].data[2].blur = { label: { color: '#111111', show: true } };
  option.series[0].links[0].lineStyle = { color: '#000000', width: 2 };
  option.series[0].tooltip = { formatter: () => 'series formatter', backgroundColor: '#ffffff' };
  const other = { id: 'unrelated', type: 'bar', data: [1], itemStyle: { color: '#123456' } };
  option.series.push(other);
  chart.setOption(option);
  assert.equal(chart.calls[0].option.series[1], other);
  assert.equal(chart.calls[0].option.tooltip, option.tooltip, 'mixed-chart global tooltip is not recoloured for non-graph series');
  assert.deepEqual(nonColours(chart.getOption()), nonColours(option));
  f.setTokens(dark); f.mutate(); f.flush();
  const themed = chart.getOption();
  assert.deepEqual(themed.series[1], other);
  assert.deepEqual(themed.tooltip, option.tooltip);
  assert.equal(themed.series[0].data[1].emphasis.itemStyle.opacity, 0.6);
  assert.equal(themed.series[0].data[2].blur.label.show, true);
  assert.equal(themed.series[0].links[0].lineStyle.width, 2);
  assert.equal(themed.series[0].tooltip.formatter, option.series[0].tooltip.formatter);
  assert.equal(themed.series[0].tooltip.backgroundColor, 'rgb(37, 40, 46)');
});

test('public getOption/setOption merge works with the real bundled ECharts SVG software fixture', async (t) => {
  const { startDashboardTheme } = await themeModule;
  const f = fixture();
  const echarts = { ...vendor };
  f.window.echarts = echarts;
  startDashboardTheme(f.hana, f.window, f.document);
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 400, height: 300 });
  t.after(() => chart.dispose());
  const option = graph();
  option.animation = false;
  option.series[0].layout = 'none'; // A static UI fixture; no force simulation or mathematical task.
  option.series[0].data.forEach((node, index) => { node.x = index * 40; node.y = index * 30; });
  chart.setOption(option);
  const before = chart.getOption();
  f.flush();
  f.setTokens(dark); f.mutate(); f.flush();
  const after = chart.getOption();
  assert.equal(after.series[0].data[0].itemStyle.color, 'rgb(81, 78, 99)');
  assert.notEqual(after.series[0].data[0].itemStyle.color, before.series[0].data[0].itemStyle.color);
  assert.deepEqual(nonColours(after), nonColours(before));
  assert.equal(after.tooltip[0].formatter, option.tooltip.formatter);
  assert.equal(after.series[0].zoom, 1.75);
  assert.deepEqual(after.series[0].center, [120, 90]);
});

test('disposed charts are skipped and missing host colours use system computed fallback, not a hardcoded palette', async () => {
  const { startDashboardTheme, readThemePalette } = await themeModule;
  const f = fixture({});
  const palette = readThemePalette(f.echarts, f.document, f.window);
  assert.deepEqual(palette.text, [0, 0, 0, 1]);
  assert.deepEqual(palette.card, [255, 255, 255, 1]);
  const controller = startDashboardTheme(f.hana, f.window, f.document);
  await assert.rejects(controller.ready, { uiMessage: 'Unable to load Hana theme' });
  const chart = f.echarts.init({}); chart.setOption(graph()); f.flush();
  chart.disposed = true;
  f.setTokens(dark); f.mutate(); f.flush();
  assert.equal(chart.calls.length, 1);
});
