# Hana Danus App packaging

Run from the Danus repository root on macOS arm64. Pass the exact runtime roots and Creator packer explicitly; the build ID is unique per run and becomes the staging directory and suffix on the archive outputs.

## Source and local prerequisites

Keep the engine and App adapter in the same checkout. Supply a standalone CPython
3.12 distribution, installed Python dependencies matching
`apps/hana-danus/dependencies.lock.json`, the pinned macOS arm64 Codex package,
and the official Hana App Creator packer. These local toolchains are not committed.
The SDK and browser distributions needed by source tests are already checked in.

The canonical browser dependency manifests are committed in `ui-vendor/`. Prepare
the ignored local vendor tree without changing the locked versions:

```sh
mkdir -p runtime/hana-vendor
cp scripts/hana-app/ui-vendor/package.json scripts/hana-app/ui-vendor/package-lock.json runtime/hana-vendor/
npm ci --prefix runtime/hana-vendor --ignore-scripts
```

The tracked manifests preserve the exact lock used for the 0.2.6 build. Deliberate
browser dependency updates must update both manifests and the checked-in browser
assets, integrity inventory, and license files. Do not commit `node_modules/`,
Python runtimes, staging trees, authentication files, or generated ZIPs.

## Build

```sh
python3 scripts/hana-app/build.py \
  --python-source /path/to/standalone-cpython-3.12 \
  --site-packages /path/to/danus-venv/lib/python3.12/site-packages \
  --codex-source /path/to/@openai/codex-darwin-arm64 \
  --codex-license scripts/hana-app/CODEX-LICENSE.txt \
  --vendor-root runtime/hana-vendor \
  --pack-tool /path/to/hana-app-creator/scripts/pack_app.mjs \
  --id hana-danus-build-001
```

The builder verifies the Python installed-distribution file hashes recorded in `apps/hana-danus/dependencies.lock.json`, stages the App at `runtime/hana-app-build/<id>/hana-danus`, runs the official Creator packer, checks the generated ZIP, and emits `dist/hana-danus-<version>-darwin-arm64-<id>.zip` plus matching `.entry.json`. `--validate-only` stages and inventories the App without invoking the packer. `--refresh-lock` regenerates the Python lock from the specified installed site-packages tree; do this only when intentionally changing the exact pins in `apps/hana-danus/requirements.txt`.

The vendor step runs automatically from `runtime/hana-vendor/package-lock.json` and `node_modules`. It copies the locked ECharts, KaTeX, and markdown-it distributions to `ui/vendor/`, including KaTeX fonts. `ui/vendor/vendor-integrity.json` records npm SRI values, locked versions/licenses, and SHA-256 hashes for staged assets and legal files; `NOTICES.txt` and per-package license/notice files are included alongside them. The tracked `scripts/hana-app/ui-vendor/package-lock.json`, copied unchanged into that local vendor tree, is the version and npm-integrity authority.

The package omits Node.js, PDF/TeX, Chrome/Chromium, and renderer-only dependencies. Credentials and Codex authentication are never packaged or copied. The agent uses Hana's App-owned `danus` tool to start the bundled `service/engine.py`, `verify.py`, and `worker.py` through managed local-machine runtimes; all mathematical projects, accepted facts, verifier reports, and worker control records use the App's own data directory. They reuse the standard already logged-in Codex home by reference. Codex may maintain its own normal account/session state there. Installed users need no repository checkout, external project-directory setting, or manual CLI invocation for proof tasks. Initial Codex account/model setup remains a prerequisite; the App does not yet provide login or provider settings. The normal installation review must grant local-machine execution, model-tool exposure, and App-owned task management. Agent tool operations use a public App-scoped one-shot control task; expired or recovered request IDs do not start another proof round. Worker lifetime supervision uses short App-scoped runtime-state checks, without a long-lived streaming RPC; these checks never add inference. Validate the installed App separately from archive checks; passing ZIP and mocked tests does not prove a live App-owned proof run.
