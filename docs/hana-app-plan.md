# Hana Danus macOS App — agent operations, original dashboard

The architecture is **real bundled Danus operated by the agent, with the unmodified upstream dashboard as the read-only page**. It is not a custom task-entry UI, a recreated graph, or a monitor requiring an external checkout/directory setting. Installed App/settings are outside this source correction.

## Ownership and interface

1. The App bundles macOS arm64 Danus, relocatable CPython/dependencies, matching Codex native files, browser libraries, and licenses. Projects and durable run state belong to App data. No credentials or installation-time downloads/package managers belong in the package.
2. Mathematical run/status/stop/account operations belong only to the agent through the discovered, authorized App-owned `danus` tool and its existing operator skill. The backend/tool owns model defaults, bounded workers/rounds, verifier lifecycle, persistence, and stop. This UI correction leaves backend/tool/manifest/skill unchanged.
3. The page preserves the **entire original upstream document/layout**, including connection banner, header, navigation, Overview, Fact Graph, and Global Memory. Only asset URL replacements and the final module bootstrap script differ. There are no added forms/buttons/selectors, account/model/status widgets, custom empty text, or custom stylesheet. Keep `panel.css` as an unused comment-only file; do not delete it.
4. Copy upstream `app.js` and `style.css` byte-for-byte. Original rendering and refresh stay upstream. The page adds no task polling/timers and never calls task run/stop/account/status endpoints, writes storage, resets jobs, or starts inference.
5. The invisible bridge uses `hana.api.fetch` for monitor start/state/projects and exact project-scoped upstream dashboard GET mappings. Bounded bootstrap failures appear only in the original connection banner, preserving safe backend code/message as text.
6. Read the current project from `danus-owned-run-v1` using public `hana.storage.global.get`. A valid existing project hash may initially select history; otherwise prefer the stored App-owned project, with a safe existing project fallback if no current run exists. Subscribe with `hana.storage.global.onChanged` before initial reads so concurrent changes are not lost. Agent-started project changes mount the first original renderer or update hash/reload the same document. Same-project changes do not repeatedly reload. Page lifecycle releases/restores the subscription.
7. Empty App state leaves the original shells untouched and subscribed for the first agent-started project. Do not invent facts, add messages/widgets, or interpret an empty project list as a connection failure.

## Correctness and permission boundary

The agent's requested default bounded work is one high worker, one round, with the existing standard Codex configured model unless overridden. All mathematical work remains text-only: no executable checks/experiments, CAS, or proof assistants. Task `finished`/`stopped`/`error` states do not prove a theorem. Only real verifier-accepted facts in the original graph are mathematical evidence; global memory and hypotheses are not facts.

Managed `local-machine` execution requires explicit user approval and **does not provide filesystem isolation**. It can access current-user-readable files, including the local user's standard Codex login/configuration. Reuse that login through the authorized backend; never copy credentials into App storage/package, request tokens in chat, or bypass a missing grant/login. App-owned storage is a data-management boundary, not an isolation claim. Keep service authentication backend-side; same-user processes are outside the loopback token's protection boundary.

## Acceptance and software evidence

- Compare the whole upstream body after normalizing only the final bootstrap script; compare the whole document after additionally normalizing local asset URLs. Require no added forms/buttons/selectors or CSS.
- Require staged renderer JS/CSS byte equality, strict same-origin GET mapping, bounded bootstrap/error behavior, current-owned-project selection, historical hash precedence, storage change following (including initialization races), empty-to-first-project mounting, and read-only reload.
- Run the combined panel/backend-control/cwd Node suite and packaging unittests with mocks/temporary fixtures only. Do not build/install or start real models/workers/verifiers for this correction.
- Actual UI correction results: **24/24 combined Node tests passed; 10/10 packaging unittests passed**. These are software results, not evidence of live Danus execution.

Live Hana rendering/storage notifications, final archive/installation, permission grants, actual account reuse, engine startup, a real bounded worker/verifier round, live stop, and accepted-fact production remain **untested** until the parent demonstrates them. No real run is claimed. Optional publication dependencies (Chrome/TeX/report renderers) remain outside this core integration.
