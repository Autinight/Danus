# Hana Danus — installation and acceptance evidence

## 0.2.6 initial host stylesheet correction

The App now explicitly consumes the initial public `hana.theme.getSnapshot().cssUrl` before mounting the original renderer. Initial loading has a 10-second bound, rejects failed/empty/missing-theme CSS, and uses the existing banner for a safe error without exposing the host URL. Initial CSS reserves its cascade position before fetching. Later host CSS must work independently before the initial style is retired; optional old tokens cannot persist, and a delayed initial response cannot revive the old table. Persisted pagehide preserves the shared ready promise while pausing subscriptions and animation frames.

Parent verification: Node 74/74, packaging 10/10, JS syntax and diff checks. Regression uses the real bundled SDK with no first theme event and real ECharts SVG, plus delayed responses, error/timeout, theme handoff and BFcache. App static check has 0 errors and one existing upstream display/[hidden] warning. Official archive validator has 0 errors and one dynamic-dependency warning; archive smoke passed. These are software checks, not live visual acceptance.

Unique artifact: `dist/hana-danus-0.2.6-darwin-arm64-hana-danus-026-initial-theme-20261031a.zip`, 193188967 bytes, archive SHA-256 `51b72034975c1acf76e0d0581b646950c616b91c8962ae2bd2d58df0b16a5564`. Parent independently rechecked SHA-256 and the official archive validator. All 2894 archive files match staging. Relative to 0.2.5 only README, dev-state, manifest, build inventory, panel.js and theme.js differ; no files or permissions were added or removed. SDK, backend/service, index, panel CSS, HTML and original renderer/CSS are unchanged. Archive path checks found no private projects/worker memory or credential files; no credential contents were read. No real model/worker/verifier or mathematical experiment was run.

Official update review `stg_a36b16a83e10dcef` is pending the user's decision. Installer identity `c4dcb258bba80c457506f245d7f74c050bc76e865440b5e41c6a2075c1c04f74` is distinct from the archive SHA-256. The immediate pre-update App-owned status read confirmed the current project finished with no active worker. The agent did not confirm installation. Installed activation and real Hana background/bar colors remain unverified; read this original stagedId after the user's decision and do not equate fixture tests with the operator's screen.

## 0.2.5 Hana-derived dashboard colors

The App now maps the original dashboard's surfaces, text, borders, links, status tints, graph depth scale/nodes/edges, tooltip, error text, selection, focus and scrollbars to public Hana theme tokens. It uses the SDK's existing host stylesheet loader, observes asynchronous stylesheet changes, and refreshes native ECharts color values. Public appearance metadata controls only the document's color-scheme. No host configuration, theme-management permissions, mathematical inference, account, backend, or data migration is added. The original body and renderer/CSS bytes remain intact. ECharts preserves node identity and roam state, but recoloring can restart force relaxation; frozen coordinates are not promised.

Parent validation passed 62 Node tests, 142 unchanged backend Python tests and 10 packaging tests, syntax checks and `git diff --check`. Source lint reports zero errors and the existing generic hidden/display warning. Tests include the real bundled ECharts static SVG software fixture; they do not establish live WebView appearance. Source/staged theme module, CSS, bootstrap and HTML match; original renderer/CSS and the operator Skill remain unchanged.

Final build `hana-danus-025-hana-theme-20261031a` passed archive smoke and official archive validation (zero errors, one dynamic-resource warning). Archive `dist/hana-danus-0.2.5-darwin-arm64-hana-danus-025-hana-theme-20261031a.zip` is 193,186,763 bytes with SHA-256 `aafb54d2d88de58603208956470f2f2556a00548adafd9ebdbedf2ebecb9c984`.

Official status confirmed update review `stg_3bfe676139fcb8f0` installed after the user's decision. Its installer identity is `e9c1853d27c38e626d83ba6e5fbd68506f8ef6f63691a84833d789d4cdf042f4`, distinct from the archive SHA-256. A pre-update App-owned status read confirmed no live worker. No installation confirmation was performed by the agent.

**Visual acceptance failed.** The operator supplied real screenshot SessionFile `sf_50056efd99f19f5a`: the page remained white with upstream blue-purple bars instead of Hana's warm background and muted accent. Source tracing then confirmed that the packaged SDK only loads CSS after a theme-change event, while the host skips its initial theme notification. Initial metadata alone therefore leaves the initial stylesheet unloaded. The actual App CSS endpoint emits canonical unprefixed tokens; the prefix-only Interactive Card contract was investigated and ruled out as this root cause. The earlier software tests and source review did not exercise this cold-start interaction and do not override the operator's screenshot.

