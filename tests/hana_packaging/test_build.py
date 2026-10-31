import importlib.util
import json
import os
import re
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[2] / "scripts/hana-app/build.py"
spec = importlib.util.spec_from_file_location("hana_build", SCRIPT)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class CopySafetyTests(unittest.TestCase):
    def test_copy_dereferences_internal_link_and_preserves_executable_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            root.mkdir()
            executable = root / "launcher"
            executable.write_text("#!/bin/sh\nexit 0\n")
            executable.chmod(0o755)
            (root / "link").symlink_to(executable.name)
            out = Path(tmp) / "copy"
            build.copy_checked(root / "link", out, root)
            self.assertEqual(out.read_text(), executable.read_text())
            self.assertTrue(os.access(out, os.X_OK))
            self.assertFalse(out.is_symlink())

    def test_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "source"
            root.mkdir()
            outside = base / "outside"
            outside.write_text("secret")
            link = root / "escape"
            link.symlink_to(outside)
            with self.assertRaises(ValueError):
                build.copy_checked(link, base / "target", root)

    def test_rejects_cyclic_directory_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            root.mkdir()
            (root / "loop").symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                build.copy_checked(root, Path(tmp) / "target", root)

    def test_copy_tree_excludes_cache_tests_and_node_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            for rel in ("pkg/module.py", "pkg/runtime/runtime_asset.py", "pkg/test_module.py", "pkg/examples/sample.md", "pkg/__pycache__/module.pyc", "pkg/tests/test_x.py", "pkg/node_modules/x.js"):
                path = root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("x")
            out = Path(tmp) / "copy"
            build.copy_checked(root / "pkg", out, root)
            self.assertTrue((out / "module.py").is_file())
            self.assertTrue((out / "runtime/runtime_asset.py").is_file())
            self.assertFalse((out / "__pycache__").exists())
            self.assertFalse((out / "tests").exists())
            self.assertFalse((out / "node_modules").exists())
            self.assertFalse((out / "test_module.py").exists())
            self.assertFalse((out / "examples").exists())

    def test_codex_copy_can_preserve_complete_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "source"
            test_file = root / "tests/native-fixture"
            test_file.parent.mkdir(parents=True)
            test_file.write_text("preserve")
            out = Path(tmp) / "copy"
            build.copy_checked(root, out, root, prune=False)
            self.assertEqual((out / "tests/native-fixture").read_text(), "preserve")

    def test_source_path_rejects_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            outside = Path(tmp) / "outside"
            outside.mkdir()
            with self.assertRaises(ValueError):
                build.safe_source(outside, root)

    def test_vendor_files_licenses_and_lock_integrity_are_staged(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            vendor = base / "vendor"
            modules = vendor / "node_modules"
            versions = {"echarts": "5.5.0", "katex": "0.16.11", "markdown-it": "14.1.0"}
            packages = {"": {"dependencies": {name: "*" for name in versions}}}
            for name, version in versions.items():
                root = modules / name
                (root / "dist").mkdir(parents=True)
                (root / "package.json").write_text(json.dumps({"name": name, "version": version, "license": "MIT"}))
                (root / "LICENSE").write_text("license text")
                packages[f"node_modules/{name}"] = {"version": version, "resolved": f"https://registry.npmjs.org/{name}/-/{name}.tgz", "integrity": f"sha512-{name}"}
            (modules / "echarts/dist/echarts.min.js").write_text("echarts")
            (modules / "katex/dist/katex.min.js").write_text("katex js")
            (modules / "katex/dist/katex.min.css").write_text("katex css")
            (modules / "katex/dist/fonts").mkdir()
            (modules / "katex/dist/fonts/test.woff2").write_bytes(b"font")
            (modules / "markdown-it/dist/markdown-it.min.js").write_text("markdown")
            (vendor / "package-lock.json").write_text(json.dumps({"lockfileVersion": 3, "packages": packages}))
            app = base / "app"
            ui = app / "ui"
            ui.mkdir(parents=True)
            manifest = build.copy_ui_vendors(vendor, app)
            self.assertEqual((ui / "vendor/echarts.min.js").read_text(), "echarts")
            self.assertEqual((ui / "vendor/fonts/test.woff2").read_bytes(), b"font")
            self.assertTrue((ui / "vendor/licenses/katex/LICENSE").is_file())
            self.assertTrue((ui / "vendor/NOTICES.txt").is_file())
            katex = next(item for item in manifest["packages"] if item["name"] == "katex")
            self.assertEqual(katex["version"], versions["katex"])
            self.assertTrue(katex["integrity"].startswith("sha512-"))
            self.assertTrue(all(len(asset["sha256"]) == 64 for asset in katex["assets"]))

    def test_dashboard_staging_copies_renderer_bytes_and_only_adapts_upstream_html(self):
        static = Path(__file__).parents[2] / "danus/observability/static"
        original_html = (static / "index.html").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "hana-danus"
            build.stage_original_dashboard(static, app)
            ui = app / "ui"
            self.assertEqual((ui / "dashboard/app.js").read_bytes(), (static / "app.js").read_bytes())
            self.assertEqual((ui / "dashboard/style.css").read_bytes(), (static / "style.css").read_bytes())
            generated = (ui / "panel.html").read_text(encoding="utf-8")

            self.assertIn('href="./vendor/katex.min.css"', generated)
            self.assertIn('href="./dashboard/style.css"', generated)
            self.assertIn('src="./assets/panel.js"', generated)
            self.assertNotRegex(generated, r'<(?:form|button|select|textarea|input)\b')
            app_css = '  <link rel="stylesheet" href="./assets/panel.css" />\n'
            self.assertEqual(generated.count(app_css), 1)
            self.assertLess(generated.index('href="./dashboard/style.css"'), generated.index('href="./assets/panel.css"'))
            self.assertNotIn('task-controls', generated)
            self.assertNotIn('project-picker', generated)
            self.assertNotIn("projectsRoot", generated)
            self.assertNotIn("cdn.jsdelivr.net", generated)
            # The WHOLE original body, not just main, stays identical after bootstrap normalization.
            normalized = generated.replace(app_css, '', 1).replace(
                '  <script type="module" src="./assets/panel.js"></script>',
                '  <script defer src="/static/app.js"></script>', 1,
            )
            self.assertEqual(normalized.split('<body>', 1)[1], original_html.split('<body>', 1)[1])
            replacements = {
                './vendor/katex.min.css': 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
                './vendor/echarts.min.js': 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
                './vendor/katex.min.js': 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
                './vendor/markdown-it.min.js': 'https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js',
                './dashboard/style.css': '/static/style.css',
            }
            for local, upstream in replacements.items():
                normalized = normalized.replace(local, upstream, 1)
            self.assertEqual(normalized, original_html)
            self.assertEqual(
                (Path(__file__).parents[2] / "apps/hana-danus/ui/panel.html").read_text(encoding="utf-8"),
                generated,
            )

    def test_dashboard_transform_fails_closed_if_upstream_asset_contract_changes(self):
        static = Path(__file__).parents[2] / "danus/observability/static"
        original_html = (static / "index.html").read_text(encoding="utf-8")
        for asset in ('/static/app.js', '/static/style.css',
                      'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
                      'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
                      'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
                      'https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js'):
            with self.subTest(asset=asset), self.assertRaises(ValueError):
                build.transform_dashboard_html(original_html.replace(asset, 'unexpected-asset'))
            with self.subTest(duplicate_asset=asset), self.assertRaises(ValueError):
                line = next(line for line in original_html.splitlines(keepends=True) if asset in line)
                build.transform_dashboard_html(original_html.replace(line, line + line))

    def test_sysconfig_paths_resolve_from_relocated_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "uv/python-root"
            destination = Path(tmp) / "package/dependencies/python"
            config_dir = destination / "lib/python3.12"
            config_dir.mkdir(parents=True)
            config = config_dir / "_sysconfigdata_test.py"
            config.write_text(
                'build_time_vars = {"prefix": "' + str(source) + '", '
                '"abs_builddir": "/private/tmp/build", '
                '"CFLAGS": "-I/private/tmp/build/include"}\n'
            )
            build.sanitize_sysconfig(destination, source)
            text = config.read_text()
            self.assertNotIn(str(source), text)
            self.assertNotIn("/private/tmp/build", text)
            namespace = {"__file__": str(config)}
            exec(compile(text, str(config), "exec"), namespace)
            expected = str(destination)
            self.assertEqual(namespace["build_time_vars"]["prefix"], expected)


if __name__ == "__main__":
    unittest.main()
