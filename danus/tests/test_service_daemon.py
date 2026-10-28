from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from danus import service_daemon


def test_service_runs_in_own_process_group_and_stops(tmp_path: Path):
    pid_file = tmp_path / "runtime" / "service.pid"
    log_file = tmp_path / "runtime" / "service.log"
    launched = subprocess.run(
        [
            sys.executable, "-m", "danus.service_daemon", "start",
            str(pid_file), str(log_file), "--",
            sys.executable, "-c", "import time; time.sleep(60)",
        ],
        capture_output=True, text=True, check=True,
    )
    pid = int(launched.stdout.strip())

    try:
        assert int(pid_file.read_text().strip()) == pid
        assert os.getpgid(pid) == pid
        assert service_daemon._group_exists(pid)
        service_daemon.stop(pid, grace_seconds=1)
        deadline = time.monotonic() + 3
        while service_daemon._group_exists(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not service_daemon._group_exists(pid)
    finally:
        if service_daemon._group_exists(pid):
            service_daemon.stop(pid, grace_seconds=0)


def test_start_rejects_empty_command(tmp_path: Path):
    try:
        service_daemon.start(tmp_path / "service.pid", tmp_path / "service.log", [])
    except ValueError as exc:
        assert "command is required" in str(exc)
    else:
        raise AssertionError("empty service command was accepted")


def test_stop_rejects_protected_process_group_ids():
    try:
        service_daemon.stop(1)
    except ValueError as exc:
        assert "protected process-group id" in str(exc)
    else:
        raise AssertionError("protected process group was accepted")
