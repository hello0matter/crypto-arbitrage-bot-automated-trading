import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.run_sample import load_config, resolve_runtime_path, sha256_file


class RunSampleTests(unittest.TestCase):
    def test_load_config_accepts_minimal_valid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample_launcher.json"
            path.write_text(
                json.dumps(
                    {
                        "enabled": True,
                        "exe_path": "demo.exe",
                        "args": ["--demo"],
                        "cwd": ".",
                        "log_file": "logs/test.jsonl",
                    }
                ),
                encoding="utf-8",
            )
            config = load_config(path)
            self.assertTrue(config.enabled)
            self.assertEqual(config.exe_path, "demo.exe")
            self.assertEqual(config.args, ["--demo"])

    def test_resolve_runtime_path_supports_relative_paths(self):
        base = Path("C:/repo")
        self.assertEqual(resolve_runtime_path("bin/demo.exe", base=base), Path("C:/repo/bin/demo.exe"))

    def test_sha256_file_is_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "demo.bin"
            path.write_bytes(b"abc")
            self.assertEqual(
                sha256_file(path),
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            )


if __name__ == "__main__":
    unittest.main()
