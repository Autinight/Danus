"""Mocked launcher tests only: no worker, verifier, Codex, or math execution."""
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/hana-danus/service"))
import engine_env as env
import monitor
import worker
import verify

SIMULATED_TOKEN = "c" * 64


@pytest.fixture
def runtime_data(tmp_path, monkeypatch):
    monkeypatch.setattr(os, "environ", os.environ.copy())
    home = tmp_path / "simulated-home"
    config = home / ".codex/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('model="simulated-system-model"\n')
    monkeypatch.setattr(env.os, "getuid", lambda: 4242)
    monkeypatch.setattr(env.pwd, "getpwuid", lambda uid: SimpleNamespace(pw_dir=str(home)))
    root = env.prepare_data(tmp_path / "app-data")
    token_file = root / "monitor-auth-token"
    token_file.write_text(SIMULATED_TOKEN, encoding="ascii")
    token_file.chmod(0o600)
    monkeypatch.setattr(monitor, "_token_file", None)
    return root, home


def scaffold_simulated_worker(root):
    # Only software control files, never local-memory content or proof claims.
    home = root / "projects/alpha/workers/high"
    (home / ".codex").mkdir(parents=True)
    (root / "projects/alpha/project.json").write_text(json.dumps({"model": "simulated-project-model", "workers": ["high"]}))
    (home / ".role").write_text("MODEL=simulated-project-model\n")
    return home


def test_environment_is_pinned_and_one_round_without_copying_account(runtime_data, monkeypatch):
    root, home = runtime_data
    monkeypatch.setenv("CODEX_HOME", "/simulated-external-account")
    runtime_home = str(root / "simulated-runtime-home")
    runtime_tmp = str(root / "simulated-runtime-tmp")
    monkeypatch.setenv("HOME", runtime_home)
    monkeypatch.setenv("TMPDIR", runtime_tmp)
    monkeypatch.setenv("DANUS_AGENTS_ROOT", "/simulated-external-projects")
    monkeypatch.setenv("DANUS_VERIFY_TOKEN_FILE", "/simulated-external-token")
    monkeypatch.setenv("DANUS_PROJECT_OTHER_WORKER_API_KEY", "simulated-only")
    monkeypatch.setenv("PYTHONPATH", "/simulated-external-code")
    env.configure(root, "simulated-model")
    expected = {
        "DANUS_AGENTS_ROOT": str(root / "projects"),
        "DANUS_RUNTIME": str(root / "runtime"),
        "VERIFY_AGENT_HOME": str(root / "verifier-agent"),
        "VERIFIER_RESULTS_DIR": str(root / "verify-results"),
        "CODEX_HOME": str(home / ".codex"),
        "DANUS_CODEX_BIN": str(env.CODEX),
        "DANUS_VERIFY_URL": "http://127.0.0.1:18540/verify",
        "DANUS_VERIFY_TOKEN_FILE": str(root / "monitor-auth-token"),
        "DANUS_MAX_ROUNDS": "1", "DANUS_ROUND_HARD_TIMEOUT": "600",
        "CODEX_TIMEOUT_SECONDS": "240", "DANUS_MAX_CONSEC_FAILURES": "1", "DANUS_ROUND_BEAT": "0",
        "DANUS_WORKER_MODEL": "simulated-model", "DANUS_VERIFY_MODEL": "simulated-model",
    }
    for key, value in expected.items():
        assert os.environ[key] == value
    assert os.environ["PYTHONPATH"].split(os.pathsep) == [str(env.UPSTREAM), str(env.PYTHON_ROOT / "site-packages")]
    assert os.environ["PATH"].split(os.pathsep)[:2] == [str(env.PYTHON_ROOT / "bin"), str(env.APP_ROOT / "tools")]
    assert "DANUS_PROJECT_OTHER_WORKER_API_KEY" not in os.environ
    assert os.environ["HOME"] == runtime_home and os.environ["TMPDIR"] == runtime_tmp
    assert not (root / "codex-home").exists()
    assert list((root / "verifier-agent").iterdir()) == []


def test_os_account_home_ignores_runtime_home_and_codex_home(runtime_data, monkeypatch, tmp_path):
    root, home = runtime_data
    runtime_home = tmp_path / "simulated-runtime-home"
    inherited_codex = tmp_path / "simulated-inherited-codex"
    for path in (runtime_home / ".codex", inherited_codex):
        path.mkdir(parents=True)
        (path / "config.toml").write_text('model="wrong-account-model"\n')
    monkeypatch.setenv("HOME", str(runtime_home))
    monkeypatch.setenv("CODEX_HOME", str(inherited_codex))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: pytest.fail("runtime HOME must not resolve the account")))
    looked_up = []

    def account(uid):
        looked_up.append(uid)
        return SimpleNamespace(pw_dir=str(home))

    monkeypatch.setattr(env.pwd, "getpwuid", account)
    assert env.system_codex_home() == home / ".codex"
    assert env.configured_model() == "simulated-system-model"
    assert env.environment(root)["CODEX_HOME"] == str(home / ".codex")
    assert os.environ["HOME"] == str(runtime_home)
    assert os.environ["CODEX_HOME"] == str(inherited_codex)
    assert looked_up == [4242, 4242, 4242]


