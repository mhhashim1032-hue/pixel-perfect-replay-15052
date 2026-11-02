# Project sync ledger

The `0029_project_sync_ledger.sql` migration adds durable coordination primitives to
Forge's **internal application database**. It does not target, connect to, or modify a
customer's Supabase database.

## Guarantees represented by the schema

- A unique `(user_id, idempotency_key)` prevents duplicate run creation on retried requests.
- A unique `(run_id, step_key)` prevents duplicate step rows inside one run.
- Step claims use `FOR UPDATE SKIP LOCKED`, a bounded lease, and a fresh UUID fencing token.
- Finishing a step requires the current lease token. A stale worker cannot overwrite a
  result after its lease has expired and another worker has reclaimed the step.
- Event insertion is deduplicated by `(run_id, idempotency_key)`.
- Authenticated users can read only runs belonging to themselves and their child rows.
  Mutations and worker RPCs are restricted to `service_role`.

## RPC contracts

- `project_sync_claim_step(run_id, lease_seconds)`: atomically claims one eligible step,
  increments its attempt counter, and returns the new lease token.
- `project_sync_finish_step(step_id, lease_token, state, ...)`: compare-and-set completion;
  returns false when the lease token is stale.
- `project_sync_append_event(run_id, idempotency_key, event_type, payload)`: appends once.

## Integration status and safety boundary

This migration is the durable storage/coordination foundation, **not yet a live sync
worker**. The existing Connect and Auto-fix paths remain read-only. Do not call these RPCs
from customer credentials or automatically apply this migration to customer Supabase.
The next implementation step is to wire run creation, dependency-aware step materialization,
worker lease renewal, retries, and read-back verification into Forge's internal service
layer, then expose user-visible run/step history. Exact customer migration/deployment
approvals must remain separately bound to the current resource, commit, and plan.

No migration has been applied to any database by this change.
