# Project sync worker

The server-only worker now supports one-step execution and bounded sequential batches. It claims only dependency-ready steps, renews fenced leases during execution, aborts on lease loss or caller cancellation, redacts provider errors, retries transient failures with backoff, and writes idempotent completion events.

## Not production-enabled yet

Provider-specific GitHub, Supabase and Vercel executors are not yet wired. The worker must not be exposed as a public endpoint. A trusted server-side caller must validate the exact plan/resource/commit approval before passing an allowlisted executor. External writes must be idempotent and verified by reading provider state back.

Remaining work: provider adapters, secured scheduler/trigger, per-user authorization and concurrency limits, history/cancellation UI, disposable internal database migration validation, and a security review. The internal ledger client is only for Forge's own database; never pass a connected customer database client to it.

## Compute

Use GitHub-hosted Actions for CI and bounded tasks. A dedicated Oracle Cloud Always Free Ampere VM is the best candidate for a persistent CPU/network worker if home-region capacity is available. The existing `ops/free-cloud/oci-bootstrap.sh` only prepares Ubuntu; it does not deploy or enable a worker. Ordinary API-based coding does not need a GPU; temporary notebook GPUs are only for local model experiments.
