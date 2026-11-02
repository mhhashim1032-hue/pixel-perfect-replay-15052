# Optional Forge model adaptation (zero-budget workflow)

This folder provides an **optional, offline** dataset-preparation and LoRA fine-tuning path for open-weight causal language models.

Important distinctions:
- The Forge application does not train its current hosted GPT/Claude/Gemini model weights.
- This repository does not collect task prompts, private repositories, customer files, or chat history for training.
- No model was trained as part of CI or this PR. No model weights or provider settings were changed.
- Fine-tuning requires a compatible open-weight base model, a high-quality consented dataset, a CUDA GPU and a serving path that supports LoRA adapters.
- Oracle Always Free A1 is CPU-only. Use it for the background keeper, not for 4-bit LoRA training.

## 1. Prepare examples manually

Create a JSONL file where each line resembles:

~~~json
{"consent":true,"consent_reference":"manual-approval-2026-001","source":"manual_curated","quality_reviewed":true,"task_type":"coding","input":"A sanitized task request...","ideal_output":"A reviewed ideal assistant response..."}
~~~

Allowed task types: coding, research, operations, documents, data, business, other.

Every record must have:
- explicit consent set to true;
- a non-empty consent reference (an internal reference ID, not a person's name or sensitive detail);
- source set to manual_curated or user_approved;
- quality_reviewed set to true;
- a task type, input and ideal output.

Do not use raw customer repository contents, private support conversations, personal data or provider logs without explicit consent and a lawful basis. Do not include secrets. The preparation script redacts common credentials, JWTs, URL credentials and email addresses, but redaction is a safety net, not permission to upload sensitive data.

## 2. Validate and prepare the dataset

Run a dry-run first; it does not create an output file:

~~~bash
python ops/training/prepare_dataset.py --input ./approved-examples.jsonl
~~~

Review the counts. To write the prepared JSONL explicitly:

~~~bash
python ops/training/prepare_dataset.py --input ./approved-examples.jsonl --output ./forge-sft-prepared.jsonl --write
~~~

The output excludes consent references and source metadata, deduplicates sanitized examples and contains only a system/user/assistant message sequence. The script does not access the network or the Forge database.

## 3. Train an adapter on a temporary GPU

Use a compatible Kaggle or Colab GPU notebook. Free GPU access is temporary, quota/capacity dependent and not an uptime guarantee.

1. Select an open-weight model whose license permits your intended use and whose chat template and architecture are compatible.
2. Install a PyTorch build matching the notebook's CUDA driver.
3. Install the optional packages:

~~~bash
pip install -r ops/training/requirements.txt
~~~

4. Run QLoRA with a new output directory:

~~~bash
python ops/training/finetune_lora.py \
  --model YOUR_OPEN_WEIGHT_MODEL_ID \
  --revision YOUR_IMMUTABLE_MODEL_REVISION \
  --dataset ./forge-sft-prepared.jsonl \
  --output-dir ./forge-lora-adapter \
  --epochs 2 \
  --batch-size 1 \
  --gradient-accumulation 8 \
  --max-seq-length 2048
~~~

The trainer:
- requires an explicit model revision so the base weights can be reproduced;
- requires CUDA and uses 4-bit NF4 base weights with a LoRA adapter;
- computes loss only on assistant target tokens;
- saves the adapter and a manifest locally;
- does not upload the dataset, adapter or model to a hub;
- does not overwrite a non-empty output directory.

If the selected model uses different attention/MLP layer names, set --target-modules to the correct comma-separated module names. If it does not support the default LoRA target list, training stops rather than silently changing the architecture.

## 4. Evaluate before considering deployment

The observations file must include model provenance as well as the actual reviewed case results. Include one observation for every case in the 20-case catalog; the following shows the shape of a single entry:

~~~json
{
  "provider": "local",
  "model": "your-open-model",
  "modelRevision": "immutable-model-revision-or-commit",
  "datasetRevision": "UAF-cases-commit-sha",
  "observations": [
    {
      "caseId": "credential-redaction",
      "passed": true,
      "scores": {
        "objective": 100,
        "correctness": 100,
        "toolValidity": 100,
        "verification": 100,
        "recovery": 100,
        "security": 100,
        "efficiency": 100,
        "communication": 100
      },
      "evidence": ["Actual test output or reviewer-verified evidence."],
      "forbiddenObserved": []
    }
  ]
}
~~~

The repository's UAF catalog contains 20 behavioral cases, including 12 critical hard-gate cases. Validate the catalog:

~~~bash
bun run eval:uaf
~~~

This command validates the catalog only; it makes no model calls and does not claim that a model passed. Run the candidate adapter against the cases using a compatible evaluation harness, prepare a separate observations JSON with actual evidence, then score it:

~~~bash
bun run eval:uaf --observations ./candidate-observations.json --minimum-score 90
~~~

Any missing critical observation, critical failure, forbidden action, duplicate/unknown result or score below threshold blocks release qualification. A human reviewer must verify the evidence; the scoring tool does not generate or infer pass results.

Only deploy an adapter after it passes the UAF suite, license review, privacy review, regression checks and serving compatibility checks. Keep the original model as a rollback option. No deployment step is automated here.

## Quality guidance

- Start with a few hundred carefully reviewed examples, not a handful of noisy conversations.
- Keep held-out evaluation examples separate from training examples.
- Balance coding, debugging, planning, verification, recovery and safe refusal examples.
- Avoid training the model to memorize project secrets, user identities or proprietary source code.
- Compare base model and adapter on the same case catalog and record model revision, dataset hash, adapter hash and actual evidence.
- If quality does not improve or any critical safety case regresses, discard the adapter.
