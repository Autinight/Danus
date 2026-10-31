#!/usr/bin/env python3
"""Build the self-contained macOS arm64 Hana Danus App payload."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "apps/hana-danus"
LOCK = APP / "dependencies.lock.json"
EXCLUDED_PARTS = {"__pycache__", "tests", "test", "testing", "examples", "pip", "setuptools", "wheel", "node_modules", ".git"}
EXCLUDED_SUFFIXES = (".pyc", ".pyo", ".pth", ".egg-link")


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_source(path: Path, root: Path) -> Path:
    resolved = path.resolve(strict=True)
    base = root.resolve(strict=True)
    if not resolved.is_relative_to(base):
        raise ValueError(f"source path escapes its declared root: {path}")
    return resolved


def dist_map(site: Path) -> dict[str, Path]:
    found = {}
    for meta in site.glob("*.dist-info/METADATA"):
        text = meta.read_text(encoding="utf-8", errors="replace")
        name = re.search(r"^Name:\s*(.+)$", text, re.M)
        if name:
            found[canonical(name.group(1))] = meta.parent
    return found


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def dep_names(metadata: Path) -> list[str]:
    try:
        from pip._vendor.packaging.requirements import Requirement
    except ImportError as exc:
        raise RuntimeError("builder Python must provide pip's vendored packaging module") from exc
    text = (metadata / "METADATA").read_text(encoding="utf-8", errors="replace")
    names = []
    environment = {
        "python_version": "3.12", "python_full_version": "3.12.14",
        "sys_platform": "darwin", "platform_system": "Darwin",
        "platform_machine": "arm64", "platform_python_implementation": "CPython",
        "implementation_name": "cpython", "implementation_version": "3.12.14",
        "os_name": "posix", "extra": "",
    }
    for line in text.splitlines():
        if not line.startswith("Requires-Dist:"):
            continue
        requirement = Requirement(line.split(":", 1)[1].strip())
        if requirement.marker and not requirement.marker.evaluate(environment=environment):
            continue
        names.append(canonical(requirement.name))
        if "crypto" in requirement.extras:
            names.extend(("cryptography", "cffi"))
    return names


def record_paths(site: Path, metadata: Path) -> list[Path]:
    record = metadata / "RECORD"
    if not record.is_file():
        raise ValueError(f"distribution has no RECORD: {metadata.name}")
    entries = []
    for line in record.read_text(encoding="utf-8", errors="replace").splitlines():
        rel = line.split(",", 1)[0]
        p = PurePosixPath(rel)
        if p.is_absolute():
            raise ValueError(f"unsafe absolute RECORD path in {metadata.name}: {rel}")
        if ".." in p.parts:
            continue  # entry-point scripts outside site-packages are not runtime modules
        source = site.joinpath(*p.parts)
        if any(part in EXCLUDED_PARTS for part in p.parts) or source.suffix in EXCLUDED_SUFFIXES:
            continue
        if source.is_file():
            safe_source(source, site)
            entries.append(source)
    return entries


def direct_requirements(app_root: Path) -> dict[str, str]:
    pinned = {}
    for raw in (app_root / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = raw.partition("#")[0].strip()
        if not line:
            continue
        name, separator, version = line.partition("==")
        if not separator or not name.strip() or not version.strip():
            raise ValueError(f"runtime requirements must use exact pins: {raw}")
        pinned[canonical(name.strip())] = version.strip()
    return pinned


def make_lock(site: Path, app_root: Path = APP) -> dict:
    pinned = direct_requirements(app_root)
    packages = dist_map(site)
    pending = list(pinned)
    selected: dict[str, Path] = {}
    while pending:
        name = canonical(pending.pop())
        if name in selected:
            continue
        meta = packages.get(name)
        if not meta:
            raise ValueError(f"required distribution missing from --site-packages: {name}")
        selected[name] = meta
        pending.extend(dep_names(meta))
    for name, version in pinned.items():
        metadata = (selected[name] / "METADATA").read_text(encoding="utf-8", errors="replace")
        installed = re.search(r"^Version:\s*(.+)$", metadata, re.M).group(1).strip()
        if installed != version:
            raise ValueError(f"{name} version mismatch: required {version}, found {installed}")
    result = {"format": 1, "roots": sorted(pinned), "packages": []}
    for name, meta in sorted(selected.items()):
        metadata = (meta / "METADATA").read_text(encoding="utf-8", errors="replace")
        version = re.search(r"^Version:\s*(.+)$", metadata, re.M).group(1).strip()
        files = record_paths(site, meta)
        result["packages"].append({
            "name": name, "version": version,
            "files": [{"path": p.relative_to(site).as_posix(), "sha256": sha(p)} for p in files],
        })
    return result


def copy_checked(source: Path, destination: Path, source_root: Path, *, allow_symlink: bool = True, prune: bool = True, ancestors: frozenset[str] = frozenset()) -> None:
    """Copy while resolving only symlinks whose final target stays in source_root."""
    original = source
    if source.is_symlink():
        if not allow_symlink:
            raise ValueError(f"symlink not permitted: {source}")
        source = safe_source(source, source_root)
    if source.is_dir():
        identity = str(source.resolve(strict=True))
        if identity in ancestors:
            raise ValueError(f"cyclic directory symlink: {original}")
        destination.mkdir(parents=True, exist_ok=True)
        for child in source.iterdir():
            test_fixture = child.is_file() and (child.name.startswith("test_") or child.name in {"_fixtures.py", "fake_codex.py"})
            if prune and (child.name in EXCLUDED_PARTS or child.suffix in EXCLUDED_SUFFIXES or test_fixture):
                continue
            copy_checked(child, destination / child.name, source_root, prune=prune, ancestors=ancestors | {identity})
        shutil.copystat(source, destination, follow_symlinks=True)
    elif source.is_file():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination, follow_symlinks=True)
    else:
        raise ValueError(f"not a regular file or directory: {original}")


def sanitize_sysconfig(destination: Path, source_root: Path) -> None:
    configs = list((destination / "lib/python3.12").glob("_sysconfigdata*.py"))
    for config in configs:
        text = config.read_text(encoding="utf-8")
        text = text.replace(str(source_root), "@PYTHON_ROOT@")
        text = re.sub(r'("abs_(?:builddir|srcdir)": )"[^"]*"', r'\1"."', text)
        text = re.sub(r"/(?:private/)?tmp/[^\s\"']+", ".", text)
        text += (
            "\nimport os as _os\n"
            "_python_root = _os.path.dirname(_os.path.dirname(_os.path.dirname(__file__)))\n"
            "build_time_vars = {key: (value.replace('@PYTHON_ROOT@', _python_root) "
            "if isinstance(value, str) else value) for key, value in build_time_vars.items()}\n"
        )
        config.write_text(text, encoding="utf-8")


def copy_python(source: Path, destination: Path) -> None:
    base = source.resolve(strict=True)
    if not (base / "bin/python").exists() or not (base / "lib/python3.12/os.py").is_file():
        raise ValueError("--python-source must be the relocatable CPython 3.12 standalone root")
    copy_checked(base, destination, base)
    sanitize_sysconfig(destination, base)
    # These are build-time metadata and bundled installer tooling, not runtime.
    shutil.rmtree(destination / "lib/python3.12/config-3.12-darwin", ignore_errors=True)
    shutil.rmtree(destination / "lib/python3.12/site-packages/pip", ignore_errors=True)
    for meta in (destination / "lib/python3.12/site-packages").glob("pip-*.dist-info"):
        shutil.rmtree(meta, ignore_errors=True)
    for config in destination.glob("lib/itcl*/**/*Config.sh"):
        config.unlink(missing_ok=True)
    packages = destination / "site-packages"
    packages.mkdir(parents=True, exist_ok=True)


def install_locked_packages(site: Path, destination: Path, lock: dict) -> None:
    for package in lock["packages"]:
        for entry in package["files"]:
            rel = PurePosixPath(entry["path"])
            source = site.joinpath(*rel.parts)
            safe_source(source, site)
            if not source.is_file() or sha(source) != entry["sha256"]:
                raise ValueError(f"site-package hash mismatch: {rel}")
            target = destination.joinpath(*rel.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def copy_ui_vendors(vendor_root: Path, app_root: Path) -> dict:
    vendor_root = vendor_root.resolve(strict=True)
    modules = safe_source(vendor_root / "node_modules", vendor_root)
    lock_path = safe_source(vendor_root / "package-lock.json", vendor_root)
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("lockfileVersion") != 3:
        raise ValueError("runtime/hana-vendor must use an npm lockfile v3")
    packages = lock.get("packages", {})
    for name in ("echarts", "katex", "markdown-it"):
        if name not in packages.get("", {}).get("dependencies", {}):
            raise ValueError(f"vendor lock does not declare required UI package: {name}")

    ui = app_root / "ui"
    out = ui / "vendor"
    out.mkdir(parents=True, exist_ok=True)
    assets = {
        "echarts": [("dist/echarts.min.js", "echarts.min.js")],
        "katex": [("dist/katex.min.js", "katex.min.js"), ("dist/katex.min.css", "katex.min.css")],
        "markdown-it": [("dist/markdown-it.min.js", "markdown-it.min.js")],
    }
    inventory_packages = []
    for package_name, files in assets.items():
        lock_entry = packages.get(f"node_modules/{package_name}")
        if not lock_entry or not lock_entry.get("integrity") or not lock_entry.get("resolved"):
            raise ValueError(f"vendor lock lacks resolved version and SRI integrity for {package_name}")
        package_root = safe_source(modules / package_name, modules)
        metadata = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
        if metadata.get("version") != lock_entry.get("version"):
            raise ValueError(f"installed {package_name} version does not match package-lock.json")
        packaged_files = []
        for relative, name in files:
            source = safe_source(package_root / relative, package_root)
            target = out / name
            copy_checked(source, target, package_root, prune=False)
            packaged_files.append({"path": target.relative_to(ui).as_posix(), "sha256": sha(target)})
        if package_name == "katex":
            fonts_source = safe_source(package_root / "dist/fonts", package_root)
            copy_checked(fonts_source, out / "fonts", package_root, prune=False)
            for font in sorted((out / "fonts").rglob("*")):
                if font.is_file():
                    packaged_files.append({"path": font.relative_to(ui).as_posix(), "sha256": sha(font)})

        license_root = ui / "vendor/licenses" / package_name
        license_files = []
        for candidate in sorted(package_root.rglob("*")):
            if not candidate.is_file() or not re.match(r"^(LICENSE|NOTICE|COPYING|PATENTS)(?:$|[._-])", candidate.name, re.I):
                continue
            source = safe_source(candidate, package_root)
            relative = candidate.relative_to(package_root)
            target = license_root / relative
            copy_checked(source, target, package_root, prune=False)
            license_files.append({"path": target.relative_to(ui).as_posix(), "sha256": sha(target)})
        if not license_files:
            raise ValueError(f"no package license/notice found for {package_name}")
        inventory_packages.append({
            "name": package_name, "version": lock_entry["version"], "license": metadata.get("license"),
            "resolved": lock_entry["resolved"], "integrity": lock_entry["integrity"],
            "assets": packaged_files, "licenseFiles": license_files,
        })

    # Carry notices/licenses for the complete lock dependency set, including
    # transitive code incorporated into the minified browser distributions.
    covered = {p["name"] for p in inventory_packages}
    for package_path, lock_entry in sorted(packages.items()):
        if not package_path.startswith("node_modules/"):
            continue
        package_name = package_path.removeprefix("node_modules/")
        if package_name in covered:
            continue
        package_root = safe_source(modules / package_name, modules)
        metadata_path = package_root / "package.json"
        if not metadata_path.is_file():
            raise ValueError(f"locked vendor package is missing: {package_name}")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("version") != lock_entry.get("version"):
            raise ValueError(f"installed {package_name} version does not match package-lock.json")
        licenses = []
        license_root = ui / "vendor/licenses" / package_name
        for candidate in sorted(package_root.rglob("*")):
            if candidate.is_file() and re.match(r"^(LICENSE|NOTICE|COPYING|PATENTS)(?:$|[._-])", candidate.name, re.I):
                source = safe_source(candidate, package_root)
                target = license_root / candidate.relative_to(package_root)
                copy_checked(source, target, package_root, prune=False)
                licenses.append({"path": target.relative_to(ui).as_posix(), "sha256": sha(target)})
        if not licenses:
            raise ValueError(f"no package license/notice found for locked dependency {package_name}")
        inventory_packages.append({
            "name": package_name, "version": lock_entry["version"], "license": metadata.get("license"),
            "resolved": lock_entry["resolved"], "integrity": lock_entry["integrity"],
            "assets": [], "licenseFiles": licenses,
        })

    manifest = {"format": 1, "source": "runtime/hana-vendor/package-lock.json", "packages": sorted(inventory_packages, key=lambda item: item["name"])}
    (out / "vendor-integrity.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    notice = ["Hana Danus UI vendor packages", "", "Packages and archive integrity values are pinned by the included npm lock data.", ""]
    for package in manifest["packages"]:
        notice.extend((f"{package['name']} {package['version']} ({package.get('license') or 'license unspecified'})", f"Source: {package['resolved']}", f"Integrity: {package['integrity']}", ""))
    (out / "NOTICES.txt").write_text("\n".join(notice), encoding="utf-8")
    return manifest


def copy_repo_payload(repo: Path, target: Path) -> None:
    allow = ["danus", "agents", "bin", "scripts", ".agents", ".codex/config.toml", "AGENTS.md", "OPERATOR.md", "ARCHITECTURE.md", "README.md", "LICENSE", "pyproject.toml"]
    for name in allow:
        source = repo / name
        if not source.exists():
            continue
        copy_checked(source, target / name, repo)
    shutil.rmtree(target / "scripts/hana-app", ignore_errors=True)
    for examples in ("agents/skills/write-paper/examples", "agents/skills/human-summary/examples"):
        shutil.rmtree(target / examples, ignore_errors=True)
    config = repo / "config"
    if config.is_dir():
        for f in config.glob("*.example"):
            copy_checked(f, target / "config" / f.name, repo)


def transform_dashboard_html(source: str) -> str:
    def replace_once(text: str, old: str, new: str, description: str) -> str:
        count = text.count(old)
        if count != 1:
            raise ValueError(f"expected exactly one {description} in upstream dashboard, found {count}")
        return text.replace(old, new, 1)

    html = source
    katex_css = re.compile(r'href="https://cdn\.jsdelivr\.net/npm/katex@[^/\"]+/dist/katex\.min\.css"')
    html, count = katex_css.subn('href="./vendor/katex.min.css"', html)
    if count != 1:
        raise ValueError(f"expected exactly one upstream KaTeX CDN stylesheet, found {count}")

    vendors = {"echarts": "echarts.min.js", "katex": "katex.min.js", "markdown-it": "markdown-it.min.js"}
    for package, filename in vendors.items():
        script = re.compile(r'src="https://cdn\.jsdelivr\.net/npm/' + re.escape(package) + r'@[^\"]+"')
        html, count = script.subn(f'src="./vendor/{filename}"', html)
        if count != 1:
            raise ValueError(f"expected exactly one upstream {package} CDN script, found {count}")

    html = replace_once(
        html,
        '  <link rel="stylesheet" href="/static/style.css" />',
        '  <link rel="stylesheet" href="./dashboard/style.css" />\n  <link rel="stylesheet" href="./assets/panel.css" />',
        "upstream stylesheet link",
    )
    html = replace_once(
        html,
        '  <script defer src="/static/app.js"></script>',
        '  <script type="module" src="./assets/panel.js"></script>',
        "upstream renderer script",
    )
    if "cdn.jsdelivr.net" in html:
        raise ValueError("upstream dashboard still contains a CDN reference after transformation")
    return html


def stage_original_dashboard(source_static: Path, app_root: Path) -> None:
    ui = app_root / "ui"
    dashboard = ui / "dashboard"
    dashboard.mkdir(parents=True, exist_ok=True)
    for name in ("app.js", "style.css"):
        source = source_static / name
        if not source.is_file():
            raise FileNotFoundError(f"missing upstream dashboard asset: {source}")
        (dashboard / name).write_bytes(source.read_bytes())
    source_html = source_static / "index.html"
    if not source_html.is_file():
        raise FileNotFoundError(f"missing upstream dashboard document: {source_html}")
    (ui / "panel.html").write_text(
        transform_dashboard_html(source_html.read_text(encoding="utf-8")),
        encoding="utf-8",
    )


def inventory(root: Path, python_source: Path, codex_source: Path, lock: dict, ui_vendor: dict) -> dict:
    files = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        files.append({"path": rel, "size": path.stat().st_size, "mode": oct(stat.S_IMODE(path.stat().st_mode)), "sha256": sha(path)})
    codex_meta = json.loads((codex_source / "package.json").read_text(encoding="utf-8"))
    return {
        "format": 1, "appId": "hana-danus", "architecture": "darwin-arm64",
        "python": "3.12 standalone CPython", "codex": {"version": codex_meta["version"], "license": codex_meta.get("license"), "source": "@openai/codex-darwin-arm64"},
        "pythonPackages": [{"name": p["name"], "version": p["version"]} for p in lock["packages"]],
        "uiVendorPackages": [{"name": p["name"], "version": p["version"], "license": p["license"], "integrity": p["integrity"]} for p in ui_vendor["packages"]],
        "notIncluded": ["Node.js", "PDF/TeX toolchain", "Chrome/Chromium", "human-summary renderer", "optional write-paper rendering dependencies", "credentials and Codex authentication"],
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--app-scaffold", type=Path, default=APP)
    parser.add_argument("--python-source", type=Path, required=True)
    parser.add_argument("--site-packages", type=Path, required=True)
    parser.add_argument("--codex-source", type=Path, required=True, help="complete @openai/codex-darwin-arm64 package directory")
    parser.add_argument("--codex-license", type=Path, required=True, help="official upstream license file for the pinned Codex release")
    parser.add_argument("--vendor-root", type=Path, default=ROOT / "runtime/hana-vendor", help="pinned npm vendor root containing package-lock.json and node_modules")
    parser.add_argument("--pack-tool", type=Path, required=True, help="official hana-app-creator/scripts/pack_app.mjs")
    parser.add_argument("--node", default="node")
    parser.add_argument("--id", default="")
    parser.add_argument("--refresh-lock", action="store_true", help="write dependencies.lock.json from installed RECORD hashes and exit")
    parser.add_argument("--validate-only", action="store_true", help="skip packing; stage payload and report inventory")
    args = parser.parse_args()
    repo = args.repo.resolve(strict=True)
    site = args.site_packages.resolve(strict=True)
    if args.refresh_lock:
        LOCK.write_text(json.dumps(make_lock(site, args.app_scaffold), indent=2) + "\n", encoding="utf-8")
        print(LOCK)
        return 0
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    pinned = direct_requirements(args.app_scaffold)
    if lock.get("format") != 1:
        raise ValueError("unsupported dependency lock format")
    if lock.get("roots") != sorted(pinned):
        raise ValueError("dependency lock roots do not match requirements.txt; refresh the lock")
    locked_versions = {package["name"]: package["version"] for package in lock.get("packages", [])}
    if any(locked_versions.get(name) != version for name, version in pinned.items()):
        raise ValueError("dependency lock versions do not match requirements.txt; refresh the lock")
    app_id = args.id or dt.datetime.now().strftime("%Y%m%dt%H%M%S") + "-" + uuid.uuid4().hex[:8]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", app_id):
        raise ValueError("--id must be a lowercase App-folder-safe identifier")
    stage_root = repo / "runtime/hana-app-build" / app_id
    package = stage_root / "hana-danus"
    if package.exists():
        raise FileExistsError(f"refusing to overwrite existing build: {package}")
    package.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copytree(args.app_scaffold, package, symlinks=True, ignore=shutil.ignore_patterns("node_modules", ".git"))
        # Scaffold symlinks are also resolved only after containment checks.
        for p in list(package.rglob("*")):
            if p.is_symlink():
                p.unlink()
                copy_checked(args.app_scaffold / p.relative_to(package), p, args.app_scaffold)
        source_payload = package / "upstream/danus"
        source_payload.mkdir(parents=True, exist_ok=True)
        copy_repo_payload(repo, source_payload)
        ui_vendor = copy_ui_vendors(args.vendor_root, package)
        stage_original_dashboard(source_payload / "danus/observability/static", package)
        deps = package / "dependencies"
        copy_python(args.python_source, deps / "python")
        install_locked_packages(site, deps / "python/site-packages", lock)
        codex_root = args.codex_source.resolve(strict=True)
        if not (codex_root / "package.json").is_file():
            raise ValueError("--codex-source is not a complete official native Codex npm package")
        copy_checked(codex_root, deps / "codex", codex_root, prune=False)
        shutil.copy2(args.codex_license.resolve(strict=True), deps / "codex/LICENSE")
        bindir = deps / "codex/bin"
        bindir.mkdir(parents=True, exist_ok=True)
        vendor = deps / "codex/vendor/aarch64-apple-darwin/bin/codex"
        if not vendor.is_file():
            vendor = next((deps / "codex/vendor").glob("*/bin/codex"), None)
        if not vendor or not vendor.is_file():
            raise ValueError("native Codex executable missing from the complete package")
        wrapper = bindir / "codex"
        wrapper.write_text('#!/bin/bash\nset -euo pipefail\nHERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nexec "$HERE/../vendor/aarch64-apple-darwin/bin/codex" "$@"\n', encoding="utf-8")
        wrapper.chmod(0o755)
        tools = package / "tools"
        for script in tools.iterdir():
            if script.is_file() and script.name != "env.sh":
                script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        for script in (tools / "env.sh",):
            script.chmod(script.stat().st_mode | 0o111)
        inventory_data = inventory(package, args.python_source, codex_root, lock, ui_vendor)
        (package / "build-inventory.json").write_text(json.dumps(inventory_data, indent=2) + "\n", encoding="utf-8")
        expanded = sum(f["size"] for f in inventory_data["files"]) + (package / "build-inventory.json").stat().st_size
        if expanded > 512 * 1024 * 1024:
            raise ValueError(f"expanded package exceeds Hana limit: {expanded} bytes")
        print(f"staged {package} ({expanded} bytes, {len(inventory_data['files']) + 1} entries)")
        if args.validate_only:
            return 0
        output = repo / "dist"
        output.mkdir(exist_ok=True)
        subprocess.run([args.node, str(args.pack_tool), "--dir", str(package), "--publisher", "Danus", "--out", str(output)], check=True)
        archives = sorted(output.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not archives:
            raise RuntimeError("official packer returned without a ZIP archive")
        packed_archive = archives[0]
        packed_entry = packed_archive.with_suffix(".entry.json")
        if not packed_entry.is_file():
            raise RuntimeError(f"official packer did not emit its entry metadata: {packed_entry}")
        version = json.loads((package / "manifest.json").read_text(encoding="utf-8"))["version"]
        archive = output / f"hana-danus-{version}-darwin-arm64-{app_id}.zip"
        entry = output / f"hana-danus-{version}-darwin-arm64-{app_id}.entry.json"
        if archive.exists() or entry.exists():
            raise FileExistsError(f"refusing to overwrite package output for {app_id}")
        with zipfile.ZipFile(packed_archive) as zf:
            bad = zf.testzip()
            if bad:
                raise RuntimeError(f"archive CRC failure at {bad}")
            names = zf.namelist()
            if "tools/danus" not in names:
                raise RuntimeError("packed archive lacks executable Danus launcher")
            for required in ("ui/vendor/echarts.min.js", "ui/vendor/katex.min.js", "ui/vendor/katex.min.css", "ui/vendor/markdown-it.min.js", "ui/vendor/vendor-integrity.json"):
                if required not in names:
                    raise RuntimeError(f"packed archive lacks required vendor resource: {required}")
        entry_data = json.loads(packed_entry.read_text(encoding="utf-8"))
        entry_data["archive"]["url"] = f"{{{{BASE_URL}}}}/{archive.name}"
        packed_archive.rename(archive)
        packed_entry.write_text(json.dumps(entry_data, indent=2) + "\n", encoding="utf-8")
        packed_entry.rename(entry)
        print(f"archive smoke passed: {archive} ({archive.stat().st_size} bytes)")
    except Exception:
        shutil.rmtree(package, ignore_errors=True)
        raise
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"hana-app build failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
