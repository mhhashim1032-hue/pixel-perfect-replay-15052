# Forge Universal Agent Foundation (UAF)

UAF is Forge's model-independent operating framework. Forge remains the working agent name and the product's UX identity.

## Goals
- General-purpose task execution across coding, research, operations, documents, data and business workflows.
- Provider-independent model interface: provider-specific capabilities are detected, never assumed.
- Execution based on observed results, durable task state, resumability and evidence-based verification.
- Customer-owned GitHub, Supabase and Vercel remain external resources owned and controlled by each customer.

## Core invariants
1. **Forge hosting is not customer infrastructure.** This repository's existing Lovable-hosted Forge platform, its own Supabase project, CI and deployments are not modified by customer project operations.
2. **BYO resources only.** Provider actions use the task's owner-scoped, pinned GitHub/Supabase/Vercel account and resource IDs. No operator, platform or cross-customer fallback.
3. **No silent production changes.** Migrations, destructive operations, environment writes, domain/permission changes and production deploys remain governed by existing approval and autonomy controls.
4. **Durable and honest sync.** Every external step must have a stable identity, idempotency strategy, observable result and verified postcondition. Partial failure is visible and resumable; no claim of guaranteed zero errors.
5. **No secrets in client, repository, model-visible tool results, logs or memory.** Use existing encrypted server-side credential storage and redaction.
6. **Evidence before completion.** A model response or a successful API request is not sufficient proof that the requested result is live and working.

## Structure
- `constitution.md`: permanent operating principles.
- `protocols/`: task, tool, sync, recovery and verification contracts.
- `skills/`: original Forge skill definitions.
- `schemas/`: portable JSON schemas.
- `evaluations/`: model-agnostic behavioral test cases and scoring.

## Integration strategy
UAF augments the current Forge engine; it does not replace the Vercel AI SDK, provider adapters, MCP, engine lifecycle, E2B sandbox, BYOK credential system, Supabase schema, or customer control-plane. Existing engine modules remain authoritative for their respective lifecycle, authorization and execution contracts.

## Rollout
Read `docs/ADOPT_UAF_IN_FORGE.md` for the staged implementation plan and explicitly protected infrastructure boundaries.
