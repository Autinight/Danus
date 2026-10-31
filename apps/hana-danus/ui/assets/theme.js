// App-only initial theme bridge and colour adaptation; SDK and upstream assets stay untouched.
const adapters = new WeakMap();
const controllers = new WeakMap();
const styleKeys = ['itemStyle', 'lineStyle', 'label', 'edgeLabel'];
const visualKeys = [...styleKeys, 'data', 'links', 'edges'];
const mix = (left, right, amount) => left.map((value, index) => value + (right[index] - value) * amount);
const rgb = (value) => {
  const channels = value.slice(0, 3).map((channel) => Math.round(channel)).join(', ');
  return value[3] < 1 ? `rgba(${channels}, ${Number(value[3].toFixed(4))})` : `rgb(${channels})`;
};

export function readThemePalette(echarts, document, window) {
  const root = window.getComputedStyle(document.documentElement);
  const body = window.getComputedStyle(document.body);
  const parse = (value) => {
    const parsed = echarts.color.parse(value?.trim());
    return parsed ? [...parsed] : null;
  };
  const token = (name, fallback) => parse(root.getPropertyValue(`--danus-${name}`)) || fallback;
  const text = token('text', parse(body.color));
  const background = token('bg', parse(body.backgroundColor));
  if (!text || !background) return null; // Native/system CSS remains the loading fallback.
  const card = token('card', background);
  const accent = token('accent', text);
  const border = token('border', mix(card, text, 0.2));
  return {
    low: mix(card, accent, 0.3), high: mix(accent, text, 0.15),
    accent, hover: token('hover', accent), text, card,
    muted: token('muted', mix(card, text, 0.6)),
    border, edge: mix(border, text, 0.25),
    shadow: token('shadow', [...text.slice(0, 3), 0.18]),
  };
}

function tooltipColours(palette) {
  return {
    backgroundColor: rgb(palette.card), borderColor: rgb(palette.border), shadowColor: rgb(palette.shadow),
    textStyle: { color: rgb(palette.text), textBorderColor: rgb(palette.card), textShadowColor: rgb(palette.shadow) },
  };
}

function tooltip(value, palette) {
  const colours = tooltipColours(palette);
  const apply = (item) => ({ ...item, ...colours, textStyle: { ...item?.textStyle, ...colours.textStyle } });
  return Array.isArray(value) ? value.map(apply) : apply(value);
}

function stateColours(value, palette, colour, state) {
  const nodeColour = state === 'blur' ? mix(colour, palette.card, 0.55) : colour;
  return {
    ...value,
    itemStyle: { ...value?.itemStyle, color: rgb(nodeColour), borderColor: rgb(state === 'emphasis' ? palette.hover : palette.border), shadowColor: rgb(palette.shadow) },
    lineStyle: { ...value?.lineStyle, color: rgb(state === 'emphasis' ? palette.hover : palette.edge), shadowColor: rgb(palette.shadow) },
    label: { ...value?.label, color: rgb(state === 'blur' ? palette.muted : palette.text), textBorderColor: rgb(palette.card), textShadowColor: rgb(palette.shadow) },
    edgeLabel: { ...value?.edgeLabel, color: rgb(palette.text), textBorderColor: rgb(palette.card), textShadowColor: rgb(palette.shadow) },
  };
}

function graphColours(series, palette) {
  const nodes = Array.isArray(series.data) ? series.data : [];
  const maxDepth = nodes.reduce((max, node) => Number.isFinite(node?.depth) ? Math.max(max, node.depth) : max, 1);
  const result = stateColours(series, palette, palette.accent);
  for (const state of ['emphasis', 'blur', 'select']) result[state] = stateColours(series[state], palette, palette.accent, state);
  result.tooltip = tooltip(series.tooltip, palette);
  if (Array.isArray(series.data)) result.data = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    const depth = Number.isFinite(node.depth) ? Math.max(0, Math.min(1, node.depth / maxDepth)) : 0;
    const colour = mix(palette.low, palette.high, depth);
    const styled = stateColours(node, palette, colour);
    for (const state of ['emphasis', 'blur', 'select']) styled[state] = stateColours(node[state], palette, colour, state);
    return styled;
  });
  for (const key of ['links', 'edges']) {
    if (Array.isArray(series[key])) result[key] = series[key].map((edge) => {
      if (!edge || typeof edge !== 'object') return edge;
      const styled = { ...edge, lineStyle: { ...edge.lineStyle, color: rgb(palette.edge), shadowColor: rgb(palette.shadow) } };
      for (const state of ['emphasis', 'blur', 'select']) styled[state] = {
        ...edge[state], lineStyle: { ...edge[state]?.lineStyle, color: rgb(state === 'emphasis' ? palette.hover : palette.edge), shadowColor: rgb(palette.shadow) },
      };
      return styled;
    });
  }
  return result;
}

