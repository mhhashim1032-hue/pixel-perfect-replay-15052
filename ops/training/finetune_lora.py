#!/usr/bin/env python3
"""Optional 4-bit LoRA SFT for an open-weight causal LM on a CUDA GPU.

The script reads only a locally prepared JSONL dataset. It never uploads data or weights.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import torch
from datasets import load_dataset
from peft import LoraConfig, TaskType, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a small LoRA adapter for an open-weight Forge model.")
    parser.add_argument("--model", required=True, help="Open-weight Hugging Face model ID or local model directory.")
    parser.add_argument("--revision", required=True, help="Pin an immutable model commit/revision; use a local version label for local weights.")
    parser.add_argument("--dataset", required=True, type=Path, help="Prepared JSONL from prepare_dataset.py.")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--max-samples", type=int, default=0, help="Optional cap; 0 uses the full dataset.")
    parser.add_argument(
        "--target-modules",
        default="q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj",
        help="Comma-separated LoRA target module names; adjust for the selected architecture.",
    )
    parser.add_argument("--trust-remote-code", action="store_true", help="Only for a model repository you have audited.")
    return parser.parse_args()


def dataset_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_digest(path: Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(item for item in path.rglob("*") if item.is_file()):
        digest.update(file_path.relative_to(path).as_posix().encode("utf-8"))
        with file_path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "not-installed"


def format_example(messages: list[dict[str, str]], tokenizer: Any) -> tuple[list[int], list[int]]:
    if not messages or messages[-1].get("role") != "assistant":
        raise ValueError("Each training example must end with an assistant message.")
    if not any(message.get("role") == "user" for message in messages):
        raise ValueError("Each training example must include a user message.")

    if tokenizer.chat_template:
        prefix_ids = tokenizer.apply_chat_template(
            messages[:-1], tokenize=True, add_generation_prompt=True
        )
        full_ids = tokenizer.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=False
        )
    else:
        system = next((m["content"] for m in messages if m.get("role") == "system"), "")
        user = "\n".join(m["content"] for m in messages if m.get("role") == "user")
        assistant = "\n".join(m["content"] for m in messages if m.get("role") == "assistant")
        prefix_text = (("System:\n" + system + "\n") if system else "") + "User:\n" + user + "\nAssistant:\n"
        prefix_ids = tokenizer(prefix_text, add_special_tokens=True)["input_ids"]
        full_ids = tokenizer(prefix_text + assistant, add_special_tokens=True)["input_ids"]

    common = 0
    for left, right in zip(prefix_ids, full_ids):
        if left != right:
            break
        common += 1
    if common >= len(full_ids):
        raise ValueError("Chat template produced no assistant target tokens.")
    return full_ids, [-100] * common + full_ids[common:]


class AssistantOnlyCollator:
    def __init__(self, tokenizer: Any):
        self.pad_id = tokenizer.pad_token_id
        if self.pad_id is None:
            raise ValueError("Tokenizer must have a pad token.")

    def __call__(self, features: list[dict[str, list[int]]]) -> dict[str, torch.Tensor]:
        max_length = max(len(item["input_ids"]) for item in features)
        input_ids = torch.full((len(features), max_length), self.pad_id, dtype=torch.long)
        attention_mask = torch.zeros((len(features), max_length), dtype=torch.long)
        labels = torch.full((len(features), max_length), -100, dtype=torch.long)
        for index, item in enumerate(features):
            length = len(item["input_ids"])
            input_ids[index, :length] = torch.tensor(item["input_ids"], dtype=torch.long)
            attention_mask[index, :length] = 1
            labels[index, :length] = torch.tensor(item["labels"], dtype=torch.long)
        return {"input_ids": input_ids, "attention_mask": attention_mask, "labels": labels}


def main() -> int:
    args = parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("A CUDA GPU is required. Use a temporary Kaggle/Colab GPU; CPU-only Oracle A1 is not suitable for LoRA training.")
    if not args.dataset.is_file():
        raise SystemExit("Prepared dataset file does not exist.")
    if args.output_dir.exists() and (not args.output_dir.is_dir() or any(args.output_dir.iterdir())):
        raise SystemExit("Output path must be a new or empty directory; adapters are never overwritten.")
    if args.epochs <= 0 or args.batch_size < 1 or args.gradient_accumulation < 1 or args.learning_rate <= 0:
        raise SystemExit("Epochs, batch size, gradient accumulation and learning rate must be positive.")
    if args.max_seq_length < 256 or args.max_seq_length > 8192 or args.max_samples < 0:
        raise SystemExit("Sequence length must be 256–8192 and max samples must be zero or positive.")
    target_modules = [value.strip() for value in args.target_modules.split(",") if value.strip()]
    if not target_modules:
        raise SystemExit("At least one LoRA target module is required.")

    dataset = load_dataset("json", data_files=str(args.dataset), split="train")
    if args.max_samples:
        dataset = dataset.select(range(min(args.max_samples, len(dataset))))
    if len(dataset) == 0:
        raise SystemExit("Prepared dataset is empty.")
    if len(dataset) < 20:
        print("Warning: fewer than 20 examples; treat this run as a technical smoke test, not meaningful training.")
    if "messages" not in dataset.column_names:
        raise SystemExit("Dataset must contain a messages array per record.")

    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    )
    tokenizer = AutoTokenizer.from_pretrained(args.model, revision=args.revision, trust_remote_code=args.trust_remote_code)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        revision=args.revision,
        quantization_config=quantization,
        device_map="auto",
        torch_dtype=compute_dtype,
        trust_remote_code=args.trust_remote_code,
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
        target_modules=target_modules,
    ))
    model.print_trainable_parameters()

    def tokenize(row: dict[str, Any]) -> dict[str, list[int]]:
        ids, labels = format_example(row["messages"], tokenizer)
        ids = ids[: args.max_seq_length]
        labels = labels[: args.max_seq_length]
        if not any(label != -100 for label in labels):
            raise ValueError("An example has no assistant target tokens after truncation.")
        return {"input_ids": ids, "labels": labels}

    tokenized = dataset.map(tokenize, remove_columns=dataset.column_names)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    training = TrainingArguments(
        output_dir=str(args.output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation,
        learning_rate=args.learning_rate,
        warmup_ratio=0.03,
        logging_steps=5,
        save_strategy="epoch",
        save_total_limit=2,
        fp16=compute_dtype == torch.float16,
        bf16=compute_dtype == torch.bfloat16,
        gradient_checkpointing=True,
        optim="paged_adamw_8bit",
        report_to="none",
        remove_unused_columns=False,
    )
    trainer = Trainer(
        model=model,
        args=training,
        train_dataset=tokenized,
        data_collator=AssistantOnlyCollator(tokenizer),
        tokenizer=tokenizer,
    )
    result = trainer.train()
    trainer.save_model(str(args.output_dir))
    tokenizer.save_pretrained(str(args.output_dir))
    manifest = {
        "base_model": args.model,
        "model_revision": args.revision,
        "adapter_sha256": directory_digest(args.output_dir),
        "dataset_sha256": dataset_digest(args.dataset),
        "dataset_examples": len(tokenized),
        "gpu": torch.cuda.get_device_name(0),
        "python_version": __import__("platform").python_version(),
        "torch_version": torch.__version__,
        "cuda_version": torch.version.cuda,
        "package_versions": {
            "transformers": package_version("transformers"),
            "peft": package_version("peft"),
            "datasets": package_version("datasets"),
            "bitsandbytes": package_version("bitsandbytes"),
        },
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "gradient_accumulation": args.gradient_accumulation,
        "learning_rate": args.learning_rate,
        "max_seq_length": args.max_seq_length,
        "target_modules": target_modules,
        "training_metrics": result.metrics,
        "uploaded": False,
    }
    (args.output_dir / "run_manifest.json").write_text(
        json.dumps(manifest, indent=2, default=str) + "\n", encoding="utf-8"
    )
    print(json.dumps({"adapter_dir": str(args.output_dir), "examples": len(tokenized), "uploaded": False}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
