import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from prepare_dataset import prepare, sanitize

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "ops" / "training" / "prepare_dataset.py"


class PrepareDatasetTests(unittest.TestCase):
    def write_jsonl(self, path: Path, rows: list[dict]) -> None:
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def approved(self, **overrides) -> dict:
        row = {
            "consent": True,
            "consent_reference": "manual consent record 001",
            "source": "manual_curated",
            "quality_reviewed": True,
            "task_type": "coding",
            "input": "Fix the example function and add a test.",
            "ideal_output": "I will inspect the code, make the targeted fix, and run the test.",
        }
        row.update(overrides)
        return row

    def test_sanitizes_credentials_and_email(self):
        text = (
            "Bearer abcdefghijklmnop api_key=sk_live_1234567890 "
            "contact user@example.com https://admin:secret@example.org "
            "AKIAIOSFODNN7EXAMPLE AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )
        clean, count = sanitize(text)
        self.assertGreaterEqual(count, 4)
        self.assertNotIn("abcdefghijklmnop", clean)
        self.assertNotIn("sk_live_1234567890", clean)
        self.assertNotIn("user@example.com", clean)
        self.assertNotIn("admin:secret@", clean)
        self.assertNotIn("AKIAIOSFODNN7EXAMPLE", clean)
        self.assertNotIn("AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", clean)

    def test_requires_consent_and_human_review(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.jsonl"
            self.write_jsonl(source, [
                self.approved(consent=False),
                self.approved(quality_reviewed=False),
                self.approved(consent_reference=""),
            ])
            records, stats = prepare(source)
            self.assertEqual(records, [])
            self.assertEqual(stats["skipped_no_consent"], 1)
            self.assertEqual(stats["skipped_invalid"], 2)

    def test_deduplicates_after_redaction_and_does_not_export_consent_reference(self):
        row = self.approved(input="Set api_key=secret-one in the example.")
        duplicate = self.approved(input="Set api_key=secret-two in the example.")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.jsonl"
            self.write_jsonl(source, [row, duplicate])
            records, stats = prepare(source)
            self.assertEqual(len(records), 1)
            self.assertEqual(stats["duplicates"], 1)
            exported = json.dumps(records[0])
            self.assertNotIn("manual consent record", exported)
            self.assertNotIn("secret-one", exported)
            self.assertNotIn("secret-two", exported)

    def test_dry_run_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.jsonl"
            output = Path(directory) / "prepared.jsonl"
            self.write_jsonl(source, [self.approved()])
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(source), "--output", str(output)],
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(output.exists())
            self.assertIn('"mode": "dry-run"', result.stdout)

    def test_write_requires_explicit_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.jsonl"
            output = Path(directory) / "prepared.jsonl"
            self.write_jsonl(source, [self.approved()])
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(source), "--output", str(output), "--write"],
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())
            record = json.loads(output.read_text(encoding="utf-8").splitlines()[0])
            self.assertEqual(record["messages"][-1]["role"], "assistant")


if __name__ == "__main__":
    unittest.main()