@pytest.mark.parametrize("failure", ["missing", "os_error", "empty", "relative", "non_string"])
def test_os_account_lookup_failure_is_safe_without_home_fallback(runtime_data, monkeypatch, failure):
    root, _ = runtime_data

    def account(uid):
        if failure == "missing":
            raise KeyError("simulated-private-account-detail")
        if failure == "os_error":
            raise OSError("simulated-private-account-detail")
        return SimpleNamespace(pw_dir={"empty": "", "relative": "relative/account", "non_string": None}[failure])

    monkeypatch.setattr(env.pwd, "getpwuid", account)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: pytest.fail("must not guess account home")))
    before = os.environ.copy()
    for action in (env.system_codex_home, env.configured_model, lambda: env.configure(root, "simulated-model")):
        with pytest.raises(env.EngineError, match="^account_unavailable$") as raised:
            action()
        assert raised.value.status == 503
        assert os.environ == before


def test_scoped_environment_restores_parent_even_on_failure(runtime_data):
    root, _ = runtime_data
    before = os.environ.copy()
    with pytest.raises(RuntimeError):
        with env.scoped_environment(root, "simulated-model"):
            assert os.environ["DANUS_MAX_ROUNDS"] == "1"
            raise RuntimeError("simulated failure")
    assert os.environ == before


def test_model_reads_top_level_standard_config_only(runtime_data, monkeypatch):
    _, home = runtime_data
    monkeypatch.setenv("CODEX_HOME", "/simulated-outside")
    assert env.configured_model() == "simulated-system-model"
    config = home / ".codex/config.toml"
    config.write_text('[profiles.selected]\nmodel="not-a-default"\n')
    assert env.configured_model() is None
    config.write_text('model="--unsafe"\n')
    assert env.configured_model() is None
    config.write_text("not valid toml")
    assert env.configured_model() is None
    config.unlink()
    assert env.resolve_model("explicit-model") == "explicit-model"
    with pytest.raises(env.EngineError, match="model_required"):
        env.resolve_model()


def test_config_symlink_does_not_read_outside_system_codex_home(runtime_data, tmp_path):
    _, home = runtime_data
    outside = tmp_path / "simulated-outside.toml"
    outside.write_text('model="outside-model"\n')
    config = home / ".codex/config.toml"
    config.unlink()
    config.symlink_to(outside)
    assert env.configured_model() is None


@pytest.mark.parametrize("model", [None, "explicit-model"])
def test_worker_writes_own_pid_and_execs_bundled_interpreter(runtime_data, monkeypatch, model):
    root, _ = runtime_data
    home = scaffold_simulated_worker(root)
    calls = []
    monkeypatch.setattr(worker.os, "execv", lambda *args: calls.append(args))
    monkeypatch.setattr(worker.os, "getpid", lambda: 43210)
    worker.launch(str(root), "alpha", "high", model)
    assert (home / ".pid").read_text() == "43210\n"
    assert calls == [(str(env.PYTHON), [str(env.PYTHON), "-B", "-m", "danus.execution", str(home)])]
    assert os.environ["DANUS_PROJECT_DIR"] == str(root / "projects/alpha")
    assert os.environ["DANUS_ROLE"] == "worker"
    assert os.environ["DANUS_VERIFY_TOKEN_FILE"] == str(root / "monitor-auth-token")
    assert SIMULATED_TOKEN not in repr(calls)
    selected = model or "simulated-project-model"
    assert os.environ["DANUS_WORKER_MODEL"] == selected
    assert f"MODEL={selected}\n" in (home / ".role").read_text()


@pytest.mark.parametrize("project,name", [("../outside", "high"), ("alpha", "../high"), ("alpha", "missing"), ("alpha", "bad/name")])
def test_invalid_worker_never_execs(runtime_data, monkeypatch, project, name):
    root, _ = runtime_data
    scaffold_simulated_worker(root)
    monkeypatch.setattr(worker.os, "execv", lambda *args: pytest.fail("must not execute invalid target"))
    with pytest.raises(env.EngineError):
        worker.launch(str(root), project, name)


