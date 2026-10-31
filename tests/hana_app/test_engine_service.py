"""Software-only controller tests. All account/project fixtures are simulated."""
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/hana-danus/service"))
import engine
import engine_env as env

TOKEN = "b" * 64
FACT_ID = "0123456789abcdef"
# Control-file fixtures only; these are not real verified mathematics.
FACT_MARKDOWN = ("---\nfact_id: " + FACT_ID + "\npredecessors: [aaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbb]\n---\n"
                 "\n## statement\nSIMULATED, not a mathematical claim.\n\n## proof\n"
                 + "模拟软件夹具，非真实证明。  \n" * 3000 + "\nEND OF COMPLETE FIXTURE\n")


@pytest.fixture
def controller(tmp_path, monkeypatch):
    # Isolate process-global runtime env changes and never read the real account.
    monkeypatch.setattr(os, "environ", os.environ.copy())
    home = tmp_path / "simulated-home"
    config = home / ".codex/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('model = "simulated-model"\n[profiles.other]\nmodel = "ignored-profile"\n')
    monkeypatch.setattr(env.os, "getuid", lambda: 4242)
    monkeypatch.setattr(env.pwd, "getpwuid", lambda uid: SimpleNamespace(pw_dir=str(home)))
    data = tmp_path / "app-data"
    data.mkdir()
    token = data / "monitor-auth-token"
    token.write_text(TOKEN)
    token.chmod(0o600)
    monkeypatch.setattr(engine.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=0))
    engine.configure(str(data), str(token))
    with TestClient(engine.app, headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        yield client, data, home


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/control/account", None),
    ("POST", "/control/projects", {"problem": "Simulated statement; no proof computation."}),
    ("GET", "/control/status?project=alpha", None),
    ("GET", "/control/result?project=alpha&fact_id=" + FACT_ID, None),
])
def test_all_control_routes_require_bearer(controller, method, path, body):
    for headers in ({}, {"Authorization": "Bearer invalid"}):
        with TestClient(engine.app, headers=headers) as client:
            assert client.request(method, path, json=body).status_code == 401


def test_account_uses_only_bundled_login_status_and_system_top_level_model(controller, monkeypatch):
    client, data, home = controller
    calls = []

    def status(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(engine.subprocess, "run", status)
    response = client.get("/control/account")
    assert response.json() == {"logged_in": True, "model": "simulated-model", "account_source": "system_codex", "engine": "bundled", "storage": "app"}
    command, options = calls.pop()
    assert command == [str(env.CODEX), "login", "status"]
    assert options["timeout"] == 10
    assert options["env"]["CODEX_HOME"] == str(home / ".codex")
    assert options["cwd"] == str(data)
    assert options["stdout"] is subprocess.DEVNULL and options["stderr"] is subprocess.DEVNULL
    assert "start_new_session" not in options
    assert not (data / "codex-home").exists()
    assert sorted(path.name for path in data.iterdir()) == ["monitor-auth-token", "projects", "runtime", "verifier-agent", "verify-results"]
    assert str(home) not in response.text and TOKEN not in response.text


@pytest.mark.parametrize("returncode,logged_in", [(0, True), (1, False)])
def test_login_status_is_not_inference(controller, monkeypatch, returncode, logged_in):
    client, _, _ = controller
    monkeypatch.setattr(engine.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=returncode))
    assert client.get("/control/account").json()["logged_in"] is logged_in


def test_account_timeout_returns_safe_error(controller, monkeypatch):
    client, _, _ = controller

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("simulated-private-command", 10)

    monkeypatch.setattr(engine.subprocess, "run", timeout)
    response = client.get("/control/account")
    assert response.status_code == 503
    assert response.json() == {"error": {"code": "account_unavailable"}}


def test_account_uses_os_home_when_host_supplies_temporary_home(controller, monkeypatch):
    client, data, home = controller
    runtime_home = data / "simulated-runtime-home"
    runtime_codex = runtime_home / ".codex"
    runtime_codex.mkdir(parents=True)
    (runtime_codex / "config.toml").write_text('model="wrong-runtime-account"\n')
    monkeypatch.setenv("HOME", str(runtime_home))
    monkeypatch.setenv("TMPDIR", str(runtime_home / "tmp"))
    monkeypatch.setenv("CODEX_HOME", str(runtime_codex))
    calls = []

    def login_status(command, **kwargs):
        calls.append(kwargs["env"])
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(engine.subprocess, "run", login_status)
    response = client.get("/control/account")
    assert response.status_code == 200
    assert response.json()["logged_in"] is True
    assert response.json()["model"] == "simulated-model"
    assert calls[0]["CODEX_HOME"] == str(home / ".codex")
    assert calls[0]["HOME"] == str(runtime_home)
    assert calls[0]["TMPDIR"] == str(runtime_home / "tmp")
    assert str(home) not in response.text and TOKEN not in response.text