## 0.2.2 App-scoped control correction

The App tool now uses the published App-scoped one-shot schedule/handler API, with the additional `app/tasks.manage` declaration. Inputs remain in a private pending map; only an opaque one-use request ID is scheduled. Replayed, expired unstarted, or recovered requests cannot dispatch again. No unsupported runtime fields, host modifications, extra workers, automatic proof rounds, or visible panel controls are introduced.

A source review identified the outer tool RPC deadline as 30 seconds. The App's local operation wait is 20 seconds and schedule cleanup is bounded to 2 seconds. This is not an absolute host-visible deadline: the host drains pending outgoing RPCs before returning a tool result. In particular, a long-lived worker watch holds an HTTP body-read RPC open. That supervision path has been replaced by public App-scoped lifecycle checks every 10 seconds, with owned-runtime cleanup at 660 seconds, never by extra inference. If an entered operation exceeds the local wait, its safe error directs the caller to status/stop before another run; a hanging host API can still cause the host's own RPC timeout.

Validation: Node syntax passed; final Node control/UI/cwd suite passed 43 tests; packaging suite passed 10 tests; source lint reported zero errors and one generic hidden/display warning; `git diff --check` passed. These use mocks and fixtures and do not prove a live mathematical run. The original renderer and stylesheet were compared byte-for-byte with the staged package, and source/staged entrypoint, manifest, and README matched.

Intermediate build `hana-danus-022-appscope-20261030a` passed archive smoke and official archive validation (zero errors, one dynamic-resource warning), but is superseded before installation because the long-lived watcher/host-drain interaction still needs correction. Its size was 193,177,007 bytes and archive SHA-256 `9f9b077898d4b6e3c164124915fa6f27462f83893d2ab9243eeedbf5c2d22bde`. Do not install this intermediate artifact. Installation, task grant, and a verifier-accepted App-owned fact remain unconfirmed at this entry.

Intermediate build `hana-danus-022-appscope-20261030b` corrected the lifetime watch interaction. Archive smoke and official archive validation passed (zero errors, one dynamic-resource warning); size 193,178,316 bytes; archive SHA-256 `4b21e6c090969f43306f4c098958fb3faa58a484405c2d9168a91943a52e473f`. Node regression passed 40 tests and packaging regression passed 10 tests; source/staged comparisons passed. A further review found that the mock allowed unscheduling missing IDs, while the actual SDK rejects them. The missing-schedule recovery path now confirms absence and clears the stale ID, without suppressing permission/host failures; strict-mock tests cover recovery, stop, removal races, and real permission failures. Build b is also superseded before installation; do not install it. These software checks do not establish installed inference or a fact.

Final candidate `hana-danus-022-appscope-20261030c` includes that recovery correction. Archive smoke and official archive validation passed (zero errors, one dynamic-resource warning); size 193,178,535 bytes; archive SHA-256 `30ea0de3c8793565a9c1da9f4c7cfcee6e8d592c90b95dbe9d6376536c060641`. Final Node suite passed 43 tests; packaging suite passed 10 tests; syntax, source lint, `git diff --check`, source/staged entrypoint/manifest/README/development notes, and original renderer/CSS comparisons passed. The narrow read-only review confirmed the missing-schedule blocker resolved.

Formal installation review `stg_88fddcc80033edca` was confirmed **installed** through the official status action after the user's decision. That read did not perform installation or confirmation. The installer identity is `16e70ead89b7dac8f4a0d5352304743a721fbc93c3126c648f548550015516a6`, distinct from the archive SHA-256. The only additional capability is `app/tasks.manage`; previous runtime/tool grants remain declared.

## 0.2.2 user-authorized live proof acceptance

The installed App-owned tool was rediscovered and its schema inspected. Its account action returned `logged_in: true`, configured model `gpt-6.1-sol`, `engine: bundled`, and `storage: app`. The previous failed `cube-minus-n-live` remained separate, with no accepted facts and no launched worker.

The user's requested small-problem run was submitted through the installed App tool, with project `cube-minus-n-app-live`, one high worker, model unset, and a strict text-only proof task: for every integer n, 6 divides n³−n, including zero and negative integers. The tool returned `running`, effective model `gpt-6.1-sol`, `workers: [high]`, one round, a 600-second worker bound, bundled engine, and App-owned storage. App-owned PROBLEM.md contained that exact task, and the worker lifecycle record showed a real PID and round 1 running. No checkout Danus/Python/Codex CLI was used for the mathematical run. A read-only filesystem event watcher observes only the worker lifecycle file; it does not execute mathematics or control the engine.

