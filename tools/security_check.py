#!/usr/bin/env python3
"""Read-only repository safety baseline for this project.

The checker has no third-party dependencies and never imports the trading
package. It highlights execution sinks, risky workflow configuration, and
dependency entries that require manual review.
"""

from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_CALLS = {
    "eval": ("high", "dynamic Python evaluation"),
    "exec": ("high", "dynamic Python execution"),
    "os.system": ("high", "shell command execution"),
    "os.popen": ("high", "shell command execution"),
    "subprocess.Popen": ("medium", "process creation"),
    "subprocess.run": ("medium", "process creation"),
    "subprocess.call": ("medium", "process creation"),
    "pickle.load": ("high", "unsafe deserialization"),
    "pickle.loads": ("high", "unsafe deserialization"),
    "yaml.load": ("high", "unsafe YAML deserialization"),
}


@dataclass(frozen=True)
class Finding:
    severity: str
    path: Path
    line: int
    message: str


def dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return None


def scan_python(path: Path) -> list[Finding]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, UnicodeDecodeError, SyntaxError) as exc:
        return [Finding("high", path, 0, f"unable to parse Python safely: {exc}")]

    findings: list[Finding] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            call = dotted_name(node.func)
            if call in PYTHON_CALLS:
                severity, description = PYTHON_CALLS[call]
                findings.append(Finding(severity, path, node.lineno, description))
    return findings


def scan_workflows(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for path in sorted((root / ".github" / "workflows").glob("*.y*ml")):
        text = path.read_text(encoding="utf-8")
        if "permissions:" not in text:
            findings.append(Finding("medium", path, 0, "workflow does not declare least-privilege permissions"))
        for line_no, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("uses:") and "@" in stripped:
                ref = stripped.rsplit("@", 1)[1]
                if len(ref) != 40 or any(char not in "0123456789abcdef" for char in ref.lower()):
                    findings.append(Finding("low", path, line_no, "GitHub Action is tag-pinned, not commit-pinned"))
    return findings


def scan_repository(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for path in sorted(root.rglob("*.py")):
        if any(part in {".git", ".venv", "venv", "__pycache__"} for part in path.parts):
            continue
        findings.extend(scan_python(path))

    requirements = root / "requirements.txt"
    if requirements.exists():
        for line_no, line in enumerate(requirements.read_text(encoding="utf-8").splitlines(), start=1):
            if line.strip().lower().startswith("asyncio"):
                findings.append(Finding("medium", requirements, line_no, "external asyncio package shadows Python's standard library"))

    readme = root / "README.md"
    if readme.exists():
        for line_no, line in enumerate(readme.read_text(encoding="utf-8").splitlines(), start=1):
            if ".exe" in line.lower() and "http" in line.lower():
                findings.append(Finding("medium", readme, line_no, "external executable download link requires provenance review"))

    findings.extend(scan_workflows(root))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only repository security baseline")
    parser.add_argument("--strict", action="store_true", help="return non-zero for high-severity findings")
    args = parser.parse_args()

    findings = scan_repository(ROOT)
    if not findings:
        print("No configured high-risk patterns found.")
        return 0

    for finding in findings:
        relative = finding.path.relative_to(ROOT)
        location = f"{relative}:{finding.line}" if finding.line else str(relative)
        print(f"[{finding.severity.upper()}] {location} - {finding.message}")

    return 1 if args.strict and any(finding.severity == "high" for finding in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
