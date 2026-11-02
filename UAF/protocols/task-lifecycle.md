# Forge task lifecycle protocol

## Task specification
Each substantial task has:
- stable task/run identity;
- normalized objective and domain;
- included/excluded scope and constraints;
- input and assumptions;
- deliverables and acceptance criteria;
- dependencies and resource/permission requirements;
- required skills/tools;
- risk classification;
- plan and verification plan.

Prefer the existing `task_specifications`, `agent_runs`, `agent_events`, `task_questions` and checkpoint system. Do not duplicate state in a separate database.

## Lifecycle
RECEIVED → DISCOVERING → PLANNING → (AWAITING_INPUT | AWAITING_APPROVAL | EXECUTING) → VERIFYING → (REPAIRING → EXECUTING/VERIFYING) → terminal state.

Use the existing database transition RPC as source of truth. The TypeScript lifecycle mirror must remain synchronized with SQL.

## Task sizing
- Small: inspect only the relevant area, execute directly and run targeted checks.
- Medium: short plan; delegate only genuinely independent work.
- Large: version a task specification, decompose into dependency waves, assign exclusive ownership and review integration.
- High risk: include explicit risk/rollback analysis, preserve approvals, independent security/QA review.

## Completion
All acceptance criteria have an evidence-backed status: passed, failed, blocked or not run. Do not equate "model response ended" with task completion.
