"""Pinned paths and process-local environment for App-owned Danus runtimes."""
from __future__ import annotations

import os
import pwd
import re
import sys
import threading
import tomllib
from contextlib import contextmanager
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = APP_ROOT / "upstream" / "danus"
PYTHON_ROOT = APP_ROOT / "dependencies" / "python"
PYTHON = PYTHON_ROOT / "bin" / "python3"
CODEX = APP_ROOT / "dependencies" / "codex" / "bin" / "codex"
VERIFY_URL = "http://127.0.0.1:18540/verify"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\Z")
ENV_LOCK = threading.RLock()


class EngineError(ValueError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def add_import_paths() -> None:
    sys.dont_write_bytecode = True
    for directory in (PYTHON_ROOT / "site-packages", UPSTREAM):
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))


def safe_id(value: str, code: str = "invalid_project") -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value) or value in {".", ".."}:
        raise EngineError(code)
    return value


def safe_model(value: str) -> str:
    if not isinstance(value, str) or not _MODEL.fullmatch(value):
        raise EngineError("invalid_model")
    return value


def system_codex_home() -> Path:
    # The macOS host replaces HOME for each runtime. Use the OS account record,
    # never runtime HOME/inherited CODEX_HOME, and never copy account files.
    try:
        home = pwd.getpwuid(os.getuid()).pw_dir
        if not isinstance(home, str) or not Path(home).is_absolute():
            raise ValueError("invalid account home")
    except (KeyError, OSError, ValueError, TypeError, AttributeError):
        raise EngineError("account_unavailable", 503) from None
    return Path(home) / ".codex"


def configured_model() -> str | None:
    home = system_codex_home()
    config = home / "config.toml"
    if home.is_symlink() or config.is_symlink():
        return None
    try:
        with config.open("rb") as stream:
            value = tomllib.load(stream).get("model")
        return safe_model(value) if isinstance(value, str) else None
    except (OSError, ValueError):
        return None


def resolve_model(value: str | None = None) -> str:
    if value is not None:
        return safe_model(value)
    model = configured_model()
    if model is None:
        raise EngineError("model_required")
    return model


def data_root(value: str | Path) -> Path:
    root = Path(value)
    if not root.is_absolute() or ".." in root.parts or root.is_symlink():
        raise EngineError("invalid_data_dir")
    root = root.resolve()
    if root.is_relative_to(APP_ROOT.resolve()):
        raise EngineError("invalid_data_dir")
    if root.exists() and not root.is_dir():
        raise EngineError("invalid_data_dir")
    return root


def checked_path(root: Path, *parts: str) -> Path:
    current = root
    if current.is_symlink():
        raise EngineError("unsafe_data")
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise EngineError("unsafe_data")
    if not current.resolve().is_relative_to(root.resolve()):
        raise EngineError("unsafe_data")
    return current


def prepare_data(value: str | Path) -> Path:
    root = data_root(value)
    root.mkdir(parents=True, exist_ok=True)
    for name in ("projects", "runtime", "verify-results", "verifier-agent"):
        checked_path(root, name).mkdir(exist_ok=True)
    return root