@pytest.mark.parametrize("failure", ["missing", "os_error", "relative"])
def test_account_lookup_failure_returns_only_safe_account_unavailable(controller, monkeypatch, failure):
    client, _, _ = controller

    def account(uid):
        if failure == "missing":
            raise KeyError("simulated-private-account-detail")
        if failure == "os_error":
            raise OSError("simulated-private-account-detail")
        return SimpleNamespace(pw_dir="simulated-relative-home")

    monkeypatch.setattr(env.pwd, "getpwuid", account)
    monkeypatch.setattr(engine.subprocess, "run", lambda *args, **kwargs: pytest.fail("must not query Codex without OS account home"))
    response = client.get("/control/account")
    assert response.status_code == 503
    assert response.json() == {"error": {"code": "account_unavailable"}}


def test_create_scaffolds_and_assigns_without_launching_processes(controller, monkeypatch):
    client, data, _ = controller
    monkeypatch.setattr(engine.subprocess, "Popen", lambda *a, **kw: pytest.fail("controller must not spawn"))
    monkeypatch.setattr(engine.subprocess, "run", lambda *a, **kw: pytest.fail("create must not call Codex"))
    response = client.post("/control/projects", json={"project": "alpha", "problem": "Simulated full theorem fixture only.", "workers": 2})
    assert response.status_code == 200
    assert response.json() == {"project": "alpha", "model": "simulated-model", "workers": ["high", "high2"], "engine": "bundled", "storage": "app"}
    project = data / "projects/alpha"
    assert (project / "PROBLEM.md").read_text() == "Simulated full theorem fixture only.\n"
    for name in response.json()["workers"]:
        worker = project / "workers" / name
        task = (worker / "TASK.md").read_text()
        assert "../../PROBLEM.md" in task and "fact_submit" in task
        assert "Do not submit\nadditional lemmas" in task
        assert "text-only" in task and "Stop after" in task
        assert not (worker / ".pid").exists()
        assert str(project) in (worker / ".codex/config.toml").read_text()
    assert client.get("/api/projects").json() == {"projects": [{"id": "alpha", "name": "alpha"}]}
    assert engine.monitor._projects_root == data / "projects"


def test_auto_id_explicit_model_and_refuse_overwrite(controller):
    client, data, _ = controller
    body = {"problem": "Simulated input only.", "model": "custom/model-v2"}
    created = client.post("/control/projects", json=body).json()
    assert env.safe_id(created["project"]) == created["project"]
    assert created["model"] == "custom/model-v2" and len(created["workers"]) == 1
    project = data / "projects" / created["project"]
    response = client.post("/control/projects", json={**body, "project": created["project"]})
    assert response.status_code == 409
    assert (project / "PROBLEM.md").read_text() == "Simulated input only.\n"


@pytest.mark.parametrize("project", ["../outside", "..", ".", "/absolute", "bad/name", "bad\\name", "bad\nname", ""])
def test_rejects_project_traversal(controller, project):
    client, _, _ = controller
    assert client.post("/control/projects", json={"project": project, "problem": "Simulated only."}).status_code == 400
    assert client.get("/control/status", params={"project": project}).status_code in {400, 422}


@pytest.mark.parametrize("patch", [{"workers": 0}, {"workers": 5}, {"workers": True}, {"problem": ""}, {"problem": "x" * 16001}, {"projectsRoot": "/external"}, {"env": {"CODEX_HOME": "/external"}}])
def test_request_shape_is_bounded_and_has_no_external_root_or_env(controller, patch):
    client, _, _ = controller
    assert client.post("/control/projects", json={"problem": "Simulated only.", **patch}).status_code == 422


@pytest.mark.parametrize("model", ["--bad", "bad model", "bad\nmodel", "", "bad;command"])
def test_rejects_unsafe_model(controller, model):
    client, _, _ = controller
    assert client.post("/control/projects", json={"problem": "Simulated only.", "model": model}).json() == {"error": {"code": "invalid_model"}}


