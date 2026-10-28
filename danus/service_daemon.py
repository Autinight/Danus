"""Start and stop Danus services in isolated POSIX process groups."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Sequence


def start(pid_file: Path, log_file: Path, command: Sequence[str]) -> int:
    """Start command detached from the caller and persist its process-group id."""
    if not command:
        raise ValueError("a service command is required")
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("wb") as log:
        proc = subprocess.Popen(
            list(command), stdin=subprocess.DEVNULL, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True,
        )
    pid_file.write_text(f"{proc.pid}\n", encoding="utf-8")
    return proc.pid


def _group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop(pgid: int, grace_seconds: float = 2.0) -> None:
    """Stop a service process group, escalating to SIGKILL after the grace period."""
    if pgid <= 1:
        raise ValueError("refusing to signal a protected process-group id")
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return

    deadline = time.monotonic() + max(0.0, grace_seconds)
    while _group_exists(pgid) and time.monotonic() < deadline:
        time.sleep(0.1)

    if _group_exists(pgid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    starter = commands.add_parser("start")
    starter.add_argument("pid_file", type=Path)
    starter.add_argument("log_file", type=Path)
    starter.add_argument("command", nargs=argparse.REMAINDER)
    stopper = commands.add_parser("stop")
    stopper.add_argument("pgid", type=int)
    args = parser.parse_args(argv)

    if args.action == "start":
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("start requires a command after --")
        print(start(args.pid_file, args.log_file, command))
    else:
        stop(args.pgid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