@pytest.mark.parametrize("relative", [".pid", ".pid.tmp", ".role", ".role.tmp", ".codex/config.toml", "local_memory"])
def test_worker_rejects_symlink_control_paths(runtime_data, monkeypatch, tmp_path, relative):
    root, _ = runtime_data
    home = scaffold_simulated_worker(root)
    target = home / relative
    if target.exists():
        target.unlink()
    target.symlink_to(tmp_path / "outside")
    monkeypatch.setattr(worker.os, "execv", lambda *args: pytest.fail("must not execute unsafe worker"))
    with pytest.raises(env.EngineError, match="unsafe_data"):
        worker.launch(str(root), "alpha", "high")


def test_verify_uses_existing_app_ready_server_and_fixed_port(runtime_data, monkeypatch):
    root, _ = runtime_data
    calls = []
    monkeypatch.setattr(verify.monitor, "main_ready", lambda *args: calls.append(args))
    from danus.verify.service import app
    previous_middleware = list(app.user_middleware)
    verify.launch(str(root), "simulated-verifier-model", str(root / "monitor-auth-token"))
    protected, port, marker = calls.pop()
    assert protected is not app
    assert protected.routes[-1].app is app
    assert app.user_middleware == previous_middleware
    assert port == 18540 and marker == "HANA_DANUS_VERIFY_READY"
    from fastapi.testclient import TestClient
    with TestClient(app) as legacy_client:
        assert legacy_client.get("/health").status_code == 200
    assert os.environ["VERIFY_AGENT_HOME"] == str(root / "verifier-agent")
    assert os.environ["CODEX_TIMEOUT_SECONDS"] == "240"
    with pytest.raises(env.EngineError, match="invalid_port"):
        verify.launch(str(root), "simulated-verifier-model", str(root / "monitor-auth-token"), 9999)


@pytest.mark.parametrize("relative", [".codex", ".agents", "AGENTS.md"])
def test_verifier_rejects_external_config_and_contract_links(runtime_data, monkeypatch, tmp_path, relative):
    root, _ = runtime_data
    (root / "verifier-agent" / relative).symlink_to(tmp_path)
    monkeypatch.setattr(verify.monitor, "main_ready", lambda *args: pytest.fail("must not serve unsafe verifier home"))
    with pytest.raises(env.EngineError, match="unsafe_data"):
        verify.launch(str(root), "simulated-model", str(root / "monitor-auth-token"))


@pytest.mark.parametrize("headers", [
    {},
    {"Authorization": "Bearer wrong"},
    {"Authorization": "Bearer " + "d" * 64},
    {"Authorization": "Basic " + SIMULATED_TOKEN},
])
def test_verifier_rejects_unauthenticated_requests_before_verification(runtime_data, monkeypatch, headers):
    from fastapi.testclient import TestClient
    from danus.verify import service

    root, _ = runtime_data
    for name in ("run_prechecks", "_allocate_run_id", "run_codex_verification"):
        monkeypatch.setattr(service, name, lambda *args, **kwargs: pytest.fail("unauthenticated request reached verification"))
    application = verify.authenticated_app(root / "monitor-auth-token")
    with TestClient(application) as client:
        # Auth must reject even before parsing an invalid request body.
        response = client.post("/verify", content="not-json", headers=headers)
        assert response.status_code == 401
        assert response.json() == {"error": {"code": "unauthorized", "message": "A valid bearer token is required."}}
        assert client.get("/health", headers=headers).status_code == 401
        assert SIMULATED_TOKEN not in response.text and str(root) not in response.text