def test_missing_model_does_not_use_upstream_default(controller):
    client, data, home = controller
    (home / ".codex/config.toml").write_text('[profiles.only]\nmodel="not-top-level"\n')
    assert client.get("/control/account").json()["model"] is None
    response = client.post("/control/projects", json={"problem": "Simulated only."})
    assert response.json() == {"error": {"code": "model_required"}}
    assert list((data / "projects").iterdir()) == []


def test_status_uses_do_status_and_factgraph_list_read_only(controller, monkeypatch):
    client, data, _ = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only."})
    project = data / "projects/alpha"
    facts = project / "fact_graph/facts"
    facts.mkdir()
    (facts / "simulated-fact.md").write_text("SIMULATED fixture, not a mathematical claim or proof.")
    (project / "global_memory/verification.jsonl").write_text('{"verdict":"wrong"}\ninvalid\n')
    before = (facts / "simulated-fact.md").read_bytes()
    response = client.get("/control/status", params={"project": "alpha"})
    assert response.status_code == 200
    body = response.json()
    assert body["workers"][0]["state"] == "created"
    assert body["workers"][0]["last_rc"] is None
    assert body["fact_count"] == 1 and body["verified_fact_ids"] == ["simulated-fact"]
    assert body["last_verdict"] == "wrong"
    assert (facts / "simulated-fact.md").read_bytes() == before
    assert TOKEN not in response.text and str(data) not in response.text


@pytest.mark.parametrize("last_rc", [0, 1, 124, -15])
def test_status_enriches_only_last_rc_for_each_finished_worker(controller, last_rc):
    client, data, _ = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only.", "workers": 2})
    workers = data / "projects/alpha/workers"
    for name, rc in (("high", last_rc), ("high2", 0)):
        (workers / name / ".status.json").write_text(json.dumps({
            "state": "max_rounds", "round": 1, "last_rc": rc,
            "simulated_private_field": "not-public",
        }))
    with env.scoped_environment(data):
        upstream_rows = engine.do_status("alpha")
    assert all("last_rc" not in row for row in upstream_rows)
    before = {path: path.read_bytes() for path in workers.glob("*/.status.json")}
    response = client.get("/control/status", params={"project": "alpha"})
    assert response.status_code == 200
    expected_rc = {"high": last_rc, "high2": 0}
    assert response.json()["workers"] == [dict(row, last_rc=expected_rc[row["worker"]]) for row in upstream_rows]
    assert "not-public" not in response.text
    assert all(path.read_bytes() == content for path, content in before.items())


@pytest.mark.parametrize("missing", [False, True])
def test_status_without_recorded_return_code_is_unknown_not_failure(controller, missing):
    client, data, _ = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only."})
    control = data / "projects/alpha/workers/high/.status.json"
    if missing:
        control.unlink()
    else:
        control.write_text('{"state":"max_rounds","last_rc":null}')
    response = client.get("/control/status", params={"project": "alpha"})
    assert response.status_code == 200
    assert response.json()["workers"][0]["last_rc"] is None


@pytest.mark.parametrize("last_rc", [True, "simulated-private-return-code", [], {}])
def test_status_rejects_malformed_return_code_without_echoing_control_data(controller, last_rc):
    client, data, _ = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only."})
    control = data / "projects/alpha/workers/high/.status.json"
    control.write_text(json.dumps({"state": "max_rounds", "last_rc": last_rc, "simulated_private_field": TOKEN}))
    response = client.get("/control/status", params={"project": "alpha"})
    assert response.status_code == 503
    assert response.json() == {"error": {"code": "status_unavailable"}}


@pytest.mark.parametrize("relative", ["fact_graph", "global_memory", "PROBLEM.md", "project.json", "workers", "workers/high/.status.json", "workers/high/.codex/config.toml", "workers/high/local_memory"])
def test_symlink_project_content_is_rejected(controller, tmp_path, relative):
    client, data, _ = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only."})
    target = data / "projects/alpha" / relative
    # Move only simulated fixture data; never inspect worker-local memory.
    moved = target.with_name(target.name + ".simulated-original")
    target.rename(moved)
    outside = tmp_path / "outside"
    outside.mkdir()
    target.symlink_to(outside)
    assert client.get("/control/status", params={"project": "alpha"}).status_code == 400


