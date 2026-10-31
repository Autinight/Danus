"""Offline launch plumbing checks; no models or mathematical computation."""
from __future__ import annotations

import io
import json
import os
import sys
import tomllib
from pathlib import Path
from unittest.mock import patch

import pytest

from danus import codex
from danus.gateway import server
from danus.execution import layout, loop
from danus.verify import launcher


def parsed_gateway(role, **extra):
    return tomllib.loads(codex.gateway_mcp_arg(role, extra))["mcp_servers"]["danus"]


def test_gateway_pins_interpreter_and_explicit_packaged_import_environment(monkeypatch):
    monkeypatch.setenv("PYTHONPATH", "/test-app/upstream/danus:/test-app/dependencies/python/site-packages")
    monkeypatch.setenv("PYTHONHOME", "/test-app/dependencies/python")
    monkeypatch.setenv("OPENAI_API_KEY", "not-forwarded-test-marker")
    monkeypatch.setenv("DANUS_VERIFY_TOKEN_FILE", "/test-data/monitor-auth-token")
    config = parsed_gateway("worker", DANUS_PROJECT_DIR="/test-data/projects/p", DANUS_AUTHOR="high")
    assert config["command"] == sys.executable
    assert config["args"] == ["-m", "danus.gateway"]
    assert config["env"]["DANUS_ROLE"] == "worker"
    assert config["env"]["PYTHONPATH"] == os.environ["PYTHONPATH"]
    assert config["env"]["PYTHONHOME"] == os.environ["PYTHONHOME"]
    assert config["env"]["DANUS_VERIFY_TOKEN_FILE"] == "/test-data/monitor-auth-token"
    assert "OPENAI_API_KEY" not in config["env"]
    assert "DANUS_VERIFY_TOKEN_FILE" not in parsed_gateway("verifier")["env"]
    assert parsed_gateway("verifier")["env"]["DANUS_ROLE"] == "verifier"
    with pytest.raises(ValueError):
        parsed_gateway("main")


def test_verifier_command_uses_same_packaged_gateway_binding(monkeypatch):
    monkeypatch.setenv("DANUS_CODEX_BIN", "/test-app/codex")
    monkeypatch.setenv("VERIFY_AGENT_HOME", "/test-data/verifier-agent")
    monkeypatch.setenv("VERIFIER_RESULTS_DIR", "/test-data/verify-runs")
    monkeypatch.setenv("PYTHONPATH", "/test-app/upstream/danus")
    command = launcher.build_codex_command("test-run", "Fixture statement.", "Fixture proof text, not a real proof run.")
    inline = command[command.index("-c") + 1]
    config = tomllib.loads(inline)["mcp_servers"]["danus"]
    assert config["command"] == sys.executable
    assert config["env"]["PYTHONPATH"] == "/test-app/upstream/danus"
    assert config["env"]["DANUS_ROLE"] == "verifier"


def test_worker_command_injects_gateway_without_user_trust_config(monkeypatch, tmp_path):
    monkeypatch.setenv("DANUS_CODEX_BIN", "/test-app/codex")
    monkeypatch.setenv("DANUS_VERIFY_URL", "http://127.0.0.1:18540/verify")
    monkeypatch.setenv("PYTHONPATH", "/test-app/upstream/danus")
    project = tmp_path / "projects" / "p"
    worker = project / "workers" / "high"
    worker.mkdir(parents=True)
    wl = layout.WorkerLayout(worker)
    captured = {}

    class Process:
        def __init__(self, command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs
        def wait(self, **kwargs):
            return 0

    with patch.object(loop.subprocess, "Popen", Process):
        result = loop.run_round(wl, {"MODEL": "fixture-model", "REASONING_EFFORT": "high"}, "Fixture task only.", tmp_path / "round.log", 1)
    assert result == 0
    command = captured["command"]
    config = tomllib.loads(command[command.index("-c") + 1])["mcp_servers"]["danus"]
    assert config["env"]["DANUS_PROJECT_DIR"] == str(project)
    assert config["env"]["DANUS_AUTHOR"] == "high"
    assert config["env"]["DANUS_VERIFY_URL"] == "http://127.0.0.1:18540/verify"
    assert not (tmp_path / ".codex").exists()


def test_verifier_bearer_is_read_from_private_file_not_command_or_response(monkeypatch, tmp_path):
    token = "b" * 64
    token_file = tmp_path / "monitor-auth-token"
    token_file.write_text(token + "\n", encoding="ascii")
    token_file.chmod(0o600)
    monkeypatch.setenv("DANUS_VERIFY_URL", "http://127.0.0.1:18540/verify")
    monkeypatch.setenv("DANUS_VERIFY_TOKEN_FILE", str(token_file))
    captured = {}

    def open_request(request, **kwargs):
        captured["request"] = request
        return io.BytesIO(json.dumps({"verdict": "correct"}).encode())

    with patch.object(server.urllib.request, "urlopen", open_request):
        assert server._verify("Fixture statement.", "Fixture proof.") == {"verdict": "correct"}
    assert captured["request"].get_header("Authorization") == "Bearer " + token
    token_file.chmod(0o644)
    with pytest.raises(RuntimeError, match="authentication file"):
        server._verify("Fixture statement.", "Fixture proof.")


def test_verifier_auth_rejects_symlink_file(monkeypatch, tmp_path):
    target = tmp_path / "target"
    target.write_text("a" * 64, encoding="ascii")
    target.chmod(0o600)
    link = tmp_path / "linked"
    link.symlink_to(target)
    monkeypatch.setenv("DANUS_VERIFY_URL", "http://127.0.0.1:18540/verify")
    monkeypatch.setenv("DANUS_VERIFY_TOKEN_FILE", str(link))
    with pytest.raises(RuntimeError, match="authentication file"):
        server._verify("Fixture statement.", "Fixture proof.")