### Confirmed result

The installed App tool subsequently returned `state: finished`, `fact_count: 1`, `verified_fact_ids: [7417424ae36a2ed7]`, and `last_verdict: correct`. Its real high worker reached round 1 `max_rounds`, exit code 0, no PID and `alive: false`. This run used the bundled App engine and App-owned data, not the checkout engine.

The canonical App-owned fact `projects/cube-minus-n-app-live/fact_graph/facts/7417424ae36a2ed7.md` was read directly after that response. It states the complete theorem for every integer, has no predecessors or external references, and contains a self-contained symbolic proof: factor n³−n into three consecutive integers; establish N=2u and N=3v by complete integer-remainder cases; obtain N=3N−2N=6(u−v). It explicitly covers zero and negative integers.

The matching verifier entry in App-owned global `verification.jsonl` is timestamped `2026-10-30T13:26:03.614546+00:00`, carries the same fact ID, verdict `correct`, `write_error: null`, `critical_errors: []`, and `gaps: []`. Global memory alone is not treated as truth; the accepted canonical fact plus App fact-graph listing establish storage success. The worker's diagnostic `last_fact_id` remained null, so the accepted fact graph/list—not that diagnostic field—is the result source.

The App tool's stop action returned success with `state: stopped` and retained the accepted fact. A subsequent status check confirmed no live worker, round 1 complete, `last_rc: 0`, the same single fact ID, and verdict `correct`. Its lifecycle state was `finished`, as the worker had already exited naturally before stop; no extra proof round was launched. The stop implementation awaits owned worker/verifier cleanup and rejects when termination cannot be confirmed. No manual process signaling or repository engine control was used.

**Acceptance achieved for the installed App's account → bounded worker → verifier → durable accepted fact → cleanup chain.** Live dashboard rendering/storage-event delivery remains unverified: the last exact-card inspection was not mounted. No UI appearance claim follows from this proof run.

A live exact-instance inspection at 2026-10-30 11:53 UTC found dashboard card `wb-card-plugin-webview-card-mvroguyb-2` still open but not mounted or visible. Its state was empty. No live rendered layout, storage-event delivery, or fact display is established by that inspection; no alternate card/browser was substituted.

## 0.2.1 corrective release

The operator requires the original visual dashboard and agent-only mathematical operations. The correction removes all added forms, task buttons, project selectors, retry controls, and custom stylesheet references. The complete original document is preserved except for local asset URLs and the invisible Hana bootstrap script. The panel only starts/reads the monitoring service and follows the current project through App storage; it never calls task run/stop/account/status APIs. The agent retains the installed App-owned task tool.

Account resolution now uses the OS account record, independently of Hana's temporary runtime HOME and inherited CODEX_HOME. The six-file Python account/controller/launcher/gateway regression passed 146 tests in 4.94 seconds. A read-only review found no definite blocker in the corrected source.

Final build `hana-danus-021-original-panel-20261030b` completed and passed archive smoke and official archive validation (zero errors, one dynamic-resource warning). Archive: `dist/hana-danus-0.2.1-darwin-arm64-hana-danus-021-original-panel-20261030b.zip`; SHA-256 `bd66117bec524a1a3cca3eb04ea5fc3abb1280063ddd7baddbbbbe4e564dbebe`; size 193,175,570 bytes. Source/staged HTML, bridge, account helper, README, and upstream renderer/CSS byte comparisons passed. Final UI/control regression passed 24 tests; packaging regression passed 10 tests, including whole-document/body equality after only asset/bootstrap normalization.

The official 0.2.1 replacement review is `stg_2b0b8ab576d57a0e`, confirmed installed by the official status tool. Its installer identity is `a6df5dda2cf8c9b5bb709e1a8bfbcd708869229caba74945042b4c67f362614e`, separate from the archive SHA-256. Permission declarations and operator Skill content do not expand relative to 0.2.0. The installed App account tool then returned `logged_in: true`, model `gpt-6.1-sol`, bundled engine, and App-owned storage.

The user-authorized App tool run for `cube-minus-n-live` (prove that 6 divides n³−n for all integers) failed with `APP_RUNTIME_INVALID_INPUT`. Actual App status showed the high worker still `created`, round 0, no PID, no accepted facts, and state `error`. The App-owned problem/project files were created, but no verifier/worker launch is established. Do not report this as a mathematical run success.