def test_symlink_project_and_projects_root_rejected(controller, tmp_path):
    client, data, _ = controller
    outside = tmp_path / "outside"
    outside.mkdir()
    (data / "projects/linked").symlink_to(outside)
    assert client.get("/control/status", params={"project": "linked"}).status_code == 400
    assert client.post("/control/projects", json={"project": "linked", "problem": "Simulated only."}).status_code == 400
    (data / "projects").rename(data / "original-projects")
    (data / "projects").symlink_to(outside)
    assert client.post("/control/projects", json={"problem": "Simulated only."}).status_code == 400


def test_status_never_reads_worker_memory_or_account_credentials(controller, monkeypatch):
    client, _, _ = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only."})
    original_open = Path.open
    original_iterdir = Path.iterdir

    def guarded_open(path, *args, **kwargs):
        assert "local_memory" not in path.parts and "logs" not in path.parts
        assert path.name != "auth.json"
        return original_open(path, *args, **kwargs)

    def guarded_iterdir(path):
        assert "local_memory" not in path.parts and "logs" not in path.parts
        return original_iterdir(path)

    monkeypatch.setattr(Path, "open", guarded_open)
    monkeypatch.setattr(Path, "iterdir", guarded_iterdir)
    assert client.get("/control/status", params={"project": "alpha"}).status_code == 200
    assert client.get("/control/account").status_code == 200


def test_bad_status_data_and_verdict_are_safe(controller):
    client, data, _ = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only."})
    project = data / "projects/alpha"
    (project / "global_memory/verification.jsonl").write_text('{"verdict":{}}\n')
    assert "last_verdict" not in client.get("/control/status", params={"project": "alpha"}).json()
    (project / "workers/high/.status.json").write_text('[]')
    response = client.get("/control/status", params={"project": "alpha"})
    assert response.status_code == 503
    assert response.json() == {"error": {"code": "status_unavailable"}}


@pytest.fixture
def canonical_fixture(controller):
    client, data, home = controller
    client.post("/control/projects", json={"project": "alpha", "problem": "Simulated only."})
    project = data / "projects/alpha"
    facts = project / "fact_graph/facts"
    facts.mkdir()
    path = facts / f"{FACT_ID}.md"
    path.write_bytes(FACT_MARKDOWN.encode("utf-8"))
    return client, data, home, path


def test_result_returns_full_canonical_raw_and_predecessors_without_writes_or_other_reads(canonical_fixture, monkeypatch):
    client, data, _, path = canonical_fixture
    before = path.read_bytes()
    original_open = Path.open
    original_iterdir = Path.iterdir
    calls = []
    original_get = engine.FactGraph.get_raw

    def get_raw(graph, fact_id):
        calls.append(fact_id)
        return original_get(graph, fact_id)

    def guarded_open(target, *args, **kwargs):
        assert not {"local_memory", "logs", ".codex"}.intersection(target.parts)
        assert target.name not in {"auth.json", "verification.jsonl"}
        assert all(mode not in (args[0] if args else kwargs.get("mode", "r")) for mode in "wa+")
        return original_open(target, *args, **kwargs)

    def guarded_iterdir(target):
        assert not {"local_memory", "logs"}.intersection(target.parts)
        return original_iterdir(target)

    monkeypatch.setattr(Path, "open", guarded_open)
    monkeypatch.setattr(Path, "iterdir", guarded_iterdir)
    monkeypatch.setattr(engine.FactGraph, "get_raw", get_raw)
    monkeypatch.setattr(engine.subprocess, "run", lambda *a, **kw: pytest.fail("result must not launch Codex"))
    for _ in range(2):
        response = client.get("/control/result", params={"project": "alpha", "fact_id": FACT_ID})
        assert response.status_code == 200
        assert response.json() == {"project": "alpha", "fact_id": FACT_ID, "markdown": FACT_MARKDOWN,
                                   "predecessors": ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
                                   "source": "fact_graph", "engine": "bundled", "storage": "app"}
        assert TOKEN not in response.text and str(data) not in response.text
    assert calls == [FACT_ID, FACT_ID]
    assert path.read_bytes() == before


@pytest.mark.parametrize("params,code", [
    ({}, "project_required"),
    ({"project": ""}, "invalid_project"),
    ({"project": "../outside", "fact_id": FACT_ID}, "invalid_project"),
    ({"project": "alpha"}, "invalid_fact_id"),
    *[({"project": "alpha", "fact_id": value}, "invalid_fact_id") for value in
      ("", "../outside", "A" * 16, "a" * 15, "a" * 17, "a" * 16 + "\n", "/absolute")],
])
def test_result_validates_identifiers_with_safe_400(controller, params, code):
    client, _, _ = controller
    response = client.get("/control/result", params=params)
    assert response.status_code == 400
    assert response.json() == {"error": {"code": code}}


