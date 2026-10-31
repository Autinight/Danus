"""Authenticated App-owned controller; runtimes are started only by the Hana host."""
from __future__ import annotations

import argparse
import json
import re
import stat
import subprocess
import uuid
from pathlib import Path

import engine_env as env

env.add_import_paths()

from fastapi import Query  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel, ConfigDict, Field  # noqa: E402
from danus.core.factgraph import FactGraph, parse_frontmatter  # noqa: E402
from danus.execution.scaffold import atomic_write, do_new  # noqa: E402
from danus.orchestration.cli import do_assign, do_status  # noqa: E402
import monitor  # noqa: E402

app = monitor.app
_data_dir: Path | None = None

TASK = """# One full theorem

Read ../../PROBLEM.md for the complete theorem. Prove exactly that full theorem,
then submit its complete statement and proof through fact_submit. Do not submit
additional lemmas or partial results. The verifier is the sole acceptance gate.
Stop after the result of that submission; do not start another problem or round.
All mathematical work is text-only. No executable mathematical experimentation,
computation, proof assistants, or numerical checks, even for a tiny example.
"""


class ProjectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    project: str | None = None
    problem: str = Field(min_length=1, max_length=16000)
    model: str | None = None
    workers: int = Field(default=1, ge=1, le=4)


def configure(data_dir: str, token_file: str) -> None:
    global _data_dir
    _data_dir = env.configure(data_dir)
    supplied = Path(token_file)
    # The host creates the token in App data. Never accept a token outside it.
    if not supplied.is_absolute() or supplied.parent.resolve() != _data_dir or supplied.is_symlink():
        raise env.EngineError("invalid_token_file")
    token = env.checked_path(_data_dir, supplied.name)
    monitor.configure_token_file(str(token))
    monitor.configure_projects_root("", str(_data_dir))


def root() -> Path:
    if _data_dir is None:
        raise env.EngineError("engine_unavailable", 503)
    return env.prepare_data(_data_dir)


def error_response(error: env.EngineError) -> JSONResponse:
    return JSONResponse({"error": {"code": error.code}}, status_code=error.status)


def account_status() -> dict:
    directory = root()
    model = env.configured_model()
    try:
        completed = subprocess.run(
            [str(env.CODEX), "login", "status"],
            cwd=str(directory), env=env.environment(directory, model),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise env.EngineError("account_unavailable", 503) from None
    return {"logged_in": completed.returncode == 0, "model": model,
            "account_source": "system_codex", "engine": "bundled", "storage": "app"}


@app.get("/control/account")
def account():
    try:
        return account_status()
    except env.EngineError as error:
        return error_response(error)


@app.post("/control/projects")
def create_project(request: ProjectRequest):
    try:
        directory = root()
        project = env.safe_id(request.project) if request.project is not None else "project-" + uuid.uuid4().hex[:16]
        model = env.resolve_model(request.model)
        if not request.problem.strip():
            raise env.EngineError("problem_required")
        with env.scoped_environment(directory, model):
            destination = env.checked_path(directory, "projects", project)
            if destination.exists():
                raise env.EngineError("project_exists", 409)
            # do_new scaffolds only; do_start/spawn_loop are never called here.
            created = do_new(project, roles=f"high:{request.workers}", model=model)
            atomic_write(destination / "PROBLEM.md", request.problem + "\n")
            for worker in created["workers"]:
                do_assign(f"{project}/{worker}", TASK)
        return {"project": project, "model": model, "workers": created["workers"],
                "engine": "bundled", "storage": "app"}
    except env.EngineError as error:
        return error_response(error)
    except (OSError, SystemExit):
        return error_response(env.EngineError("project_create_failed", 409))


def last_verdict(project: Path) -> str | None:
    path = project / "global_memory" / "verification.jsonl"
    if not path.is_file():
        return None
    verdict = None
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict) and isinstance(entry.get("verdict"), str) and entry["verdict"] in {"correct", "wrong", "error"}:
                verdict = entry["verdict"]
    return verdict


@app.get("/control/status")
def status(project: str = Query(..., min_length=1, max_length=128)):
    try:
        directory = root()
        with env.scoped_environment(directory):
            selected = env.project_dir(directory, project)
            rows = do_status(project)
            for row in rows:
                worker = env.worker_dir(directory, project, row["worker"], directory=selected)
                control = worker / ".status.json"
                record = json.loads(control.read_text(encoding="utf-8")) if control.exists() else {}
                last_rc = record.get("last_rc")
                if last_rc is not None and type(last_rc) is not int:
                    raise env.EngineError("status_unavailable", 503)
                row["last_rc"] = last_rc
            fact_ids = FactGraph(selected).list()
            result = {"project": project, "workers": rows, "fact_count": len(fact_ids),
                      "verified_fact_ids": fact_ids, "engine": "bundled", "storage": "app"}
            verdict = last_verdict(selected)
            if verdict is not None:
                result["last_verdict"] = verdict
            return result
    except env.EngineError as error:
        return error_response(error)
    except (OSError, SystemExit, ValueError, TypeError, AttributeError):
        return error_response(env.EngineError("status_unavailable", 503))


@app.get("/control/result")
def result(project: str | None = Query(None), fact_id: str | None = Query(None)):
    try:
        if project is None:
            raise env.EngineError("project_required")
        env.safe_id(project)
        if not isinstance(fact_id, str) or not re.fullmatch(r"[a-f0-9]{16}", fact_id):
            raise env.EngineError("invalid_fact_id")
        directory = root()
        selected = env.project_dir(directory, project)
        control = env.checked_path(directory, "projects", project, "fact_graph", "facts", f"{fact_id}.md")
        graph = FactGraph(selected)
        if fact_id not in graph.list():
            raise env.EngineError("fact_not_found", 404)
        try:
            metadata = control.lstat()
        except FileNotFoundError:
            raise env.EngineError("fact_not_found", 404) from None
        if not stat.S_ISREG(metadata.st_mode):
            raise env.EngineError("result_unavailable", 503)
        try:
            raw = graph.get_raw(fact_id)
        except FileNotFoundError:
            raise env.EngineError("fact_not_found", 404) from None
        if raw is None:
            raise env.EngineError("fact_not_found", 404)
        return {"project": project, "fact_id": fact_id, "markdown": raw,
                "predecessors": parse_frontmatter(raw)["predecessors"],
                "source": "fact_graph", "engine": "bundled", "storage": "app"}
    except env.EngineError as error:
        return error_response(error)
    except Exception:
        return error_response(env.EngineError("result_unavailable", 503))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--port", type=int, choices=[18539], default=18539)
    args = parser.parse_args(argv)
    configure(args.data_dir, args.token_file)
    monitor.main_ready(app, args.port)


if __name__ == "__main__":
    main()
