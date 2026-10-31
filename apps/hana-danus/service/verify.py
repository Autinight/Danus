"""Host-managed bundled verifier HTTP service (never a detached daemon)."""
from __future__ import annotations

import argparse
from pathlib import Path

import engine_env as env

env.add_import_paths()

import monitor  # noqa: E402


def authenticated_app(token_file: Path):
    from fastapi import FastAPI
    from danus.verify.service import app as service_app

    monitor.configure_token_file(str(token_file))
    # Wrap only this App runtime; do not mutate the legacy verifier singleton.
    application = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    application.middleware("http")(monitor.require_bearer_token)
    application.mount("/", service_app)
    return application


def launch(data_dir: str, model: str, token_file: str, port: int = 18540) -> None:
    if port != 18540:
        raise env.EngineError("invalid_port")
    root = env.configure(data_dir, env.safe_model(model))
    env.verifier_home(root)
    supplied = Path(token_file)
    expected = env.checked_path(root, "monitor-auth-token")
    if not supplied.is_absolute() or supplied.is_symlink() or supplied.parent.resolve() != root or supplied.name != expected.name:
        raise env.EngineError("invalid_token_file")
    application = authenticated_app(expected)
    monitor.main_ready(application, port, "HANA_DANUS_VERIFY_READY")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--port", type=int, choices=[18540], default=18540)
    args = parser.parse_args(argv)
    launch(args.data_dir, args.model, args.token_file, args.port)


if __name__ == "__main__":
    main()
