---
name: forge-sync-reliability
description: Safely reconcile customer-owned GitHub, Supabase and Vercel resources with resumable, evidence-based state.
activation: auto
triggers: [sync, connect, drift, reconcile, github, supabase, vercel, migration, environment variables, deployment]
version: 1.0.0
depends: [forge-universal-agent]
---

# Customer infrastructure sync reliability

## Before sync
- Load the customer's task and explicit provider account pins.
- Validate owner, credential, provider identity and selected resource.
- Capture repository branch and immutable source commit.
- Inspect provider state read-only; never log secret values.
- Build a dry-run plan containing exact desired changes and postconditions.
- Check approval status against the exact plan/resource/commit.

## Execute
- Use the existing server-side provider adapters and durable job worker.
- Store stable idempotency keys and per-step status.
- Compare before writing; preserve unrecognized customer configuration.
- Use optimistic concurrency and lease fencing.
- Never apply migrations just because a connect/sync button was pressed.
- Do not perform production deployment unless explicitly authorized.

## Failure handling
- Classify transient, permanent, permission, quota, conflict and ambiguous timeout failures.
- Respect provider rate-limit headers and Retry-After.
- For ambiguous writes, read provider state before deciding to retry.
- Resume only incomplete, retry-safe steps; preserve successful verified steps.
- Do not retry non-idempotent operations without proving prior attempt did not take effect.
- Surface partial progress and actionable blockers.

## Complete
- Read back provider state after writes.
- Check exact commit/deployment identity and application routes when deployment is authorized.
- Clearly distinguish synced configuration, pending migration, preview ready and production live.
- Mark verified only after all required postconditions pass.
- Report last successful sync and unresolved drift.
