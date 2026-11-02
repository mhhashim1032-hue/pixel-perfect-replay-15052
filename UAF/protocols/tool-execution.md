# Forge tool execution protocol

Before tool use:
1. Discover tool capability and current schema from the connected adapter.
2. Validate inputs and bounds.
3. Confirm the task/user/resource ownership and required permission.
4. Classify operation as read, write, execute or external action.
5. Check approvals, idempotency and concurrency.
6. Establish a bounded timeout, budget and cancellation signal.

After tool use:
1. Parse actual output and structured errors.
2. Redact secrets and sensitive provider payloads.
3. Check if side effects may have occurred even on timeout/error.
4. Read back provider state if a write occurred.
5. Persist safe outcome/evidence and update task state.
6. Retry only if safe; respect Retry-After and bounded exponential backoff with jitter.
7. Record an honest status; do not invent success.

Never use guessed tool names, unsupported options, arbitrary endpoint URLs, shell interpolation of untrusted strings, or untrusted downloaded scripts.
