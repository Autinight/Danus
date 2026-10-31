# Development state

## 0.2.6 initial host stylesheet loading correction

- Operator screenshot disproved 0.2.5 visual acceptance: the installed panel still showed white paper and the upstream blue-purple bars, while Hana used warm paper and a muted blue accent. Acceptance requires the page background to use Hana `--bg` and the bar fills to use Hana `--accent` on first opening.
- Confirmed source mechanism: the packaged SDK reads initial `cssUrl` but calls its stylesheet loader only on a later theme-change event. The host deliberately skips the first theme subscription callback. Neither side loads initial theme CSS. The App CSS endpoint emits canonical unprefixed variables; prefix-only Interactive Card rules are a separate contract, not this root cause.
- Implemented: consume the exact public initial snapshot URL once in App-owned code, with a 10-second bound and safe visible errors; mount the renderer after it resolves. SDK code, later theme following, original body/renderer/CSS, backend, data, account and permissions remain unchanged. No guessed CSS URL, host configuration read, or hardcoded screenshot colors.
- The initial stylesheet reserves its cascade position before fetching. Later host styles take priority; public CSSOM verifies that they work independently before retiring the initial sheet, so optional old tokens do not leak. A late initial response cannot revive a retired sheet. Persisted pagehide pauses listeners without rejecting the shared initial ready promise; restored pages reuse one request.
- Parent reran Node 74/74, packaging 10/10, JS syntax and diff checks. The cold-start fixture uses the real bundled SDK with no initial theme event and real ECharts SVG. Coverage includes HTTP/empty/comment/timeout failures, safe banner errors, delayed responses, optional-token retirement and BFcache. App check: 0 errors, one existing upstream display/[hidden] warning. SDK and panel CSS match 0.2.5 byte-for-byte; backend and copied upstream assets were also checked unchanged.
- Candidate build ID: `hana-danus-026-initial-theme-20261031a`. Archive validation, official update approval, installed activation and real Hana visual acceptance remain pending at source cut. Software fixtures are not live visual acceptance. No model, worker, verifier or mathematical experiment was run.

## 0.2.5 Hana-derived dashboard colors

- Requested change: replace dashboard colors with Hana theme-derived values, preserving the original layout and interactions. Original renderer/CSS remain byte-copied; the App adds a scoped color override and a public ECharts color adapter.
- The public UI SDK already follows the host stylesheet. Theme notifications precede asynchronous CSS application, so canvas recoloring must also follow actual stylesheet changes. Do not copy host theme definitions, guess CSS URLs, change the user's selected theme, or add theme-management permissions.
- Cover surfaces, text, borders, links, status backgrounds/borders, the graph depth scale/nodes/edges, tooltip and error colors. Theme updates must not reload views, refetch data, reset selection, or start inference. Preserve project binding and existing refresh intervals.
- Public ECharts merge preserves node identity, previous force positions as starting points, and roam center/zoom. A color update can restart force relaxation; unchanged layout means the page structure and interaction state, not frozen graph coordinates. Do not use private force/model APIs to suppress this behavior.
- Implementation includes public appearance → document color-scheme, theme-derived scrollbars/selection/focus, and pagehide/bfcache subscription cleanup. Parent reran all 62 Node regressions and 10 packaging tests successfully; unchanged backend fixtures passed 142 Python tests. Syntax and diff checks passed; source lint has zero errors and the prior generic hidden/display CSS warning. These are software fixtures, including a real bundled ECharts static SVG test, not live WebView acceptance or mathematical inference.
- Backend entry/service and original renderer/CSS match the prior 0.2.4 payload. Archive smoke/official validation passed, and official status confirmed installation `stg_3bfe676139fcb8f0`. Independent source review and fixture tests missed the initial stylesheet loading gap. The operator's real screenshot is a visual acceptance failure; do not describe 0.2.5 as successfully integrated with the live theme. No mathematical inference was launched for this update.

## 0.2.4 assistant result-delivery completion

- User goal: give an authorized assistant the mathematical problem, without teaching tool calls, choosing folders, or reading private App files. The tool's own description/schema supplies run → status → result and original canonical proof retrieval.
- New read-only `result(project?, fact_id)` returns one complete canonical fact's Markdown and predecessors. It accepts identifiers, not paths, rejects noncanonical/revoked/draft/unsafe content, and performs no extra inference. It does not invent a solved marker or treat sorted IDs as final answers.
- Existing approved operator Skill, per-Agent activation, permissions, original dashboard, model defaults, one-round limits and supervision remain unchanged. No installed files or host configuration are edited.
- Parent reran 49 Node regressions, 142 relevant Python tests, and 10 packaging tests: all passed. Source lint has zero errors and the prior generic CSS warning; original renderer/CSS stay unchanged. All tests use simulated software fixtures, not mathematical computation or real inference.
- Build `hana-danus-024-proof-result-20261031a` passed archive smoke and official validation. Installation `stg_611d3b74623c37e3` was confirmed installed. The installed `result` action returned the complete real accepted fact `7417424ae36a2ed7` and its empty predecessor list from `cube-minus-n-app-live`, with `source: fact_graph`, `engine: bundled`, and `storage: app`; no new inference was launched. A fresh assistant's end-to-end behavior is not yet live-tested.