function graphOption(option, palette) {
  if (!palette || !option || typeof option !== 'object') return option;
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
  if (!series.some((item) => item?.type === 'graph')) return option;
  const themed = series.map((item) => item?.type === 'graph' ? graphColours(item, palette) : item);
  const result = { ...option, series: Array.isArray(option.series) ? themed : themed[0] };
  if (series.every((item) => item?.type === 'graph')) result.tooltip = tooltip(option.tooltip, palette);
  return result;
}

// Theme-only merge: never resend layout/force/roam/zoom/center, replace a chart, or fetch data.
function visualPatch(option, palette) {
  const themed = graphOption(option, palette);
  if (themed === option) return null;
  const seriesList = Array.isArray(themed.series) ? themed.series : [themed.series];
  const tooltipPatch = (value) => Array.isArray(value) ? value.map(() => tooltipColours(palette)) : tooltipColours(palette);
  const patch = {
    series: seriesList.map((series) => {
      const patch = series.id == null ? {} : { id: series.id };
      if (series.type !== 'graph') return patch;
      for (const key of visualKeys) if (series[key] !== undefined) patch[key] = series[key];
      for (const state of ['emphasis', 'blur', 'select']) patch[state] = Object.fromEntries(styleKeys.map((key) => [key, series[state][key]]));
      if (series.tooltip) patch.tooltip = tooltipPatch(series.tooltip);
      return patch;
    }),
  };
  if (seriesList.every((series) => series.type === 'graph')) patch.tooltip = tooltipPatch(option.tooltip);
  return patch;
}

export function installGraphThemeAdapter(echarts, readPalette) {
  if (adapters.has(echarts)) return adapters.get(echarts);
  const charts = new Map();
  const init = echarts.init;
  echarts.init = function (...args) {
    const chart = init.apply(this, args);
    if (!charts.has(chart)) {
      const setOption = chart.setOption;
      const record = { setOption, paletteKey: '' };
      charts.set(chart, record);
      chart.setOption = function (option, ...rest) {
        const palette = readPalette();
        const themed = graphOption(option, palette);
        const result = setOption.call(this, themed, ...rest);
        if (themed !== option) record.paletteKey = JSON.stringify(palette);
        return result;
      };
    }
    return chart;
  };
  const adapter = {
    refresh() {
      const palette = readPalette();
      if (!palette) return;
      const key = JSON.stringify(palette);
      for (const [chart, record] of charts) {
        if (chart.isDisposed?.()) { charts.delete(chart); continue; }
        if (record.paletteKey === key) continue;
        const patch = visualPatch(chart.getOption(), palette);
        if (!patch) continue;
        record.setOption.call(chart, patch, { lazyUpdate: true, silent: true });
        record.paletteKey = key;
      }
    },
  };
  adapters.set(echarts, adapter);
  return adapter;
}

