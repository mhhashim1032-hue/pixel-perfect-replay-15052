#!/usr/bin/env python3
"""Prepare explicitly consented, human-reviewed Forge examples for optional SFT.

No application database, chat history, provider API, or remote service is accessed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

MAX_FIELD_CHARS = 200_000
SYSTEM_PROMPT = (
    "You are Forge, a careful general-purpose working agent. Respect the user's scope, "
    "use only available authorized tools, protect secrets, preserve customer data, and "
    "verify consequential outcomes before claiming completion."
)
SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "[REDACTED_PRIVATE_KEY]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[REDACTED_JWT]"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/\-=]{12,}", re.IGNORECASE), "Bearer [REDACTED]"),
    (re.compile(r"\b(?:sk|pk|rk|ghp|gho|github_pat|xoxb|xoxp|sb_secret)[-_][A-Za-z0-9_-]{8,}\b", re.IGNORECASE), "[REDACTED_KEY]"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "[REDACTED_AWS_KEY]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"), "[REDACTED_GOOGLE_KEY]"),
    (re.compile(r"\b(?:glpat-|hf_|npm_|pypi-)[A-Za-z0-9_-]{8,}\b", re.IGNORECASE), "[REDACTED_KEY]"),
    (re.compile(r"(https?://)[^/\s:@]+:[^/\s@]+@", re.IGNORECASE), r"\1[REDACTED]@"),
    (re.compile(r"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key|secret|password|authorization)\b\s*[:=]\s*[\"']?[^\"'\s,;]+", re.IGNORECASE), "[REDACTED_ASSIGNMENT]"),
    (re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), "[REDACTED_EMAIL]"),
]
ALLOWED_TASK_TYPES = {"coding", "research", "operations", "documents", "data", "business", "other"}


def sanitize(value: str) -> tuple[str, int]:
    redactions = 0
    result = value
    for pattern, replacement in SECRET_PATTERNS:
        result, count = pattern.subn(replacement, result)
        redactions += count
    return result.strip(), redactions


def normalized_hash(task_type: str, user_input: str, ideal_output: str) -> str:
    canonical = "\n".join((task_type.strip().lower(), user_input.strip(), ideal_output.strip()))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def prepare(input_path: Path) -> tuple[list[dict[str, Any]], dict[str, int]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    stats = {
        "lines": 0,
        "eligible": 0,
        "skipped_no_consent": 0,
        "skipped_invalid": 0,
        "duplicates": 0,
        "redacted_fields": 0,
    }

    with input_path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            stats["lines"] += 1
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                stats["skipped_invalid"] += 1
                continue
            if not isinstance(item, dict) or item.get("consent") is not True:
                stats["skipped_no_consent"] += 1
                continue
            consent_reference = item.get("consent_reference")
            source_label = item.get("source")
            if (
                not isinstance(consent_reference, str) or not consent_reference.strip()
                or not isinstance(source_label, str) or source_label not in {"manual_curated", "user_approved"}
                or item.get("quality_reviewed") is not True
            ):
                stats["skipped_invalid"] += 1
                continue

            task_type = item.get("task_type")
            user_input = item.get("input")
            ideal_output = item.get("ideal_output")
            if (
                not isinstance(task_type, str) or task_type not in ALLOWED_TASK_TYPES
                or not isinstance(user_input, str) or not user_input.strip()
                or not isinstance(ideal_output, str) or not ideal_output.strip()
                or len(user_input) > MAX_FIELD_CHARS
                or len(ideal_output) > MAX_FIELD_CHARS
            ):
                stats["skipped_invalid"] += 1
                continue

            clean_input, input_redactions = sanitize(user_input)
            clean_output, output_redactions = sanitize(ideal_output)
            stats["redacted_fields"] += int(input_redactions > 0) + int(output_redactions > 0)
            if not clean_input or not clean_output:
                stats["skipped_invalid"] += 1
                continue

            digest = normalized_hash(task_type, clean_input, clean_output)
            if digest in seen:
                stats["duplicates"] += 1
                continue
            seen.add(digest)
            records.append({
                "id": digest[:20],
                "task_type": task_type,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": "[Task type: " + task_type + "]\n" + clean_input},
                    {"role": "assistant", "content": clean_output},
                ],
            })
            stats["eligible"] += 1

    return records, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare consented, reviewed Forge SFT examples.")
    parser.add_argument("--input", required=True, type=Path, help="JSONL source file with explicit consent metadata.")
    parser.add_argument("--output", type=Path, default=Path("forge-sft-prepared.jsonl"))
    parser.add_argument("--write", action="store_true", help="Write output. Without this flag, performs a dry run only.")
    parser.add_argument("--overwrite", action="store_true", help="Allow replacing an existing output file.")
    args = parser.parse_args()

    if not args.input.is_file():
        parser.error("Input file does not exist.")
    if args.write and args.output.resolve() == args.input.resolve():
        parser.error("Output must not overwrite the raw consented source file.")
    if args.write and args.output.exists() and not args.overwrite:
        parser.error("Output already exists; pass --overwrite to replace it.")

    records, stats = prepare(args.input)
    if not records:
        print(json.dumps({**stats, "written": 0, "mode": "dry-run" if not args.write else "write"}, indent=2))
        print("No eligible examples. Require explicit consent, a consent reference, human review and valid input/output.", file=sys.stderr)
        return 2

    written = 0
    if args.write:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as target:
            for record in records:
                target.write(json.dumps(record, ensure_ascii=False) + "\n")
        temporary.replace(args.output)
        written = len(records)

    print(json.dumps({
        **stats,
        "written": written,
        "mode": "write" if args.write else "dry-run",
        "output": str(args.output) if args.write else None,
    }, indent=2))
    if not args.write:
        print("Dry run only. Review the source and run again with --write to create the dataset.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
