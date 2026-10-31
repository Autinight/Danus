import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "apps" / "hana-danus" / "service" / "monitor.py"
spec = importlib.util.spec_from_file_location("hana_danus_monitor", SERVICE)
monitor = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(monitor)


TEST_TOKEN = "a" * 64


@pytest.fixture
def client(tmp_path):
    projects = tmp_path / "projects"
    projects.mkdir()
    token_file = tmp_path / "app-data" / "monitor-auth-token"
    token_file.parent.mkdir()
    token_file.write_text(TEST_TOKEN + "\n", encoding="ascii")
    token_file.chmod(0o600)
    monitor.configure_token_file(str(token_file))
    monitor.configure_projects_root(str(projects), str(tmp_path / "app-data"))
    with TestClient(monitor.app, headers={"Authorization": f"Bearer {TEST_TOKEN}"}) as test_client:
        yield test_client, projects


def make_project(projects: Path, project_id="alpha") -> Path:
    project = projects / project_id
    facts = project / "fact_graph" / "facts"
    memory = project / "global_memory"
    facts.mkdir(parents=True)
    memory.mkdir(parents=True)
    (facts / "f1.md").write_text(
        "---\nfact_id: f1\nproblem_id: p\nauthor: tester\npredecessors: []\n---\n"
        "## statement\nA verified claim.\n## proof\nA short proof.\n",
        encoding="utf-8",
    )
    (memory / "conclusion.jsonl").write_text('{"timestamp_utc":"2026-01-01","claim":"done"}\nnot json\n', encoding="utf-8")
    return project


@pytest.mark.parametrize("path", [
    "/health",
    "/api/projects",
    "/api/overview",
    "/api/factgraph",
    "/api/channels",
    "/api/channel/conclusion",
])
def test_every_service_route_rejects_missing_or_invalid_bearer(client, path):
    _, _projects = client
    with TestClient(monitor.app) as unauthenticated:
        assert unauthenticated.get(path).status_code == 401
    with TestClient(monitor.app, headers={"Authorization": "Bearer wrong"}) as invalid:
        assert invalid.get(path).status_code == 401


def test_authenticated_health_route_is_accepted(client):
    response, _projects = client
    assert response.get("/health").json() == {"status": "ok"}


def test_invalid_token_file_fails_closed(tmp_path):
    missing = tmp_path / "missing-token"
    monitor.configure_token_file(str(missing))
    with TestClient(monitor.app) as client:
        assert client.get("/health").status_code == 503
    exposed = tmp_path / "exposed-token"
    exposed.write_text(TEST_TOKEN + "\\n", encoding="ascii")
    exposed.chmod(0o644)
    monitor.configure_token_file(str(exposed))
    with TestClient(monitor.app) as client:
        assert client.get("/health").status_code == 503


def test_default_projects_root_matches_danus_runtime(tmp_path):
    monitor.configure_projects_root("", str(tmp_path))
    assert monitor._projects_root == (tmp_path / "projects").resolve()
    try:
        monitor.configure_projects_root("relative/projects", str(tmp_path))
    except ValueError:
        pass
    else:
        raise AssertionError("relative projects root must be rejected")


def test_empty_projects_root_is_empty_not_sample_data(client):
    response, projects = client
    assert response.get("/api/projects").json() == {"projects": []}
    assert response.get("/api/overview", params={"project": "missing"}).status_code == 404
    assert list(projects.iterdir()) == []


def test_blank_projects_root_matches_launcher_projects_directory(client, tmp_path):
    response, _projects = client
    app_data = tmp_path / "separate-app-data"
    expected = app_data / "projects"
    (expected / "from-launcher").mkdir(parents=True)
    monitor.configure_projects_root("", str(app_data))
    assert response.get("/api/projects").json() == {"projects": [{"id": "from-launcher", "name": "from-launcher"}]}


def test_builders_read_selected_project(client):
    response, projects = client
    make_project(projects)
    overview = response.get("/api/overview", params={"project": "alpha"})
    assert overview.status_code == 200
    assert overview.json()["facts"] == 1
    assert overview.json()["channel_counts"]["conclusion"] == 1
    graph = response.get("/api/factgraph", params={"project": "alpha"}).json()
    assert graph["nodes"][0]["id"] == "f1"
    channel = response.get("/api/channel/conclusion", params={"project": "alpha"}).json()
    assert channel["count"] == 1


def test_project_selection_is_per_request(client):
    response, projects = client
    make_project(projects, "alpha")
    beta = projects / "beta"
    (beta / "fact_graph" / "facts").mkdir(parents=True)
    (beta / "global_memory").mkdir(parents=True)
    listed = response.get("/api/projects").json()["projects"]
    assert [item["id"] for item in listed] == ["alpha", "beta"]
    alpha = response.get("/api/overview", params={"project": "alpha"}).json()
    other = response.get("/api/overview", params={"project": "beta"}).json()
    alpha_again = response.get("/api/overview", params={"project": "alpha"}).json()
    assert alpha["project"] == "alpha" and alpha["facts"] == 1
    assert other["project"] == "beta" and other["facts"] == 0
    assert alpha_again["project"] == "alpha" and alpha_again["facts"] == 1


def test_project_traversal_and_symlinks_are_rejected(client, tmp_path):
    response, projects = client
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "global_memory").mkdir()
    (projects / "linked").symlink_to(outside, target_is_directory=True)
    assert response.get("/api/overview", params={"project": "../outside"}).status_code == 400
    assert response.get("/api/overview", params={"project": "linked"}).status_code == 400
    project = make_project(projects, "internal-link")
    (project / "global_memory" / "conclusion.jsonl").unlink()
    (project / "global_memory" / "conclusion.jsonl").symlink_to(outside / "absent.jsonl")
    assert response.get("/api/overview", params={"project": "internal-link"}).status_code == 400


def test_malformed_and_unknown_channel_requests_are_bounded(client):
    response, projects = client
    make_project(projects)
    unknown = response.get("/api/channel/not-a-channel", params={"project": "alpha"})
    assert unknown.status_code == 404
    invalid_project = response.get("/api/channels", params={"project": "bad/name"})
    assert invalid_project.status_code == 400