export function startDashboardTheme(hana, window = globalThis.window, document = window.document) {
  let controller = controllers.get(window);
  if (controller) { controller.start(); return controller; }
  let active = false;
  let frame = null;
  let observer = null;
  let unsubscribe = null;
  let adapter = null;
  let cancelInitial = null;
  let initialStyle = null;
  const hasHostTheme = () => {
    const root = window.getComputedStyle(document.documentElement);
    return Boolean(root.getPropertyValue('--bg').trim() && root.getPropertyValue('--text').trim());
  };
  const isHostSheet = (node) => {
    if (!['STYLE', 'LINK'].includes(node.nodeName)) return false;
    try {
      if (!node.sheet || node.sheet.disabled || (node.media && !window.matchMedia(node.media).matches)) return false;
      const core = new Set();
      for (const rule of node.sheet.cssRules) {
        if (!rule.selectorText || !document.documentElement.matches(rule.selectorText)) continue;
        for (const name of ['--bg', '--text']) if (rule.style?.getPropertyValue(name).trim()) core.add(name);
      }
      return core.size === 2;
    } catch { return false; } // Unloaded/unreadable sheets are not evidence of a handoff.
  };
  const retireInitialTheme = () => {
    if (!initialStyle) return;
    const nodes = [...document.head.children];
    const index = nodes.indexOf(initialStyle);
    if (index < 0 || !nodes.slice(index + 1).some(isHostSheet) || !initialStyle.sheet) return;
    const sheet = initialStyle.sheet;
    const disabled = sheet.disabled;
    try {
      // Probe only our sheet, synchronously: the later theme must stand on its own.
      sheet.disabled = true;
      if (!hasHostTheme()) return;
      const element = initialStyle;
      initialStyle = null; // Removal may itself notify the observer; retire at most once.
      element.remove();
    } finally { sheet.disabled = disabled; }
  };
  const themeError = () => Object.assign(new Error('Unable to load Hana theme'), { uiMessage: 'Unable to load Hana theme' });
  const loadInitialTheme = async () => {
    let element;
    let timer;
    let abort;
    try {
      if (hasHostTheme()) return;
      const cssUrl = hana.theme.getSnapshot()?.cssUrl;
      if (typeof cssUrl !== 'string' || !cssUrl.trim()) throw themeError();
      // Reserve the cascade position BEFORE fetching. Later SDK styles must stay later,
      // even when this initial response arrives after a theme change.
      element = document.createElement('style');
      initialStyle = element;
      document.head.appendChild(element);
      abort = new AbortController();
      const cancelled = new Promise((resolve, reject) => {
        cancelInitial = () => { abort.abort(); reject(themeError()); };
        timer = window.setTimeout(cancelInitial, 10000);
      });
      await Promise.race([
        (async () => {
          const response = await window.fetch(cssUrl, { credentials: 'same-origin', signal: abort.signal });
          if (!response.ok) throw themeError();
          const css = await response.text();
          if (abort.signal.aborted || typeof css !== 'string' || !css.replace(/\/\*[\s\S]*?\*\//g, '').trim() || /theme[\s_-]*not[\s_-]*found/i.test(css)) throw themeError();
          element.textContent = css;
          if (!hasHostTheme()) throw themeError();
          schedule();
        })(),
        cancelled,
      ]);
    } catch {
      abort?.abort();
      if (initialStyle === element) initialStyle = null;
      element?.remove();
      throw themeError(); // Never expose the host URL or raw fetch error through the banner.
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      cancelInitial = null;
    }
  };
  const refresh = () => {
    frame = null;
    if (!active) return;
    retireInitialTheme();
    if (!window.echarts?.init) return;
    adapter ||= installGraphThemeAdapter(window.echarts, () => readThemePalette(window.echarts, document, window));
    adapter.refresh();
  };
  const schedule = () => {
    if (active && frame === null) frame = window.requestAnimationFrame(refresh);
  };
  const onTheme = (snapshot) => {
    if (!active) return;
    const appearance = ['light', 'dark'].includes(snapshot?.appearance) ? snapshot.appearance : '';
    const style = document.documentElement.style;
    // Only the public appearance is authoritative; missing metadata restores CSS defaults.
    if (style.colorScheme !== appearance) {
      if (appearance) style.colorScheme = appearance;
      else style.removeProperty('color-scheme');
    }
    schedule();
  };
  const stylesheet = (node) => ['STYLE', 'LINK'].includes(node?.nodeName) || node?.parentElement?.nodeName === 'STYLE' || node?.querySelector?.('style, link');
  controller = {
    start() {
      if (active) return;
      active = true;
      // The SDK loads later theme notifications; they may precede CSS application.
      observer = new window.MutationObserver((records) => {
        if (records.some((record) => record.target === document.documentElement || stylesheet(record.target) || [...(record.addedNodes || []), ...(record.removedNodes || [])].some(stylesheet))) schedule();
      });
      observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
      document.head.addEventListener('load', schedule, true);
      onTheme(hana.theme.getSnapshot());
      unsubscribe = hana.theme.subscribe(onTheme);
      // Patch before the original renderer creates a chart, without waiting for a frame.
      if (window.echarts?.init) adapter ||= installGraphThemeAdapter(window.echarts, () => readThemePalette(window.echarts, document, window));
    },
    stop(event) {
      active = false;
      // A bfcache pause must preserve the bootstrap's shared initial ready promise.
      if (event?.persisted !== true) cancelInitial?.();
      unsubscribe?.(); unsubscribe = null;
      observer?.disconnect(); observer = null;
      document.head.removeEventListener('load', schedule, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    },
  };
  controllers.set(window, controller);
  window.addEventListener('pagehide', controller.stop);
  window.addEventListener('pageshow', (event) => { if (event.persisted) controller.start(); });
  controller.start();
  controller.ready = loadInitialTheme(); // Once per window, including repeated starts and bfcache restores.
  return controller;
}
