# Recovery and memory protocol

## Recovery
- Treat timeout as ambiguous for side-effecting actions.
- Re-read provider state and execution ledger before retry.
- Use existing execution_id/lease fencing and branch write queue.
- Retry safe transient reads with bounded backoff.
- Retry writes only with idempotency or proof no previous effect occurred.
- Preserve successful steps across job resume.
- Stop after the configured attempts/budget; present actionable blocker.

## Checkpoint
Persist task objective, specification version, plan, completed steps, current step, provider/resource pins (IDs only), last verified state, source commit, outstanding approvals, blockers and next safe action.
Never put secrets or unredacted tool output in checkpoints.

## Memory
Use current existing project memory and local ranking. Future semantic/vector retrieval is optional and must work without platform-owned inference credentials. Scope memory by owner and repository/project. Validate provenance and recency before reuse. Avoid storing credentials, secrets, sensitive personal data and raw private source documents unless explicitly required and securely scoped.