def environment(root: Path, model: str | None = None) -> dict[str, str]:
    # Inherit OS necessities, not arbitrary DANUS/CODEX/provider overrides.
    inherited = {"HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SYSTEMROOT", "SSL_CERT_FILE", "SSL_CERT_DIR"}
    env = {key: value for key, value in os.environ.items() if key in inherited}
    env.update({
        "PATH": os.pathsep.join((str(PYTHON_ROOT / "bin"), str(APP_ROOT / "tools"), "/usr/bin", "/bin", "/usr/sbin", "/sbin")),
        "PYTHONPATH": os.pathsep.join((str(UPSTREAM), str(PYTHON_ROOT / "site-packages"))),
        "PYTHONHOME": str(PYTHON_ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "CODEX_HOME": str(system_codex_home()),
        "DANUS_APP_ROOT": str(UPSTREAM),
        "DANUS_APP_DATA": str(root),
        "DANUS_ROOT": str(UPSTREAM),
        "DANUS_RUNTIME": str(root / "runtime"),
        "DANUS_AGENTS_ROOT": str(root / "projects"),
        "DANUS_PY": str(PYTHON),
        "DANUS_CODEX_BIN": str(CODEX),
        "DANUS_WORKER_CONTRACT": str(UPSTREAM / "agents/contracts/worker.md"),
        "DANUS_WORKER_SKILLS": str(UPSTREAM / "agents/skills/worker"),
        "VERIFY_AGENT_HOME": str(root / "verifier-agent"),
        "VERIFIER_RESULTS_DIR": str(root / "verify-results"),
        "DANUS_VERIFY_URL": VERIFY_URL,
        "DANUS_VERIFY_TOKEN_FILE": str(root / "monitor-auth-token"),
        "DANUS_MAX_ROUNDS": "1",
        "DANUS_ROUND_HARD_TIMEOUT": "600",
        "DANUS_VERIFY_TIMEOUT": "600",
        "CODEX_TIMEOUT_SECONDS": "240",
        "DANUS_MAX_CONSEC_FAILURES": "1",
        "DANUS_ROUND_BEAT": "0",
    })
    if model is not None:
        model = safe_model(model)
        env.update(DANUS_MAIN_MODEL=model, DANUS_WORKER_MODEL=model, DANUS_VERIFY_MODEL=model)
    return env


def configure(value: str | Path, model: str | None = None) -> Path:
    root = prepare_data(value)
    env = environment(root, model)
    os.environ.clear()
    os.environ.update(env)
    add_import_paths()
    return root


@contextmanager
def scoped_environment(root: Path, model: str | None = None):
    # Library APIs read env at call time. Serialize and restore controller scope.
    with ENV_LOCK:
        previous = os.environ.copy()
        try:
            env = environment(root, model)
            os.environ.clear()
            os.environ.update(env)
            yield
        finally:
            os.environ.clear()
            os.environ.update(previous)


def reject_links(directory: Path) -> None:
    if directory.is_symlink():
        raise EngineError("unsafe_data")
    if directory.is_dir():
        for child in directory.iterdir():
            if child.is_symlink():
                raise EngineError("unsafe_data")
            if child.is_dir():
                reject_links(child)


def project_dir(root: Path, project: str) -> Path:
    project = safe_id(project)
    directory = checked_path(root, "projects", project)
    if not directory.is_dir():
        raise EngineError("project_not_found", 404)
    for name in ("fact_graph", "global_memory"):
        reject_links(checked_path(root, "projects", project, name))
    for name in ("project.json", "PROBLEM.md", "PROBLEM.md.tmp", ".run_deadline"):
        checked_path(root, "projects", project, name)
    workers = checked_path(root, "projects", project, "workers")
    if workers.is_dir():
        for child in workers.iterdir():
            safe_id(child.name, "invalid_worker")
            worker_dir(root, project, child.name, directory=directory)
    return directory


def worker_dir(root: Path, project: str, worker: str, *, directory: Path | None = None) -> Path:
    safe_id(project)
    safe_id(worker, "invalid_worker")
    directory = directory or project_dir(root, project)
    worker_home = checked_path(root, "projects", project, "workers", worker)
    if not worker_home.is_dir():
        raise EngineError("worker_not_found", 404)
    # Never inspect worker-local memory or runtime logs. Check their roots only.
    for name in ("local_memory", "logs", ".role", ".role.tmp", ".pid", ".pid.tmp", ".pid.lock", ".stop", ".status.json", ".status.json.tmp", "TASK.md", "TASK.md.tmp", ".codex", ".agents"):
        checked_path(root, "projects", project, "workers", worker, name)
    reject_links(worker_home / ".codex")
    # Scaffold's two immutable packaged contract/skills links are intentional.
    for relative, target in (("AGENTS.md", UPSTREAM / "agents/contracts/worker.md"), (".agents/skills", UPSTREAM / "agents/skills/worker")):
        link = worker_home / relative
        if link.is_symlink() and link.resolve() != target.resolve():
            raise EngineError("unsafe_data")
    return worker_home


def verifier_home(root: Path) -> Path:
    home = checked_path(root, "verifier-agent")
    checked_path(root, "verifier-agent", ".agents")
    reject_links(checked_path(root, "verifier-agent", ".codex"))
    for relative, target in (("AGENTS.md", UPSTREAM / "agents/contracts/verifier.md"), (".agents/skills", UPSTREAM / "agents/skills/verify")):
        link = home / relative
        if link.is_symlink() and link.resolve() != target.resolve():
            raise EngineError("unsafe_data")
    return home