Diagnosis was confirmed against the installed host source: `app-host-entry.js:3914–3923` puts agent tool execution in call-token context; `:4042–4045` automatically injects that token into all methods named start, including runtime.start. Host runtime validation at `scripts/app-validation-smoke.mjs:15852–15853` rejects callToken for local-machine. The public runtime contract contains no scope suppression option. The correction uses the public App-scoped one-shot task handler with an additional reviewed `app/tasks.manage` grant; no unsupported runtime fields or managed host edits are allowed. The original panel remains unchanged. Version 0.2.2 is being prepared for that correction; the theorem is not yet proved in App-owned storage.

The source linter reported zero errors and one generic hidden/display CSS warning. The original connection banner has no display override, added hidden controls are removed, and the upstream CSS is preserved. This warning does not justify changing the original panel stylesheet.

## 0.2.0 installation history

- Build: `hana-danus-020-integrated-20261030b`.
- Archive: `dist/hana-danus-0.2.0-darwin-arm64-hana-danus-020-integrated-20261030b.zip`.
- Archive size: 193,179,377 bytes.
- Archive SHA-256: `4022643da96ffd4282322147ac2c1e07d93448a502a4e0ccd066375241b57e5a`.
- Formal Hana update review: `stg_9c35ce900d07493b`, confirmed `installed` through the official status tool. The App-owned Danus tool became discoverable and the App was active for the current agent.
- The installer reported package/declaration hash `7e9b37d17aca9d31e02f662d0299ef593dbbd41c98089a5904c37cb9b91721df`; this is a separate installer identity, not the archive SHA-256 above.

This candidate includes the bundled monitor/controller, original Danus worker and verifier, App-owned task tool and operator Skill, original dashboard assets, and explicit stop/cleanup. It removes the external projects-directory setting. The engine and each proof process use Hana-managed runtimes; project data and facts belong to `sdk.dataDir`. The normal local Codex account/configuration is referenced without copying credentials.

## Completed verification

- Final Node control/UI regression: 31 passed.
- Final Python controller/launcher/gateway/execution/verifier regression: 132 passed in 4.24 seconds.
- Earlier packaging unit suite: 10 passed. The final candidate also passed the build's archive smoke.
- Final archive validation: success, zero errors, one warning that static checks cannot prove dynamic resources.
- Final narrow lifecycle review: startup rollback and explicit Stop clear the persisted `launching` flag; a failed startup reports an error. No definite blocker in that narrow change.
- `git diff --check`: passed.

The final official isolated Electron smoke did **not** pass. The backend loaded, the page rendered, the SDK handshake passed, and there were no renderer exceptions. One same-origin App API request returned 403. Inspection of the installed smoke runner showed its synthetic permission ledger grants tool exposure and selected provider/document permissions, but does not grant runtime execution/local-machine/network. This environment cannot demonstrate authorized engine startup. No validator or platform permission ledger was edited to make the smoke pass.

An earlier smoke attempt selected Node 22 and failed the runner's Node >=26 preflight. The final attempt used Hana's bundled Node 26.12.1. These are distinct attempts and neither proves production acceptance.

## Permission boundary

The update requests `app/runtime.execute`, `app/runtime.local-machine`, `app/runtime.network`, and `app/tools.expose-to-model`, plus user review of the App's changed operator Skill. Only the user can approve that formal review.

The local-machine profile has no filesystem isolation. Native processes can access files available to the current local user. Danus uses its existing Codex approval/sandbox-bypass launch parameters. App-owned storage is not a claim of filesystem isolation. Actual mathematical runs consume model usage.

## Remaining production acceptance

After user approval, read the original staged review status, inspect the installed App and its actual tool, check the safe account summary, and submit a new bounded small theorem through the App-owned tool. Confirm a verifier-accepted fact exists in the App-owned fact graph, inspect the original live dashboard, and confirm worker/verifier termination. Do not substitute repository execution, sample facts, mocks, an exit code, or a verifier log for this evidence.

The installed 0.2.0 tool returned idle status with no project and no accepted facts. Its account check returned `logged_in: false` and `model: null`. Source inspection confirmed Hana gives runtime processes a temporary `HOME`, while the App had incorrectly used `Path.home()` to locate the standard Codex account. A correction must resolve the OS account home independently of runtime `HOME` without reading or copying credentials.

The operator rejected the added task form and other visual changes. The required interface is the original Danus dashboard, with all mathematical task operations performed by the agent through the App-owned tool. The 0.2.1 correction subsequently removed those visual additions, preserved the original body/layout and renderer assets, and fixed account resolution, as recorded above. No 0.2.0 installed-App mathematical run or accepted App-owned fact has been demonstrated. The earlier genuine repository-based odd-sum proof remains separate evidence and is not an App acceptance result.
