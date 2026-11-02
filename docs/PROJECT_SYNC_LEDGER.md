# Project sync ledger

The `0029_project_sync_ledger.sql` migration adds durable coordination primitives to
Forge's **internal application database**. It does not target, connect to, or modify a
customer's Supabase database.

## Guarantees represented by the schema

- A unique `(user_id, idempotency_key)` prevents duplicate run creation on retried requests.
- A unique `(run_id, step_key)` prevents duplicate step rows inside one run.
- Step claims use `FOR UPDATE SKIP LOCKED`, bounded leases, and fresh UUID fencing tokens.
- Claims are dependency-aware: a step is eligible only after all prerequisites are
  `succeeded` or `skipped`.
- Lease renewal and completion compare the current fencing token. A stale worker cannot
  renew or overwrite a replacement worker's result.
- Retry exhaustion and expired final attempts become terminal failures instead of stuck runs.
- Event insertion is deduplicated by `(run_id, idempotency_key)`.
- Approval-gated steps are released only with their exact stored approval binding.
- Authenticated users can read only runs belonging to themselves and their child rows.
  Mutations and worker RPCs are restricted to `service_role`.

## Server adapter

`src/lib/project-sync-ledger.server.ts` provides a typed server-only adapter for the
internal service-role client. It validates step graphs before persistence, rejecting
duplicate keys, missing prerequisites, self-dependencies, cycles, and invalid fingerprints.
It exposes run creation, step claim/renew/finish, event append, exact approval release,
and run finalization.

**Never pass a customer's Supabase client to this adapter.** Its service-role client must
be constructed only for Forge's own application database on the server. Do not expose
service-role credentials to the browser.

## Internal credential isolation

`src/lib/internal-ledger-client.server.ts` is the only approved factory for the worker's
internal ledger admin client. It requires the dedicated
`FORGE_INTERNAL_SUPABASE_URL` and `FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY`
variables. It intentionally does not fall back to generic `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, browser publishable keys, or any credentials stored for a
customer's connected project. It rejects non-HTTPS remote endpoints and anon JWTs.

The worker must remain disabled until both dedicated variables point to Forge's own
internal database and migration 0029 has been reviewed and applied there. This change
does not configure those secrets or enable a worker automatically.

## RPC contracts

- `project_sync_create_run(...)`: atomically creates an idempotent run and immutable step graph.
- `project_sync_claim_step(run_id, lease_seconds)`: atomically claims one dependency-ready
  step, increments its attempt counter, and returns its fencing token.
- `project_sync_renew_step(step_id, lease_token, lease_seconds)`: extends only a current,
  unexpired lease.
- `project_sync_finish_step(step_id, lease_token, state, ...)`: compare-and-set completion;
  returns false when the lease token is stale.
- `project_sync_approve_step(step_id, approval_binding)`: releases one approval-gated step
  only when the exact stored binding matches.
- `project_sync_append_event(run_id, idempotency_key, event_type, payload)`: appends once.
- `project_sync_finalize_run(run_id)`: calculates the durable run outcome.

## Integration status and safety boundary

The ledger and its typed adapter are committed, but **the application does not yet launch
background sync workers from Connect or Auto-fix**. Those existing paths remain read-only.
The next integration step is to construct the internal admin client safely, create runs
from an approved plan, run a worker loop with lease renewal and bounded retries, perform
provider read-back verification, and expose user-visible run/step history.

Customer migration, environment, auth, domain, and deployment operations remain separate
explicit approvals bound to the current customer resource, commit, and plan. Do not call
these RPCs with customer credentials or automatically apply this migration to customer
Supabase.

No migration has been applied to any database by this change.
