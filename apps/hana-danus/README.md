# Hana Danus

A Hana v2 App for bundled Danus on macOS arm64. **Mathematical operations belong to the agent; the page is a read-only Danus dashboard with Hana-derived colors.** Projects/run state live in App data, without external checkout or project-directory setup. Software regression results and installed-App acceptance are recorded separately in `dev-state.md` and `../../docs/hana-app-acceptance.md`.

## Original layout, Hana-derived colors

The whole-page card is `dashboard` at `/panel.html`. Its connection banner, header, navigation, Overview, Fact Graph, and Global Memory retain the upstream body/layout exactly. Document differences are packaged asset URLs, the final Hana module bootstrap script, and the App-only `ui/assets/panel.css` theme override. There are **no** forms, task controls, project picker, retry button, account/model widgets, or custom messages.

The build copies `danus/observability/static/app.js` and `style.css` byte-for-byte into `ui/dashboard/`. Local ECharts, KaTeX, markdown-it, fonts, and licenses are bundled. The App theme adapter replaces only visual colors: surfaces, text, borders, links, status tints, graph nodes/edges/depth legend, tooltip, selection, focus, and scrollbars derive from public Hana theme tokens. Public appearance metadata controls only this document's native color-scheme. The App explicitly loads the initial stylesheet URL supplied by `hana.theme.getSnapshot()` before mounting the renderer. The packaged SDK provides theme metadata and follows later theme changes; the adapter refreshes existing canvas colors after asynchronous stylesheet changes. The initial load is bounded and reports missing/failed theme styles instead of silently presenting upstream fallback colors as the host theme. It does not switch the user's theme, read host configuration, add grants, reload the page for a theme change, or start inference. Original data rendering, navigation, and refresh behavior stay unchanged.

`ui/assets/panel.js` is an invisible read-only bootstrap/fetch bridge:

- Start/wait for the App monitor with `/monitor/start` and `/monitor/state`, then read `/monitor/projects`. Startup/read timeouts are bounded. Safe bootstrap errors appear only as text in the existing upstream connection banner.
- Read `danus-owned-run-v1` through the public `hana.storage.global.get` API. The valid current App-owned project takes precedence over any stale project hash on initial load and remount. A hash or safe existing project is only a fallback when no valid current project is available.
- Subscribe through public `hana.storage.global.onChanged`. A new agent-started project mounts the original renderer if the page was empty, or changes the hash and reloads the same original document if another project was displayed. Same-project or unrelated changes do not reload repeatedly. The subscription is released on pagehide and restored on a persisted pageshow.
- An empty App leaves the original shells untouched, with no invented facts, custom empty message, or connection error merely for having no projects. It remains subscribed for the first agent-run project.
- Map only the exact same-origin upstream dashboard GET endpoints to project-scoped `/monitor/*` requests through `hana.api.fetch`. Never call task run/stop/account/status routes, write storage, reset jobs, or start inference from the page. No additional status timers are used; only bounded request/startup waits exist in the bridge.

## Agent-only mathematical operations

After installation and permission approval, the user gives a mathematical problem in ordinary language. The agent discovers the App-owned `danus` tool, reads its schema and embedded workflow, submits `run`, retains the returned project ID, checks `status`, and retrieves each relevant `verified_fact_ids` entry with `result(project, fact_id)` before delivering the proof. `result` returns the complete canonical Markdown and predecessors, without private data paths, truncated proofs, or another inference run. Retrieve any needed predecessors through the same action. The existing reviewed operator Skill remains at `skills/danus-operator/SKILL.md`; this patch does not customize or change its activation. Do not ask the user to teach tool syntax, run an external checkout's CLI, or configure project directories.

A requested bounded round uses one high worker (`workers: 1`), one round, and the standard Codex account's configured model unless the user chooses an override. The existing backend/tool owns task execution, verifier lifecycle, state, and stop. The dashboard only follows the persisted project. No page interaction submits a problem or stops a worker.

Task states such as `finished`, `stopped`, and `error` are not theorem-completion certificates. Read the returned proof and check that it covers the user's full target and assumptions; neither a positive fact count nor the first/last sorted ID identifies a final theorem. Only real verifier-accepted facts in the original graph count as mathematical evidence; global memory, hypotheses, and worker messages are not facts. All mathematical work is text-only, without executable experiments/checks, CAS, or proof assistants.

