# Customer infrastructure synchronization protocol

## Ownership invariants
- The customer owns and supplies GitHub, Supabase and Vercel accounts/projects.
- Resolve credentials through the task's pinned account IDs and verify owner and resource identity before each provider operation.
- No operator/platform account, global credentials, latest-account fallback or cross-customer reuse.
- Forge's Lovable hosting and platform database are not customer deployment targets.

## Reconciliation model
Treat GitHub, Supabase and Vercel as independent external systems. There is no atomic transaction across them. Use a durable saga/step ledger and explicit postconditions.

Each sync operation records:
- job_id, step_id, owner_id, task_id;
- provider and pinned account/resource identity;
- operation name and deterministic idempotency key;
- desired-state hash and observed-state hash (non-secret);
- source commit SHA where relevant;
- attempt number, lease/execution fence;
- state: pending, running, succeeded, retryable_failed, blocked, approval_required, permanent_failed, cancelled;
- started/finished timestamps and safe error class/message;
- verification result and timestamp.

Never store plaintext credentials or secret values in this ledger.

## Execution sequence
1. Validate user/task ownership and pinned accounts.
2. Inspect GitHub repository, branch, tree and immutable commit SHA.
3. Inspect selected Supabase project identity and current migration history (read-only).
4. Inspect selected Vercel project identity, repository link, root directory, framework, build settings and env variable names/targets (never values).
5. Produce a dry-run diff of desired versus actual state.
6. Gate all writes by the existing autonomy and approval system.
7. Apply only safe, explicitly authorized and idempotent changes; preserve unrecognized settings.
8. For schema migrations, use approved migration workflow; never auto-apply merely because Sync was clicked.
9. For deployments, deploy the exact approved source commit to the pinned Vercel project.
10. Read back each changed provider state.
11. Verify exact deployment state and actual runtime route/health.
12. Mark verified only for checks that passed.

## Retry and consistency
- Use stable per-step idempotency keys where provider APIs support them.
- For APIs without idempotency support, compare current state and prove a previous attempt was not applied before retry.
- Use leases, execution fencing and optimistic concurrency to reject stale workers.
- Never blindly repeat repository creation, migrations, DNS/domain changes, environment writes or deployments after ambiguous timeouts.
- On partial success, preserve the successful ledger rows; resume only pending/retryable-safe steps.
- Webhooks must be signature-verified, replay-protected, deduplicated, ordered by provider timestamp/version where possible and treated as reconciliation triggers—not authorization to mutate.
- Periodically reconcile webhook events against authoritative provider state.
- Drift is a report plus proposed plan; do not silently overwrite customer edits.
- Use exponential backoff with jitter for rate limits/transient failures; respect Retry-After; bound retries and pause on quota/permission failures.
- A sync job must never report "all synced" while a required step is skipped, blocked, failed or unverified.

## Safety approvals
Approval is required for migrations, destructive changes, production environment writes, domain/DNS changes, resource creation/relinking, permission expansion and production deployment according to current project policy. Approval must be bound to exact target resource, operation, commit and plan version; stale plans require reapproval.

## Reporting
Show provider, selected resource (safe identifier), source SHA, each step state, retryability, evidence and blockers. Do not claim "zero errors". Say "verified in sync at [time]" only for actual verified postconditions.
