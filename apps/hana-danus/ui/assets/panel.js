import { hana } from './sdk.js';
import { startDashboardTheme } from './theme.js';

'use strict';

const DASHBOARD_ROUTES = {
  '/api/overview': '/monitor/overview',
  '/api/factgraph': '/monitor/factgraph',
  '/api/channels': '/monitor/channels',
};
const CHANNEL_ROUTE = /^\/api\/channel\/([a-z_]{1,40})$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_KEY = 'danus-owned-run-v1';
let nativeFetch = null;

export function validProjectId(value) {
  return typeof value === 'string' && value !== '.' && value !== '..' && PROJECT_ID.test(value);
}

export function chooseProjectId(projects, hash, ownedRun) {
  const valid = (Array.isArray(projects) ? projects : []).filter((project) => validProjectId(project?.id));
  let requested = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  try { requested = decodeURIComponent(requested); } catch { requested = ''; }
  if (valid.some((project) => project.id === ownedRun?.project)) return ownedRun.project;
  if (valid.some((project) => project.id === requested)) return requested;
  return valid[0]?.id || '';
}

export function mapDashboardRequest(input, init, baseHref, projectId) {
  const resource = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : '';
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  if (!resource || method !== 'GET') return null;

  let url;
  let base;
  try {
    base = new URL(baseHref);
    url = new URL(resource, base);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || resource.includes('?') || resource.includes('#')) return null;

  let route = DASHBOARD_ROUTES[url.pathname];
  const channel = url.pathname.match(CHANNEL_ROUTE);
  if (!route && channel) route = `/monitor/channel/${channel[1]}`;
  if (!route) return null;
  if (!validProjectId(projectId)) throw new Error('Dashboard project is not initialized.');
  return `${route}?project=${encodeURIComponent(projectId)}`;
}

export function installDashboardFetch(projectId) {
  if (!nativeFetch) nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const route = mapDashboardRequest(input, init, window.location.href, projectId);
    if (!route) return nativeFetch(input, init);
    return hana.api.fetch(route, { cache: 'no-store', ...init });
  };
}

export function reloadForProject(location, projectId) {
  location.hash = `#${encodeURIComponent(projectId)}`;
  location.reload();
}

export async function bootstrapDashboard({ ready, loadVendors, startMonitor, followProjects }) {
  await ready();
  await loadVendors();
  const deadline = await startMonitor();
  await followProjects(deadline);
}

// Storage events, not task polling, follow projects started by the agent-owned tool.
export function createProjectFollower({ storage, loadProjects, hash, mountDashboard, reload, onError }) {
  let selected = '';
  let followOwned = false;
  let disposed = false;
  let dirty = false;
  let pending = null;
  let unsubscribe = null;

  function refresh(ownedChanged = false) {
    followOwned ||= ownedChanged;
    dirty = true;
    if (!pending) pending = (async () => {
      try {
        while (dirty && !disposed) {
          dirty = false;
          const [projects, run] = await Promise.all([
            loadProjects(), storage.get(RUN_KEY, { timeoutMs: 20000 }),
          ]);
          if (disposed) return;
          const owned = projects.some((item) => validProjectId(item?.id) && item.id === run?.project) ? run.project : '';
          const project = followOwned ? owned : chooseProjectId(projects, hash(), run);
          if (!project || project === selected) continue;
          if (selected) {
            selected = project;
            reload(project);
          } else {
            await mountDashboard(project);
            selected = project;
          }
        }
      } finally {
        pending = null;
      }
    })();
    return pending;
  }
  return {
    start() {
      disposed = false;
      if (!unsubscribe) unsubscribe = storage.onChanged((keys) => {
        if (Array.isArray(keys) && keys.includes(RUN_KEY)) return refresh(true).catch(onError);
      });
      return refresh(Boolean(selected));
    },
    refresh,
    dispose() { disposed = true; unsubscribe?.(); unsubscribe = null; },
  };
}

function uiError(message) {
  return Object.assign(new Error(message), { uiMessage: message });
}

function showConnectionError(error) {
  const banner = document.querySelector('#conn-banner');
  banner.textContent = error?.uiMessage || 'Danus monitor could not connect.';
  banner.hidden = false;
}

async function loadVendors() {
  // The local deferred vendor scripts precede this module in the upstream document.
  if (!window.echarts || !window.katex || !window.markdownit) throw uiError('Local dashboard assets could not load.');
}

async function requestJson(path, init = {}, deadline = Date.now() + 20000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw uiError('Danus monitor request timed out.');
  const controller = new AbortController();
  let timeoutId;
  const timedOut = new Promise((resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      controller.abort();
      reject(uiError('Danus monitor request timed out.'));
    }, remaining);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await hana.api.fetch(path, { cache: 'no-store', ...init, signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          const detail = data?.error;
          const code = typeof detail?.code === 'string' ? detail.code : '';
          const message = typeof detail?.message === 'string' ? detail.message : '';
          throw uiError([code, message].filter(Boolean).join(': ') || `Danus monitor request failed (HTTP ${response.status}).`);
        }
        if (!data) throw uiError('Danus monitor returned an invalid response.');
        return data;
      })(),
      timedOut,
    ]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function startMonitor() {
  const deadline = Date.now() + 30000;
  await requestJson('/monitor/start', { method: 'POST' }, deadline);
  while (Date.now() < deadline) {
    const status = await requestJson('/monitor/state', {}, deadline);
    if (status.state === 'ready' && status.service === 'ready') return deadline;
    if (['failed', 'exited', 'stopped'].includes(status.state)) throw uiError('Danus monitor service is unavailable.');
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(300, Math.max(0, deadline - Date.now()))));
  }
  throw uiError('Danus monitor startup timed out.');
}

async function loadProjects(deadline) {
  const data = await requestJson('/monitor/projects', {}, deadline);
  return (Array.isArray(data.projects) ? data.projects : []).filter((project) => validProjectId(project?.id));
}

async function mountDashboard(project) {
  installDashboardFetch(project);
  document.querySelector('#conn-banner').hidden = true;
  await import('../dashboard/app.js');
}

async function start() {
  let follower;
  try {
    await bootstrapDashboard({
      ready: async () => { await hana.ready(); await startDashboardTheme(hana).ready; },
      loadVendors,
      startMonitor,
      followProjects: async (deadline) => {
        let initial = true;
        follower = createProjectFollower({
          storage: hana.storage.global,
          loadProjects: () => { const limit = initial ? deadline : undefined; initial = false; return loadProjects(limit); },
          hash: () => window.location.hash,
          mountDashboard,
          reload: (project) => reloadForProject(window.location, project),
          onError: showConnectionError,
        });
        window.addEventListener('pagehide', () => follower.dispose());
        window.addEventListener('pageshow', (event) => {
          if (event.persisted) return follower.start().catch(showConnectionError);
        });
        await follower.start();
      },
    });
  } catch (error) {
    showConnectionError(error);
  }
}

start();