## LLM and account setup (current limitation)

The App uses the installed user's **standard Codex account and configuration**.
It does not read Hana's model-provider settings, and it currently has no account,
API-key, endpoint, or model settings screen. A fresh installation includes the
Codex executable but does not register a global `codex` command or complete login
on the user's behalf.

1. Complete the official Codex login flow for the account that will run Hana. If
   Codex CLI is already available, use `codex login`; supported account and API-key
   authentication options are documented by Codex. Never send credentials in chat
   or put them in the extension package.
2. Set a valid top-level `model` in the user's standard `~/.codex/config.toml`, or
   explicitly request a supported model for an individual Danus run. The App
   resolves the OS account's `.codex` directory rather than Hana runtime `HOME`
   or a custom inherited `CODEX_HOME`. A model defined only inside a Codex profile
   is not used by the App's default-model resolver.
3. Give the mathematical problem to the authorized Hana agent. It checks login
   before starting. An explicit run model takes precedence; otherwise the
   configured top-level model is required (`model_required` if missing). Worker
   and verifier use the same selected model.

Changing a model ID does not configure a provider or grant model access. Arbitrary
third-party provider configurations are not an accepted compatibility claim:
provider API-key environment variables are not forwarded from the host. Installed
engine availability and end-to-end account/provider readiness are separate checks.

## Permission and account boundary

The backend requests managed execution, **`app/runtime.local-machine`**, runtime networking, tool exposure, and **`app/tasks.manage`** for its own one-shot control operations and runtime lifecycle checks. The **`local-machine` profile is not filesystem-isolated**: native processes can access files available to the current local user, including standard Codex login/configuration. Hana's explicit user permission review is required. App-owned storage is not a claim of filesystem isolation.

Reuse the existing standard Codex login through the authorized backend; resolve the account from the OS user record rather than the runtime's temporary HOME. Do not copy credentials into App storage/package, request tokens in chat, or bypass a missing grant/login. Browser code receives neither service tokens nor credential files and does not call loopback directly. The private authenticated loopback endpoint is not a security boundary against other same-user processes. Optional publication tools (Chrome/TeX/report renderers) are outside this core integration.

## Source validation and limits

```sh
node --test tests/hana_app/*.cjs
python3 -m unittest discover -s tests/hana_packaging -p test_build.py -v
```

These software tests use mocks/temporary fixtures, not real models/workers/verifiers. They cover whole-body/document equality after asset/bootstrap/theme-link normalization, byte-identical staged renderer assets, theme colors and canvas refresh with fixture tokens, strict fetch mapping, bounded bootstrap, public-storage project following, current-project precedence over stale hashes, closed-page reopening and persisted-page recovery, empty-to-first-project mounting, read-only reload, and backend controls with mocked runtimes.

Software tests do not establish installed-App acceptance. Report live Hana rendering/storage events, actual account reuse, managed engine startup, bounded worker/verifier execution, live stop, and accepted facts separately from these tests.

## App-owned control execution

Each agent tool invocation uses a reviewed App-scoped one-shot background control task. This is required on hosts whose tool bridge automatically attaches a session call token to `runtime.start`, while local-machine execution rejects session scope. The App uses only the published task schedule/handler contract; it does not add unsupported runtime fields or alter the host.

The private pending request is created only for the current authorized tool call. The schedule carries a request ID, without credentials or session authority. A missing, repeated, expired, or recovered request cannot start another round. The App's local wait budget is 20 seconds plus up to 2 seconds for schedule cleanup. The host's 30-second tool RPC limit and its RPC drain can still determine the final caller-visible error if a host API hangs. The App removes the one-shot schedule after dispatch. If an entered operation exceeds this wait, it can continue within the existing bounded, owned lifecycle: query status or stop before another run. This mechanism does not add panel controls, periodic inference, extra workers, or automatic round retries. Long-lived worker supervision uses App-scoped lifecycle checks every 10 seconds, with a 660-second cleanup deadline, instead of holding a streaming RPC open across tool calls. These checks inspect only owned runtime state, stop the verifier when workers exit, and remove the lifecycle schedule. They never launch another worker, proof round, or model request. Explicit stop also removes the lifecycle schedule. The new `app/tasks.manage` grant must pass Hana's formal permission review before use.