## 0.2.3 current-project binding correction

- The current valid App-owned run is authoritative over a stale URL hash on initial load and remount. Storage refreshes reconcile against the selected project, so a same-owned notification cannot leave an older view stranded.
- Changes are limited to the invisible bootstrap's selection/reconciliation, its regressions, patch version, and documentation. No original HTML/layout/renderer/CSS, backend/lifecycle/API, permissions, or operator Skill changes. No extra controls, polling, or inference.
- Node syntax and 45 Node regression tests passed; packaging suite passed 10 tests. Regressions include the exact stale-hash/current-project pair, all four read routes, closed-page reopening without a new event, persisted-page recovery, stable same-project updates, and real project changes. Archive build/validation passed; official installation `stg_2871434e804b92e2` is confirmed installed. Live display remains unverified.
- The prior 0.2.2 installed proof chain produced real App-owned fact `7417424ae36a2ed7` for `cube-minus-n-app-live`; this patch reuses that data and does not run another proof.

## 0.2.2 control-task compatibility

- Agent tool actions use the public App-scoped one-shot task handler. Only an opaque request ID is persisted; inputs stay private and each request is consumed once. Reload or replay cannot launch another round.
- Adds the reviewed `app/tasks.manage` declaration; no host edits, unsupported runtime scope fields, or UI changes.
- Local operation wait is 20 seconds, schedule cleanup 2 seconds. The host drains outgoing RPCs before returning and can still impose its own 30-second RPC timeout on a hanging API. Accepted in-flight work remains owned; inspect status/stop before another run.
- Worker lifetime supervision uses public App-scoped 10-second lifecycle checks and a 660-second cleanup deadline, avoiding a streaming body-read RPC across tool calls. It performs only runtime inspection/cleanup, never new inference. Stop removes the lifecycle schedule.
- Lifecycle schedule removal confirms absence before clearing stale IDs, tolerates confirmed removal races, and preserves real permission/host failures.
- Node syntax and 43 Node regression tests passed. Packaging suite: 10 passed. Source lint: zero errors, one generic CSS warning. These are software tests, without live inference.
- Earlier 0.2.1 was formally installed and its account tool confirmed the standard configured login/model. Its `cube-minus-n-live` run failed before verifier/worker launch with `APP_RUNTIME_INVALID_INPUT`, caused by the host injecting a tool callToken into local-machine runtime.start. No accepted App-owned fact was produced.
- 0.2.2 still needs formal review for the new task grant and separate installed-App proof acceptance. Detailed build/install/live evidence is maintained in `docs/hana-app-acceptance.md` in the source project.

## UI correction: original layout only

- Removed all added visual controls/messages: no task form, project picker, retry button, account/model/status widgets, or custom CSS link.
- `ui/panel.html` now matches the entire upstream document after normalizing only local asset URLs and the final module bootstrap script. The upstream banner/header/nav/main remain unchanged.
- `ui/assets/panel.css` is retained as an unused comment-only file. Upstream renderer `app.js` / `style.css` are untouched and still staged byte-for-byte.
- `panel.js` is only the invisible read-only Hana bootstrap/fetch bridge. It uses monitor start/state/projects and the public `hana.storage.global.get/onChanged` APIs for `danus-owned-run-v1`; no task run/stop/account/status calls or storage writes originate from the page.
- Initial selection now prioritizes the current stored App-owned project over an existing historical hash (corrected in 0.2.3). Agent-run storage changes mount the first project or reload the original renderer for a new project. Empty App shells remain original, without invented facts/messages. No extra status timers were added; original renderer polling stays unchanged.
- Agent operations remain in the existing App-owned Danus tool/operator skill. Backend, manifest, tool, and operator skill were not modified by this UI correction.
- The user-approved local-machine runtime can reuse standard Codex login/configuration but is not filesystem-isolated. No credentials are copied into App data/package.

## Actual validation

- `node --test tests/hana_app/test_panel_js.cjs tests/hana_app/test_app_control.cjs tests/hana_app/test_runtime_cwd.cjs` — **24/24 passed** (13 panel tests, 10 mocked backend-control tests, 1 cwd test).
- `python3 -m unittest discover -s tests/hana_packaging -p test_build.py -v` — **10/10 passed**, including whole-body/document normalization parity and staged upstream renderer byte equality.
- These are software tests with mocked runtime/storage/API responses and temporary fixture files. They perform no mathematical computation or actual model/worker/verifier launch.
- No actual build/install, installed App/settings modification, App tool invocation, credentials inspection, commit, or push was performed for this correction.
- **Still untested:** live Hana UI/storage-event delivery, real permission grants/account reuse, actual managed engine startup, one real bounded worker/verifier round, live stop, and production/display of a real accepted fact. Parent must provide evidence before claiming these work.
