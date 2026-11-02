# Project sync worker

The server-only worker now supports one-step execution and bounded sequential batches. It claims only dependency-ready steps, renews fenced leases during execution, aborts on lease loss or caller cancellation, redacts provider errors, retries transient failures with backoff, and writes idempotent completion events.

## Not production-enabled yet

Provider-specific GitHub, Supabase and Vercel executors are not yet wired. The worker must not be exposed as a public endpoint. A trusted server-side caller must validate the exact plan/resource/commit approval before passing an allowlisted executor. External writes must be idempotent and verified by reading provider state back.

Remaining work: provider adapters, secured scheduler/trigger, per-user authorization and concurrency limits, history/cancellation UI, disposable internal database migration validation, and a security review. The internal ledger client is only for Forge's own database; never pass a connected customer database client to it.

## First provider executor (read-only)

A server-only allowlisted executor now supports `inspect_repository` for GitHub and `verify_database_binding` for Supabase. It reloads the run owner and task session from Forge's internal database, resolves only the GitHub credential selected for that session, and rejects an input fingerprint that does not match the current user/session/repository/branch/credential tuple. The GitHub adapter checks the branch head before and after reading the tree and refuses success if the branch moved during inspection. The Supabase adapter reads the status of the exact pinned project through the Supabase Management API; it does not run SQL or change project settings. Both adapters pass worker cancellation to provider requests and bind execution to the selected credential record.

All other operations return a terminal failed result until their own reviewed adapters are implemented. In particular, there is no customer Supabase migration, environment update, Auth change, Vercel deploy, branch write, or public worker trigger enabled by this executor. The run creator and secured trigger are still not wired into the product UI.

## Compute

Use GitHub-hosted Actions for CI and bounded tasks. A dedicated Oracle Cloud Always Free Ampere VM is the best candidate for a persistent CPU/network worker if home-region capacity is available. The existing `ops/free-cloud/oci-bootstrap.sh` only prepares Ubuntu; it does not deploy or enable a worker. Ordinary API-based coding does not need a GPU; temporary notebook GPUs are only for local model experiments.
