# Adopt UAF in Forge — implementation plan

## Current architecture to preserve
Forge already has provider BYOK, encrypted credentials, task-pinned accounts, model capability registry, adaptive reasoning, task discovery/specification, skill library/import audit, multi-agent teams, run lifecycle/events, checkpoint resume, project memories, MCP approvals, sandbox isolation, Vercel deployment checks and a durable customer sync worker with leases/fencing.

UAF is an operating standard applied across those existing modules. It is not a second agent runtime, model framework, database, or credential store.

## Explicitly protected infrastructure
- Keep Forge hosted on Lovable.
- Do not replace the platform Supabase project or schema ownership.
- Do not change Lovable/Vercel production configuration, domains, deployment settings or DNS.
- Do not provision or migrate any customer's Supabase project.
- Do not create, relink, or deploy customer GitHub/Vercel/Supabase resources.
- Customer resources remain BYO and are resolved only through their own task-pinned connections.

## Phase 1 — UAF foundation (this change)
Add portable constitution, task/tool/sync/recovery/evaluation protocols, skill specification, schemas and conformance fixtures. No runtime/provider writes.

## Phase 2 — Wire standards into current engine
Review and incrementally align:
- `src/lib/engine/discovery.ts`: task specification completeness and risk classification.
- `src/lib/engine/reasoning.ts`: model capabilities and task-sized budgets.
- `src/lib/engine/lifecycle.ts` and `recorder.server.ts`: stage and evidence reporting.
- `src/lib/agent-skills.ts` and `free-skills.ts`: progressive skill loading and trust.
- `src/lib/engine/checkpoint.ts` and memory modules: resumability without secrets.
Do not duplicate existing functionality.

## Phase 3 — Durable customer sync reconciliation
Audit existing migrations 0015 onward, sync job/step tables, claim/renew/complete RPCs, worker and Connect path. Extend in additive migrations only after proving current schema and state. Requirements:
- stable per-step idempotency identity;
- owner/task/account/resource pins on every job;
- immutable desired plan version and commit SHA;
- lease and execution fencing;
- per-step attempt, safe error and postcondition evidence;
- webhook inbox with signature verification, dedupe, replay protection and event ordering;
- drift detection and compare-before-write;
- resumable partial failures;
- approval bound to exact operation/resource/commit/plan hash.
No external provider operation may run until identity and approval checks pass.

## Phase 4 — Verification and reliability
Add fixture-based tests for duplicate webhooks, partial failures, stale approvals, lease takeover, rate limits, non-idempotent timeouts, cross-account protection and drift. Verify each provider postcondition. Never promise zero error rate.

## Phase 5 — UX and operational visibility
Show task state, selected customer resources, sync status, last verified time, stale/drift warnings, retries, approvals and clear blockers. Make simple tasks simple; advanced reconciliation details remain inspectable.

## Rollout rule
Each phase must be a separate PR with typecheck, lint, unit tests and build. No PR is merged automatically. Never modify protected infrastructure to make a test pass.
