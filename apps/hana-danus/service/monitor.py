"""Read-only loopback adapter for the bundled Danus observability builders."""
from __future__ import annotations

import argparse
import glob
import hmac
import ipaddress
import re
import stat
import sys
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
UPSTREAM = APP_DIR / "upstream" / "danus"
DEPENDENCIES = APP_DIR / "dependencies" / "python"
for dependency_path in [*glob.glob(str(DEPENDENCIES / "lib" / "python*" / "site-packages")), str(DEPENDENCIES / "site-packages"), str(UPSTREAM)]:
    if dependency_path not in sys.path:
        sys.path.insert(0, dependency_path)

from fastapi import FastAPI, HTTPException, Query, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from danus.observability.app import (  # noqa: E402
    CHANNELS,
    build_channel,
    build_channels,
    build_factgraph,
    build_overview,
)

_PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
app = FastAPI(title="hana-danus-monitor", docs_url=None, redoc_url=None, openapi_url=None)
_projects_root: Optional[Path] = None
_token_file: Optional[Path] = None
_TOKEN = re.compile(r"^[a-f0-9]{64}$")


def configure_token_file(value: str) -> None:
    global _token_file
    _token_file = Path(value).expanduser().absolute()


def configure_projects_root(value: str, data_dir: str) -> None:
    global _projects_root
    candidate = Path(value).expanduser() if value else Path(data_dir) / "projects"
    if not candidate.is_absolute():
        raise ValueError("projects root must be an absolute path")
    _projects_root = candidate.resolve(strict=False)


def project_root(project_id: Optional[str]) -> Path:
    if _projects_root is None:
        raise RuntimeError("projects root is not configured")
    if project_id is None or project_id == "":
        raise HTTPException(status_code=400, detail={"code": "project_required", "message": "Choose a project."})
    if not _PROJECT_ID.fullmatch(project_id) or project_id in {".", ".."}:
        raise HTTPException(status_code=400, detail={"code": "invalid_project", "message": "Invalid project id."})
    candidate = _projects_root / project_id
    if candidate.is_symlink():
        raise HTTPException(status_code=400, detail={"code": "invalid_project", "message": "Project symlinks are not allowed."})
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(_projects_root)
    except ValueError:
        raise HTTPException(status_code=400, detail={"code": "invalid_project", "message": "Project is outside the configured root."})
    if not resolved.is_dir():
        raise HTTPException(status_code=404, detail={"code": "project_not_found", "message": "Project not found."})
    for subdir in (resolved / "fact_graph", resolved / "fact_graph" / "facts", resolved / "global_memory"):
        if subdir.is_symlink():
            raise HTTPException(status_code=400, detail={"code": "invalid_project", "message": "Project data symlinks are not allowed."})
    for folder in (resolved / "fact_graph" / "facts", resolved / "global_memory"):
        if folder.is_dir() and any(path.is_symlink() for path in folder.iterdir()):
            raise HTTPException(status_code=400, detail={"code": "invalid_project", "message": "Project data symlinks are not allowed."})
    return resolved


def _project_name(path: Path) -> str:
    return path.name


@app.middleware("http")
async def require_bearer_token(request: Request, call_next):
    if _token_file is None:
        return JSONResponse({"error": {"code": "monitor_unavailable", "message": "Monitor authentication is unavailable."}}, status_code=503)
    try:
        metadata = _token_file.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise OSError("invalid token file")
        expected = _token_file.read_text(encoding="ascii").strip()
        if not _TOKEN.fullmatch(expected):
            raise OSError("invalid token file")
    except (OSError, UnicodeError):
        return JSONResponse({"error": {"code": "monitor_unavailable", "message": "Monitor authentication is unavailable."}}, status_code=503)

    authorization = request.headers.get("authorization", "")
    scheme, separator, supplied = authorization.partition(" ")
    if scheme.lower() != "bearer" or not separator or not _TOKEN.fullmatch(supplied):
        return JSONResponse(
            {"error": {"code": "unauthorized", "message": "A valid bearer token is required."}},
            status_code=401,
            headers={"www-authenticate": "Bearer"},
        )
    if not hmac.compare_digest(supplied, expected):
        return JSONResponse(
            {"error": {"code": "unauthorized", "message": "A valid bearer token is required."}},
            status_code=401,
            headers={"www-authenticate": "Bearer"},
        )
    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/projects")
def projects():
    if _projects_root is None or not _projects_root.is_dir():
        return {"projects": []}
    found = []
    for item in sorted(_projects_root.iterdir(), key=lambda p: p.name.casefold()):
        if not _PROJECT_ID.fullmatch(item.name) or item.is_symlink() or not item.is_dir():
            continue
        try:
            resolved = item.resolve(strict=True)
            resolved.relative_to(_projects_root)
        except (OSError, ValueError):
            continue
        found.append({"id": item.name, "name": item.name})
    return {"projects": found}


@app.get("/api/overview")
def overview(project: str = Query(..., min_length=1, max_length=128)):
    return build_overview(project_root(project))


@app.get("/api/factgraph")
def factgraph(project: str = Query(..., min_length=1, max_length=128)):
    return build_factgraph(project_root(project))


@app.get("/api/channels")
def channels(project: str = Query(..., min_length=1, max_length=128)):
    return build_channels(project_root(project))


@app.get("/api/channel/{kind}")
def channel(kind: str, project: str = Query(..., min_length=1, max_length=128)):
    try:
        return build_channel(kind, project_root(project))
    except KeyError:
        raise HTTPException(status_code=404, detail={"code": "unknown_channel", "message": "Unknown channel."})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--projects-root", default="")
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--port", type=int, default=18539)
    args = parser.parse_args()
    configure_token_file(args.token_file)
    configure_projects_root(args.projects_root, args.data_dir)
    try:
        ipaddress.ip_address("127.0.0.1")
    except ValueError as exc:
        raise RuntimeError("loopback address unavailable") from exc

    main_ready(app, args.port)


def main_ready(application, port: int = 18539, marker: str = "HANA_DANUS_MONITOR_READY") -> None:
    import uvicorn

    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started:
                print(marker, flush=True)

    config = uvicorn.Config(application, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    ReadyServer(config).run()


if __name__ == "__main__":
    main()
