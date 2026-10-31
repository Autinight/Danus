import { defineApp } from "./sdk/app-contract/server-client.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const name = "hana-danus";
const appDir = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ID = "danus-monitor";
const VERIFY_ID = "danus-verifier";
const RUN_KEY = "danus-owned-run-v1";
const SUPERVISION_HANDLER = "danus-supervision-v1";
const OPERATION_HANDLER = "danus-operation-v1";
// Outer tool host RPC expires at 30s; leave margin for returning and cleanup.
const OPERATION_TIMEOUT = 20000;
const OPERATION_CLEANUP_TIMEOUT = 2000;
const TERMINAL = new Set(["stopped", "exited", "failed"]);
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class DanusError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function validProject(value) {
  return typeof value === "string" && value !== "." && value !== ".." && PROJECT_ID.test(value);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
export function safeError(error) {
  if (error instanceof DanusError) return { code: error.code, message: error.message };
  const denied = error?.kind === "permission";
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "danus_error";
  return {
    code,
    message: denied
      ? "请在正式 App 权限审核中允许 Danus 的本机运行和联网权限。"
      : "Danus 操作未完成。请查看 App 的受管运行记录；证明结果不会因此被标记为通过。",
  };
}
function errorResponse(error) {
  return json({ error: safeError(error) }, error?.status || (error?.kind === "permission" ? 403 : 502));
}

async function loadOrCreateToken(dataDir) {
  const tokenPath = path.join(dataDir, "monitor-auth-token");
  try {
    const handle = await fs.open(tokenPath, "wx", 0o600);
    const token = randomBytes(32).toString("hex");
    try { await handle.writeFile(`${token}\n`, "utf8"); } finally { await handle.close(); }
    await fs.chmod(tokenPath, 0o600);
    return { tokenPath, token };
  } catch (error) { if (error?.code !== "EEXIST") throw error; }
  const file = await fs.lstat(tokenPath);
  if (!file.isFile() || file.isSymbolicLink()) throw new DanusError("invalid_token_file", "监控认证文件无效。");
  await fs.chmod(tokenPath, 0o600);
  const token = (await fs.readFile(tokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new DanusError("invalid_token_file", "监控认证文件无效。");
  return { tokenPath, token };
}

export async function setupDanus(sdk) {
  const auth = await loadOrCreateToken(sdk.dataDir);
  let pending = Promise.resolve();
  let ownedRun = null;
  let loadedRun = false;
  let loadingRun = null;
  const servicePending = new Map();
  function serviceSerial(id, operation) {
    const previous = servicePending.get(id) || Promise.resolve();
    const next = previous.then(operation, operation);
    servicePending.set(id, next.catch(() => {}));
    return next;
  }
  function bounded(promise, milliseconds, message = "等待 Danus 受管运行响应超时。") {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DanusError("runtime_timeout", message)), Math.max(1, milliseconds)); }),
    ]).finally(() => clearTimeout(timer));
  }
  function serial(operation) {
    const result = pending.then(operation, operation);
    pending = result.catch(() => {});
    return result;
  }
  async function getRun() {
    if (!loadedRun) {
      if (!loadingRun) loadingRun = (async () => {
        ownedRun = await sdk.storage.global.get(RUN_KEY) || null;
        if (ownedRun?.launching) {
          // A launch intent is saved before starting any anonymous worker.
          // On recovery, reconcile only runtimes owned by this App. This App's
          // only non-service runtimes are its workers; never signal OS PIDs.
          const entries = await bounded(sdk.runtime.list(), 10000);
          const workerIds = entries.filter((entry) => !entry.service && !TERMINAL.has(entry.state)).map((entry) => entry.runtimeId);
          ownedRun.runtimeIds = [...new Set([...(ownedRun.runtimeIds || []), ...workerIds])];
          await cleanupRun(ownedRun);
          ownedRun.launching = false;
          ownedRun.interrupted = true;
          await sdk.storage.global.set(RUN_KEY, ownedRun);
        }
        loadedRun = true;
        if (ownedRun?.runtimeIds?.length && !ownedRun.interrupted) {
          try { await supervise(ownedRun); }
          catch (error) {
            await cleanupRun(ownedRun);
            ownedRun.interrupted = true;
            ownedRun.startupFailed = true;
            await saveRun({ ...ownedRun });
            throw error;
          }
        }
      })();
      await loadingRun;
    }
    return ownedRun;
  }
  async function saveRun(run) {
    await sdk.storage.global.set(RUN_KEY, run);
    ownedRun = run;
    loadedRun = true;
  }
  async function ownedService(id) {
    const entries = await sdk.runtime.list();
    return entries.filter((entry) => entry.service?.id === id)
      .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))[0] || null;
  }

  async function observeUntil(runtimeId, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const initial = await bounded(sdk.runtime.get(runtimeId), remaining());
    if (!initial) throw new DanusError("runtime_missing", "Danus 的受管运行记录已不可用。");
    if (predicate(initial)) return initial;
    if (TERMINAL.has(initial.state)) throw new DanusError("runtime_start_failed", "Danus 内置服务启动失败，请查看受管运行记录。");
    const response = await bounded(sdk.runtime.watch(runtimeId), remaining());
    if (!response.ok || !response.body) throw new DanusError("runtime_watch_failed", "无法读取 Danus 的受管运行状态。");
    const reader = response.body.getReader();
    let timer;
    const read = async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        if (done && buffer) lines.push(buffer);
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          // Logs stay in the managed runtime; only lifecycle records are consumed.
          if (event.type === "log" || !event.runtime) continue;
          if (predicate(event.runtime)) return event.runtime;
          if (TERMINAL.has(event.runtime.state)) throw new DanusError("runtime_start_failed", "Danus 内置服务启动失败，请查看受管运行记录。");
        }
        if (done) break;
      }
      const latest = await sdk.runtime.get(runtimeId);
      if (latest && predicate(latest)) return latest;
      throw new DanusError("runtime_watch_ended", "Danus 的受管状态流已结束，目标状态尚未确认。");
    };
    try {
      return await Promise.race([
        read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new DanusError("runtime_timeout", "等待 Danus 内置服务超时。")), remaining()); }),
      ]);
    } finally {
      clearTimeout(timer);
      await bounded(reader.cancel(), Math.min(1000, remaining())).catch(() => {});
    }
  }

  function launch(script, args, service) {
    return sdk.runtime.start({
      runtime: "command",
      command: path.join(appDir, "dependencies", "python", "bin", "python3"),
      args: ["-B", path.join(appDir, "service", script), "--data-dir", sdk.dataDir, ...args],
      cwd: sdk.dataDir,
      // Intentional independent local application mode. It is user-reviewed,
      // not a fallback from native. Codex uses its existing standard login.
      profile: "local-machine",
      network: "external",
      ...(service ? { service } : {}),
    });
  }
  async function stopRuntime(runtimeId) {
    const runtime = await bounded(sdk.runtime.get(runtimeId), 10000);
    if (!runtime || TERMINAL.has(runtime.state)) return runtime;
    const stopped = await bounded(sdk.runtime.stop(runtimeId), 25000);
    return TERMINAL.has(stopped.state) ? stopped : observeUntil(runtimeId, (item) => TERMINAL.has(item.state), 25000);
  }
  async function ensureService(id, start, onOwned = async () => {}) {
    return serviceSerial(id, async () => {
      let entry = await ownedService(id);
      if (entry && !TERMINAL.has(entry.state)) {
        if (entry.state === "stopping" || (entry.state === "ready" && entry.service?.state === "unavailable")) {
          await stopRuntime(entry.runtimeId);
          entry = null;
        }
      }
      if (!entry || TERMINAL.has(entry.state)) entry = await start();
      try {
        await onOwned(entry);
        return await observeUntil(entry.runtimeId, (item) => item.state === "ready" && item.service?.state === "ready", 25000);
      } catch (error) {
        await stopRuntime(entry.runtimeId).catch(() => sdk.logger?.error?.("Danus service startup cleanup failed."));
        throw error;
      }
    });
  }
  async function ensureEngine() {
    return ensureService(ENGINE_ID, () => launch("engine.py", ["--token-file", auth.tokenPath, "--port", "18539"], {
      id: ENGINE_ID, port: 18539, readyMarker: "HANA_DANUS_MONITOR_READY",
    }));
  }
  async function engineRequest(endpoint, { method = "GET", body } = {}) {
    const runtime = await ensureEngine();
    const response = await sdk.runtime.fetch(runtime.runtimeId, endpoint, {
      method,
      headers: { authorization: `Bearer ${auth.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), timeoutMs: 15000,
    });
    let data;
    try { data = await response.json(); } catch { throw new DanusError("invalid_engine_response", "Danus 内置服务返回了无效响应。"); }
    if (!response.ok) {
      const detail = data.error || data.detail;
      const known = detail && typeof detail === "object" && typeof detail.code === "string";
      throw new DanusError(known ? detail.code : "engine_request_failed", known && typeof detail.message === "string" ? detail.message : "Danus 内置服务未完成该操作。", response.status);
    }
    return data;
  }
  async function liveWorkers(run) {
    const workers = await Promise.all((run?.runtimeIds || []).map((id) => sdk.runtime.get(id)));
    return workers.filter((item) => item && !TERMINAL.has(item.state));
  }
  async function stopVerifier(run) {
    if (run?.verifierRuntimeId) await stopRuntime(run.verifierRuntimeId);
  }
  async function removeLifecycleSchedule(id) {
    if (await bounded(sdk.tasks.getSchedule(id), OPERATION_CLEANUP_TIMEOUT) === null) return;
    try { await bounded(sdk.tasks.unschedule(id), OPERATION_CLEANUP_TIMEOUT); }
    catch (error) {
      // Another callback may have removed it after our lookup. Only confirmed
      // absence is success; preserve real failures, including permission errors.
      let absent = false;
      try { absent = await bounded(sdk.tasks.getSchedule(id), OPERATION_CLEANUP_TIMEOUT) === null; }
      catch { /* An unsuccessful recheck is not evidence of removal. */ }
      if (!absent) throw error;
    }
  }
  async function removeSupervision(run) {
    if (!run?.supervisionScheduleId) return;
    await removeLifecycleSchedule(run.supervisionScheduleId);
    delete run.supervisionScheduleId;
  }
  async function cleanupRun(run) {
    const results = await Promise.allSettled([
      ...(run?.runtimeIds || []).map((id) => stopRuntime(id)),
      stopVerifier(run), removeSupervision(run),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      throw new DanusError("runtime_cleanup_failed", "部分受管运行尚未确认停止，请检查 App 的运行记录。");
    }
  }
  async function status(project) {
    if (project && !validProject(project)) throw new DanusError("invalid_project", "项目标识无效。", 400);
    const run = await getRun();
    const selected = project || run?.project;
    if (!selected) return { state: "idle", project: null, workers: [], fact_count: 0, verified_fact_ids: [], engine: "bundled", storage: "app" };
    const data = await engineRequest(`/control/status?project=${encodeURIComponent(selected)}`);
    const managed = run?.project === selected
      ? (await Promise.all((run.runtimeIds || []).map((id) => bounded(sdk.runtime.get(id), 10000)))).filter(Boolean)
      : [];
    const alive = managed.some((item) => !TERMINAL.has(item.state)) || data.workers?.some((worker) => worker.alive) || (run?.project === selected && run.launching);
    const failed = (run?.project === selected && run.startupFailed) || managed.some((item) => item.state === "failed" || (item.exitCode != null && item.exitCode !== 0))
      || data.workers?.some((worker) => worker.state === "error" || (worker.last_rc != null && worker.last_rc !== 0));
    const stopped = managed.some((item) => item.state === "stopped") || data.workers?.some((worker) => ["stopped", "terminated"].includes(worker.state));
    const state = alive ? "running" : failed ? "error" : stopped ? "stopped" : managed.length ? "finished" : data.workers?.every((worker) => worker.state === "created") ? "idle" : "finished";
    return { ...data, state };
  }
  async function workerSnapshots(run) {
    return Promise.all(run.runtimeIds.map((id) => bounded(sdk.runtime.get(id), 10000)));
  }
  async function supervise(run) {
    if (operationRegistrationError) throw operationRegistrationError;
    if (!Number.isFinite(run.supervisionDeadline)) run.supervisionDeadline = Date.now() + 660000;
    if (Date.now() >= run.supervisionDeadline) {
      await cleanupRun(run);
      await saveRun({ ...run });
      return;
    }
    const workers = await workerSnapshots(run);
    if (workers.every((item) => !item || TERMINAL.has(item.state))) {
      await Promise.all([stopVerifier(run), removeSupervision(run)]);
      await saveRun({ ...run });
      return;
    }
    if (run.supervisionScheduleId) {
      const schedule = await bounded(sdk.tasks.getSchedule(run.supervisionScheduleId), 10000);
      if (schedule?.enabled && schedule.scope === "app" && schedule.handlerKey === SUPERVISION_HANDLER
          && schedule.intervalMs === 10000 && schedule.payload?.runId === run.runId) return;
      await removeSupervision(run);
    }
    const schedule = await bounded(sdk.tasks.schedule({
      scope: "app", handlerKey: SUPERVISION_HANDLER, intervalMs: 10000,
      payload: { runId: run.runId }, label: "Danus lifecycle check",
    }), 10000);
    run.supervisionScheduleId = schedule.scheduleId;
    await saveRun({ ...run, runtimeIds: [...run.runtimeIds] });
  }
  async function supervisionTick(context) {
    if (context?.kind !== "schedule" || typeof context.input?.runId !== "string") return { status: "ignored" };
    return serial(async () => {
      try {
        const run = await getRun();
        if (run?.runId !== context.input.runId || run.supervisionScheduleId !== context.scheduleId) {
          if (context.scheduleId) await removeLifecycleSchedule(context.scheduleId);
          return { status: "ignored" };
        }
        if (Date.now() >= run.supervisionDeadline) {
          await cleanupRun(run);
          await saveRun({ ...run });
          return { status: "stopped" };
        }
        let workers;
        try { workers = await workerSnapshots(run); }
        catch {
          await cleanupRun(run);
          await saveRun({ ...run });
          return { status: "stopped" };
        }
        if (workers.every((item) => !item || TERMINAL.has(item.state))) {
          await Promise.all([stopVerifier(run), removeSupervision(run)]);
          await saveRun({ ...run });
          return { status: "completed" };
        }
        return { status: "active" };
      } catch {
        sdk.logger?.error?.("Danus lifecycle check cleanup failed; ownership retained.");
        return { status: "failed" };
      }
    });
  }
  async function runProblem(input) {
    const previous = await getRun();
    if ((await liveWorkers(previous)).length) throw new DanusError("run_active", "已有一个 Danus 任务在运行，请先等待或停止它。", 409);
    await stopVerifier(previous);
    await removeSupervision(previous);
    const account = await engineRequest("/control/account");
    if (!account.logged_in) throw new DanusError("codex_login_required", "本机 Codex 尚未登录，请通过 Codex 的正式登录流程登录后重试。", 409);
    const created = await engineRequest("/control/projects", { method: "POST", body: input });
    let verifier;
    const record = { runId: randomBytes(12).toString("hex"), project: created.project, model: created.model, runtimeIds: [], verifierRuntimeId: null, launching: true };
    try {
      verifier = await ensureService(VERIFY_ID, () => launch("verify.py", ["--model", created.model, "--token-file", auth.tokenPath, "--port", "18540"], {
        id: VERIFY_ID, port: 18540, readyMarker: "HANA_DANUS_VERIFY_READY",
      }), async (runtime) => {
        record.verifierRuntimeId = runtime.runtimeId;
        await saveRun({ ...record });
      });
      // Persist ownership before and after each start, including partial failure.
      await saveRun({ ...record });
      for (const worker of created.workers) {
        const runtime = await launch("worker.py", ["--project", created.project, "--worker", worker, "--model", created.model]);
        record.runtimeIds.push(runtime.runtimeId);
        await saveRun({ ...record, runtimeIds: [...record.runtimeIds] });
        if (TERMINAL.has(runtime.state)) throw new DanusError("worker_start_failed", "Danus worker 启动失败，请查看受管运行记录。");
      }
      await supervise(record);
      record.launching = false;
      await saveRun({ ...record, runtimeIds: [...record.runtimeIds] });
    } catch (error) {
      try {
        await cleanupRun(record);
        record.launching = false;
        record.startupFailed = true;
        await saveRun({ ...record, runtimeIds: [...record.runtimeIds] });
      } catch {
        sdk.logger?.error?.("Danus partial startup cleanup failed; ownership record retained.");
      }
      throw error;
    }
    return { ...created, state: "running", max_rounds: 1, timeout_seconds: 600, account_source: "system_codex" };
  }
  async function stopProblem(project) {
    const run = await getRun();
    if (project && !validProject(project)) throw new DanusError("invalid_project", "项目标识无效。", 400);
    if (project && run && project !== run.project) throw new DanusError("not_owned_run", "该项目不属于当前 App 运行记录。", 409);
    await cleanupRun(run);
    if (run) {
      run.launching = false;
      await saveRun({ ...run });
    }
    return run ? { ...await status(run.project), state: "stopped" } : status(project);
  }
  async function result(project, factId) {
    if (project !== undefined && !validProject(project)) throw new DanusError("invalid_project", "项目标识无效。", 400);
    const selected = project === undefined ? (await getRun())?.project : project;
    if (!selected) throw new DanusError("project_required", "请指定项目或先提交一个 Danus 任务。", 400);
    if (!validProject(selected)) throw new DanusError("invalid_project", "项目标识无效。", 400);
    if (typeof factId !== "string" || factId.length !== 16 || !/^[a-f0-9]{16}$/.test(factId)) throw new DanusError("invalid_fact_id", "事实标识必须是 16 位小写十六进制字符串。", 400);
    return engineRequest(`/control/result?project=${encodeURIComponent(selected)}&fact_id=${encodeURIComponent(factId)}`);
  }
  async function dispatch(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new DanusError("invalid_input", "请求必须是一个对象。", 400);
    if (input.action === "status") return status(input.project);
    if (input.action === "result") return result(input.project, input.fact_id);
    if (input.action === "account") return engineRequest("/control/account");
    if (input.action === "run") {
      const { action, ...body } = input;
      return serial(() => runProblem(body));
    }
    if (input.action === "stop") return serial(() => stopProblem(input.project));
    throw new DanusError("invalid_action", "不支持的 Danus 操作。", 400);
  }
  // The host runs App-scoped schedules without an invocation callToken. Keep
  // requests private: durable schedules contain only an opaque, one-use ID.
  const operationRequests = new Map();
  let operationRegistrationError = null;
  try {
    if (!sdk.tasks?.registerHandler || !sdk.tasks?.schedule || !sdk.tasks?.unschedule || !sdk.tasks?.getSchedule) {
      throw new DanusError("operation_unavailable", "Danus 的 App 级任务服务不可用。请检查 App 任务权限。", 503);
    }
    await sdk.tasks.registerHandler(SUPERVISION_HANDLER, { run: supervisionTick });
    await sdk.tasks.registerHandler(OPERATION_HANDLER, {
      async run(context) {
        const requestId = context?.input?.requestId;
        const request = operationRequests.get(requestId);
        if (context?.kind !== "schedule" || !request) return { status: "ignored" };
        operationRequests.delete(requestId);
        request.started = true;
        try {
          const data = await dispatch(request.input);
          request.resolve(data);
          return { status: "completed" };
        } catch (error) {
          request.reject(error);
          return { status: "failed" };
        }
      },
    });
  } catch (error) {
    operationRegistrationError = error;
  }
  async function scheduledDispatch(input) {
    if (operationRegistrationError) throw operationRegistrationError;
    const requestId = randomBytes(16).toString("hex");
    let request;
    const result = new Promise((resolve, reject) => { request = { input, resolve, reject, started: false }; });
    operationRequests.set(requestId, request);
    let scheduleId;
    let finished = false;
    let unscheduled = false;
    const cleanupSchedule = async () => {
      if (!scheduleId || unscheduled) return;
      unscheduled = true;
      try { await bounded(sdk.tasks.unschedule(scheduleId), OPERATION_CLEANUP_TIMEOUT); }
      catch { sdk.logger?.warn?.("Danus operation schedule cleanup failed; consumed requests cannot replay."); }
    };
    const timer = setTimeout(() => {
      operationRequests.delete(requestId);
      request.reject(new DanusError("operation_timeout", request.started
        ? "Danus 操作等待超时，运行可能仍在继续。请先查询 status 或停止任务，不要直接重复 run。"
        : "Danus 操作等待超时，尚未开始的请求已取消。", 504));
    }, OPERATION_TIMEOUT);
    // Observe scheduling separately so even a missing acknowledgement is bounded.
    // A late acknowledgement still removes its one-shot schedule.
    Promise.resolve().then(() => sdk.tasks.schedule({
      scope: "app", handlerKey: OPERATION_HANDLER, runAt: Date.now(),
      payload: { requestId }, label: "Danus operation",
    })).then(async (schedule) => {
      scheduleId = schedule.scheduleId;
      if (finished) await cleanupSchedule();
    }).catch((error) => request.reject(error));
    try {
      return await result;
    } finally {
      finished = true;
      operationRequests.delete(requestId);
      clearTimeout(timer);
      await cleanupSchedule();
    }
  }
  async function requestBody(c) {
    const raw = await c.req.text();
    if (raw.length > 100000) throw new DanusError("invalid_input", "题目内容过长。", 400);
    try { return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new DanusError("invalid_json", "请求内容必须是 JSON。", 400); }
  }
  const handle = (fn) => async (c) => { try { return json(await fn(c)); } catch (error) { return errorResponse(error); } };
  await sdk.routes.register((routes) => {
    routes.get("/monitor/state", handle(async () => {
      const entry = await ownedService(ENGINE_ID);
      return { state: entry?.state || "stopped", service: entry?.service?.state || "unavailable" };
    }));
    routes.post("/monitor/start", handle(async (c) => {
      const body = await requestBody(c);
      if (!body || Array.isArray(body) || Object.keys(body).length) throw new DanusError("invalid_body", "启动监控无需额外参数。", 400);
      const started = await ensureEngine();
      return { state: started.state, service: started.service?.state || "pending" };
    }));
    routes.post("/monitor/stop", handle(async () => {
      const run = await getRun();
      if ((await liveWorkers(run)).length) throw new DanusError("run_active", "请先停止求解任务，再停止监控。", 409);
      return serviceSerial(ENGINE_ID, async () => {
        const runtime = await ownedService(ENGINE_ID);
        return runtime ? stopRuntime(runtime.runtimeId) : { state: "stopped", service: "unavailable" };
      });
    }));
    routes.get("/monitor/projects", handle(() => engineRequest("/api/projects")));
    for (const kind of ["overview", "factgraph", "channels"]) {
      routes.get(`/monitor/${kind}`, handle((c) => engineRequest(`/api/${kind}?project=${encodeURIComponent(c.req.query("project") || "")}`)));
    }
    routes.get("/monitor/channel/:kind", handle((c) => {
      const kind = c.req.param("kind");
      if (!/^[a-z_]{1,40}$/.test(kind)) throw new DanusError("invalid_channel", "频道标识无效。", 400);
      return engineRequest(`/api/channel/${kind}?project=${encodeURIComponent(c.req.query("project") || "")}`);
    }));
    routes.get("/danus/account", handle(() => dispatch({ action: "account" })));
    routes.get("/danus/status", handle((c) => dispatch({ action: "status", project: c.req.query("project") || undefined })));
    routes.get("/danus/result", handle((c) => dispatch({ action: "result", project: c.req.query("project"), fact_id: c.req.query("fact_id") })));
    for (const action of ["run", "stop"]) {
      routes.post(`/danus/${action}`, handle(async (c) => {
        const body = await requestBody(c);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new DanusError("invalid_input", "请求必须是一个对象。", 400);
        return dispatch({ ...body, action });
      }));
    }
  });
  await sdk.tools.register({
    name: "danus",
    description: "Delegate a natural-language mathematical proof problem to the Danus engine bundled inside Hana. Use run → status → result: normally omit project/model and use the default workers=1; save the project returned by run and use it for subsequent status/result calls. Read status.verified_fact_ids, then call result for the relevant IDs to retrieve complete original verifier-accepted proofs; follow result.predecessors with further result reads as needed. Check that the proof establishes the complete requested target: finished is only a lifecycle state, and ID ordering does not identify the target theorem. Result is read-only, not a new proof run. Inspect account or stop App-owned workers as needed. Projects and accepted facts stay in this App's own data directory; no external project paths, repository or CLI required. Runs are bounded to one round, 600 seconds per worker; only verifier-accepted facts count as verified.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["run", "status", "stop", "account", "result"] },
        fact_id: { type: "string", minLength: 16, maxLength: 16, pattern: "^[a-f0-9]{16}$", description: "Required for result: one canonical ID from status.verified_fact_ids. Returns the complete accepted fact markdown and predecessors." },
        problem: { type: "string", minLength: 1, maxLength: 16000, description: "Mathematical problem to prove; required for run." },
        project: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", description: "Optional project ID. Run generates a fresh ID if omitted." },
        model: { type: "string", description: "Optional Codex model override; otherwise reuse the existing Codex config model." },
        workers: { type: "integer", minimum: 1, maximum: 4, default: 1 },
      },
      required: ["action"],
    },
    invocationStyle: "sdk_tool",
    async execute(input) {
      try {
        // sdk_tool calls may attach a host context alongside validated args.
        // It is authority metadata, never a field for the engine's request body.
        const { context, ...args } = input;
        const data = await scheduledDispatch(args);
        return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
      } catch (error) {
        const result = { error: safeError(error) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: true };
      }
    },
  });
  // Reconcile a prior ownership record and re-arm runtime watches on recovery.
  await getRun();
  return { dispatch };
}

export default defineApp(setupDanus);
