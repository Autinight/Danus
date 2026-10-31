"""Replace this host-managed process with one bundled Danus worker loop."""
from __future__ import annotations

import argparse
import json
import os

import engine_env as env

env.add_import_paths()

from danus.execution.scaffold import atomic_write  # noqa: E402


def launch(data_dir: str, project: str, worker: str, model: str | None = None) -> None:
    root = env.prepare_data(data_dir)
    home = env.worker_dir(root, project, worker)
    metadata_path = env.checked_path(root, "projects", project, "project.json")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise env.EngineError("invalid_project_data") from None
    if not isinstance(metadata, dict) or not isinstance(metadata.get("workers"), list) or worker not in metadata["workers"]:
        raise env.EngineError("worker_not_found", 404)
    selected_model = env.resolve_model(model if model is not None else metadata.get("model"))
    env.configure(str(root), selected_model)
    os.environ.update(DANUS_PROJECT_DIR=str(home.parents[1]), DANUS_AUTHOR=worker, DANUS_ROLE="worker")
    # The loop reads MODEL from .role ahead of env; keep explicit overrides effective.
    atomic_write(home / ".role", f"MODEL={selected_model}\nREASONING_EFFORT=high\nROLE=high\nDANUS_AUTHOR={worker}\n")
    atomic_write(home / ".pid", f"{os.getpid()}\n")
    os.execv(str(env.PYTHON), [str(env.PYTHON), "-B", "-m", "danus.execution", str(home)])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--model")
    args = parser.parse_args(argv)
    launch(args.data_dir, args.project, args.worker, args.model)


if __name__ == "__main__":
    main()
