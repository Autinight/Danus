---
name: danus-operator
description: "Operate the installed Hana Danus App for a user's proof/research task: submit a problem for one bounded Danus round, inspect real verifier-accepted facts and worker status, or stop a task. Use for requests to run Danus, check Danus progress/facts, or stop a Danus project inside Hana; do not use an external repository CLI or configure project directories."
compatibility: "Requires the Hana Danus App installed, its App-owned Danus tool discoverable, and user approval for local-machine execution/account reuse. No additional dependencies or copied credentials."
---

# Danus operator

Use the real bundled Danus engine through the **App-owned `danus` tool**. Treat its returned state and the original dashboard as observations, not as a substitute mathematical correctness gate.

## Discover and authorize

1. Discover the installed App-owned Danus tool with Hana's tool search and inspect its full schema/help before invoking it. Verify App ownership; do not assume that an unrelated tool with a similar name is authorized. Use the actual tool's run/status/stop actions and argument schema; do not guess an API invocation from a tool name.
2. If the App/tool is not installed, unavailable, or ungranted, report that boundary. Use official App management/permission flows only when the user authorizes them. Do not invoke the tool as an installation probe, inspect installed credentials, edit platform settings, or bypass denied permissions.
3. Explain the permission accurately when relevant: `local-machine` execution is **not filesystem-isolated** and reuses the local user's already logged-in standard Codex account/configuration. User approval is required. Never ask for tokens in chat or copy credentials into the package/App data. A safe account summary can report login/model, not paths, secrets, account files, or token values.

## Run one bounded round

- Obtain the user's problem text. Keep the mathematical work text-only: no executable experiments/checks, brute force, numerical sweeps, symbolic algebra, proof assistants, SAT/SMT, or CAS. Carry that restriction into every task you submit.
- Respect a request to inspect progress or stop: do not start a new run as a side effect. For a requested run, submit the problem using the discovered tool's run action with **`workers: 1`**, optionally a safe project ID/model. Use one **high** worker for this task. The engine enforces **one round per worker**. Do not auto-chain rounds, add workers, or silently escalate usage.
- Leave model unset unless the user selected one: omission reuses the standard account configuration. Leave project unset to create a project, or use the user's existing safe project ID. Project IDs are identifiers, never paths.
- Use bundled engine/App-owned data. Never run a checkout's `danus`/Python/Codex CLI, configure `projectsRoot`, choose an external project directory, or introduce an external repository dependency as a workaround.
- After submission, retain the returned project ID. Report the effective model/workers and bundled/App-data ownership when present. The dashboard follows that project and renders the original Overview/Fact Graph/Global Memory; do not create demo facts or a substitute graph.

## Status and stop

- Use the tool's status action with the known project ID; omit it only when the tool's schema supports its current-project default. Report `state`, workers, `fact_count`, and `verified_fact_ids` from real responses. Avoid rapid polling or launching additional work merely because a round has ended.
- `running`, `finished`, `stopped`, and `error` describe task lifecycle. **Finished does not mean the theorem is solved.** Global memory, worker messages, hypotheses, and unverified drafts are not facts. Cite only actual verifier-accepted facts; never submit invented facts or assert the target is proved from a round status/count alone.
- On an explicit stop request, use the App tool's stop action for the intended project, then read status to confirm. Do not delete project data or stop the whole App runtime to imitate task stop. No browser confirmation dialog is needed.
- Surface concise safe backend `error.code`/`error.message` exactly. Distinguish denied capability, missing login, invalid input, busy task, and engine failure; do not label every failure a permissions issue. Do not auto-retry run after an ambiguous timeout: inspect status first to avoid duplicate work.

## Validation/reporting boundary

Software implementation tests use mocks/fixtures only. Never invoke a real model, worker, verifier, proof assistant, CAS, or mathematical computation for a test. A user-authorized live task is not a smoke test: keep it one high worker/one round and respect the text-only restriction.

Until installation/grant and a real run are separately demonstrated, explicitly mark installed runtime, account reuse, worker/verifier execution, live stop, and accepted-fact production **untested**. Report changed files/software-test results separately from real Danus evidence. Do not install, publish, commit, or change installed settings unless separately authorized.
