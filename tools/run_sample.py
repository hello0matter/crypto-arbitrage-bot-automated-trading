#!/usr/bin/env python3
"""Visible local sample launcher with audit-friendly logging."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "sample_launcher.json"
DEFAULT_LOG_DIR = ROOT / "logs"
DEFAULT_LOG_FILE = DEFAULT_LOG_DIR / "sample_runs.jsonl"


@dataclass(frozen=True)
class LaunchConfig:
    enabled: bool
    exe_path: str
    args: list[str]
    cwd: str
    log_file: str


def build_template() -> dict[str, object]:
    return {
        "enabled": False,
        "exe_path": "C:/path/to/sample.exe",
        "args": [],
        "cwd": ".",
        "log_file": "logs/sample_runs.jsonl",
    }


def ensure_template(path: Path) -> None:
    path.write_text(json.dumps(build_template(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_config(path: Path) -> LaunchConfig:
    if not path.exists():
        ensure_template(path)
        raise FileNotFoundError(f"配置文件不存在，已生成模板: {path}")

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("配置文件必须是 JSON object")

    enabled = bool(data.get("enabled", False))
    exe_path = str(data.get("exe_path", "")).strip()
    args = data.get("args", [])
    cwd = str(data.get("cwd", ".")).strip() or "."
    log_file = str(data.get("log_file", "logs/sample_runs.jsonl")).strip() or "logs/sample_runs.jsonl"

    if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
        raise ValueError("args 必须是字符串数组")
    if not exe_path:
        raise ValueError("exe_path 不能为空")

    return LaunchConfig(
        enabled=enabled,
        exe_path=exe_path,
        args=args,
        cwd=cwd,
        log_file=log_file,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_config_path(raw: str | None) -> Path:
    if not raw:
        return DEFAULT_CONFIG
    return Path(raw).expanduser().resolve()


def resolve_runtime_path(value: str, *, base: Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return (base / path).resolve()


def append_log(log_path: Path, payload: dict[str, object]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def confirm() -> bool:
    answer = input("确认启动上述 EXE 吗？输入 yes 继续: ").strip().lower()
    return answer == "yes"


def launch(config: LaunchConfig, *, config_path: Path) -> int:
    config_dir = config_path.parent
    exe_path = resolve_runtime_path(config.exe_path, base=config_dir)
    cwd_path = resolve_runtime_path(config.cwd, base=config_dir)
    log_path = resolve_runtime_path(config.log_file, base=config_dir)

    if not config.enabled:
        print("配置文件中的 enabled=false；当前仅打印信息，不启动。")
        return 2

    if not exe_path.exists():
        raise FileNotFoundError(f"EXE 不存在: {exe_path}")
    if not cwd_path.exists():
        raise FileNotFoundError(f"工作目录不存在: {cwd_path}")

    file_sha256 = sha256_file(exe_path)
    command = [str(exe_path), *config.args]

    print("=== Visible Local Sample Launcher ===")
    print(f"config   : {config_path}")
    print(f"exe      : {exe_path}")
    print(f"cwd      : {cwd_path}")
    print(f"args     : {config.args}")
    print(f"log file : {log_path}")
    print(f"sha256   : {file_sha256}")

    if not confirm():
        print("已取消。")
        return 3

    launched_at = datetime.now(timezone.utc).astimezone().isoformat()
    with open(os.devnull, "rb") as stdin_handle, log_path.open("a", encoding="utf-8") as stdout_handle:
        process = subprocess.Popen(
            command,
            cwd=str(cwd_path),
            stdin=stdin_handle,
            stdout=stdout_handle,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )

    payload = {
        "launched_at": launched_at,
        "exe_path": str(exe_path),
        "cwd": str(cwd_path),
        "args": config.args,
        "sha256": file_sha256,
        "pid": process.pid,
        "config": asdict(config),
    }
    append_log(log_path, payload)

    print(f"已启动，PID={process.pid}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Visible local EXE launcher with audit logging")
    parser.add_argument("config", nargs="?", help=f"配置文件路径，默认 {DEFAULT_CONFIG.name}")
    args = parser.parse_args(argv)

    config_path = resolve_config_path(args.config)
    try:
        config = load_config(config_path)
        return launch(config, config_path=config_path)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