@pytest.mark.parametrize("broken", ["missing", "permissions", "malformed", "symlink"])
def test_verifier_fails_closed_for_invalid_token_file(runtime_data, monkeypatch, broken):
    from fastapi.testclient import TestClient
    from danus.verify import service

    root, _ = runtime_data
    token_file = root / "monitor-auth-token"
    application = verify.authenticated_app(token_file)
    if broken == "missing":
        token_file.unlink()
    elif broken == "permissions":
        token_file.chmod(0o644)
    elif broken == "malformed":
        token_file.write_text("simulated-invalid-token")
    else:
        token_file.rename(root / "simulated-original-token")
        token_file.symlink_to(root / "simulated-original-token")
    monkeypatch.setattr(service, "run_codex_verification", lambda **kwargs: pytest.fail("invalid token file reached Codex"))
    with TestClient(application) as client:
        response = client.post("/verify", json={"statement": "SIMULATED input only", "proof": "SIMULATED input only"}, headers={"Authorization": f"Bearer {SIMULATED_TOKEN}"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "monitor_unavailable"
        assert SIMULATED_TOKEN not in response.text and str(root) not in response.text


def test_authenticated_verifier_request_reaches_only_mocked_verification(runtime_data, monkeypatch):
    from fastapi.testclient import TestClient
    from danus.verify import service

    root, _ = runtime_data
    calls = []
    monkeypatch.setattr(service, "run_prechecks", lambda *args: None)
    monkeypatch.setattr(service, "_allocate_run_id", lambda *args: "simulated-run")
    monkeypatch.setattr(service, "run_codex_verification", lambda **kwargs: calls.append(kwargs) or {"verdict": "simulated-only"})
    application = verify.authenticated_app(root / "monitor-auth-token")
    with TestClient(application) as client:
        response = client.post("/verify", json={"statement": "SIMULATED statement, no theorem", "proof": "SIMULATED proof, no computation"}, headers={"Authorization": f"Bearer {SIMULATED_TOKEN}"})
        assert response.status_code == 200
        assert response.json() == {"verdict": "simulated-only"}
        assert len(calls) == 1 and calls[0]["run_id"] == "simulated-run"
        assert SIMULATED_TOKEN not in response.text


def test_verifier_cli_matches_parent_token_file_contract(runtime_data, monkeypatch):
    root, _ = runtime_data
    calls = []
    monkeypatch.setattr(verify, "launch", lambda *args: calls.append(args))
    verify.main(["--data-dir", str(root), "--model", "simulated-model", "--token-file", str(root / "monitor-auth-token"), "--port", "18540"])
    assert calls == [(str(root), "simulated-model", str(root / "monitor-auth-token"), 18540)]
    with pytest.raises(SystemExit):
        verify.main(["--data-dir", str(root), "--model", "simulated-model"])
    assert len(calls) == 1


def test_verifier_rejects_external_token_file(runtime_data, monkeypatch, tmp_path):
    root, _ = runtime_data
    monkeypatch.setattr(verify.monitor, "main_ready", lambda *args: pytest.fail("must not serve with external token"))
    with pytest.raises(env.EngineError, match="invalid_token_file"):
        verify.launch(str(root), "simulated-model", str(tmp_path / "outside-token"))


def test_worker_rejects_external_deadline_file(runtime_data, monkeypatch, tmp_path):
    root, _ = runtime_data
    scaffold_simulated_worker(root)
    (root / "projects/alpha/.run_deadline").symlink_to(tmp_path / "outside")
    monkeypatch.setattr(worker.os, "execv", lambda *args: pytest.fail("must not execute unsafe worker"))
    with pytest.raises(env.EngineError, match="unsafe_data"):
        worker.launch(str(root), "alpha", "high")


def test_ready_marker_only_after_successful_startup(monkeypatch, capsys):
    import asyncio
    import uvicorn
    from types import SimpleNamespace

    captured = []
    monkeypatch.setattr(uvicorn, "Config", lambda app, **kw: captured.append((app, kw)) or SimpleNamespace())

    async def started(self, sockets=None):
        self.started = True

    monkeypatch.setattr(uvicorn.Server, "startup", started)
    monkeypatch.setattr(uvicorn.Server, "run", lambda self: asyncio.run(self.startup()))
    # Avoid constructing the real Uvicorn server: fake init supplies startup state.
    monkeypatch.setattr(uvicorn.Server, "__init__", lambda self, config: setattr(self, "started", False))
    monitor.main_ready("simulated-app", 18540, "HANA_DANUS_VERIFY_READY")
    assert capsys.readouterr().out == "HANA_DANUS_VERIFY_READY\n"
    assert captured == [("simulated-app", {"host": "127.0.0.1", "port": 18540, "log_level": "warning", "access_log": False})]

    async def failed(self, sockets=None):
        self.started = False

    monkeypatch.setattr(uvicorn.Server, "startup", failed)
    monitor.main_ready("simulated-app")
    assert capsys.readouterr().out == ""


def test_no_launcher_detaches_or_calls_external_orchestration():
    for filename in ("engine.py", "engine_env.py", "worker.py", "verify.py"):
        source = (ROOT / "apps/hana-danus/service" / filename).read_text()
        assert "start_new_session" not in source and "setsid" not in source
        assert "subprocess.Popen" not in source
        assert "do_start(" not in source and "spawn_loop(" not in source


def test_no_install_writes_or_symlink_data_roots(runtime_data, tmp_path):
    root, _ = runtime_data
    with pytest.raises(env.EngineError, match="invalid_data_dir"):
        env.prepare_data(env.APP_ROOT / "runtime")
    with pytest.raises(env.EngineError, match="invalid_data_dir"):
        env.prepare_data("relative")
    link = tmp_path / "linked-data"
    link.symlink_to(root)
    with pytest.raises(env.EngineError, match="invalid_data_dir"):
        env.prepare_data(link)
    (root / "verify-results").rmdir()
    (root / "verify-results").symlink_to(tmp_path)
    with pytest.raises(env.EngineError, match="unsafe_data"):
        env.prepare_data(root)