@pytest.mark.parametrize("location", ["unknown", "revoked", "draft", "unlisted"])
def test_result_never_reads_unknown_revoked_draft_or_noncanonical_fact(canonical_fixture, monkeypatch, location):
    client, _, _, path = canonical_fixture
    if location == "unlisted":
        monkeypatch.setattr(engine.FactGraph, "list", lambda self: [])
    elif location == "unknown":
        path.unlink()
    else:
        folder = path.parents[1] / ("_revoked" if location == "revoked" else "drafts")
        folder.mkdir()
        path.rename(folder / path.name)
    monkeypatch.setattr(engine.FactGraph, "get_raw", lambda *args: pytest.fail("noncanonical fact must not be read"))
    response = client.get("/control/result", params={"project": "alpha", "fact_id": FACT_ID})
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "fact_not_found"}}


@pytest.mark.parametrize("relative", ["", "fact_graph", "fact_graph/facts", f"fact_graph/facts/{FACT_ID}.md"])
def test_result_rejects_project_graph_directory_and_fact_symlinks(canonical_fixture, tmp_path, relative):
    client, data, _, _ = canonical_fixture
    project = data / "projects/alpha"
    target = project / relative if relative else project
    moved = tmp_path / "simulated-moved"
    target.rename(moved)
    target.symlink_to(moved)
    response = client.get("/control/result", params={"project": "alpha", "fact_id": FACT_ID})
    assert response.status_code == 400
    assert response.json() == {"error": {"code": "unsafe_data"}}


@pytest.mark.parametrize("kind", ["directory", "fifo"])
def test_result_rejects_nonregular_fact_before_open(canonical_fixture, monkeypatch, kind):
    client, _, _, path = canonical_fixture
    path.unlink()
    if kind == "directory":
        path.mkdir()
    else:
        os.mkfifo(path)
    monkeypatch.setattr(engine.FactGraph, "get_raw", lambda *args: pytest.fail("must not open nonregular fact"))
    response = client.get("/control/result", params={"project": "alpha", "fact_id": FACT_ID})
    assert response.status_code == 503
    assert response.json() == {"error": {"code": "result_unavailable"}}


@pytest.mark.parametrize("failure", ["missing", "removed_during_read", "io", "encoding", "unexpected"])
def test_result_read_failures_do_not_expose_paths_or_tokens(canonical_fixture, monkeypatch, failure):
    client, _, _, path = canonical_fixture
    if failure == "encoding":
        path.write_bytes(b"\xff")
    else:
        def get_raw(*args):
            if failure == "missing":
                return None
            if failure == "removed_during_read":
                raise FileNotFoundError("private/path/" + TOKEN)
            if failure == "unexpected":
                raise RuntimeError("private/path/" + TOKEN)
            raise OSError("private/path/" + TOKEN)
        monkeypatch.setattr(engine.FactGraph, "get_raw", get_raw)
    response = client.get("/control/result", params={"project": "alpha", "fact_id": FACT_ID})
    missing = failure in {"missing", "removed_during_read"}
    assert response.status_code == (404 if missing else 503)
    assert response.json() == {"error": {"code": "fact_not_found" if missing else "result_unavailable"}}


def test_controller_rejects_external_or_symlink_token_file(controller, tmp_path):
    _, data, _ = controller
    outside = tmp_path / "simulated-token"
    outside.write_text(TOKEN)
    with pytest.raises(env.EngineError, match="invalid_token_file"):
        engine.configure(str(data), str(outside))
    link = data / "token-link"
    link.symlink_to(outside)
    with pytest.raises(env.EngineError, match="invalid_token_file"):
        engine.configure(str(data), str(link))


def test_controller_entry_uses_fixed_root_and_ready_server(controller, monkeypatch):
    _, data, _ = controller
    calls = []
    monkeypatch.setattr(engine.monitor, "main_ready", lambda *args: calls.append(args))
    engine.main(["--data-dir", str(data), "--token-file", str(data / "monitor-auth-token")])
    assert calls == [(engine.app, 18539)]
    with pytest.raises(SystemExit):
        engine.main(["--data-dir", str(data), "--token-file", str(data / "monitor-auth-token"), "--projects-root", "/external"])
