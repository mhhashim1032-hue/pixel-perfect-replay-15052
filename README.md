# Forge — open-source, bring-your-own-key AI coding agent

Forge is a browser-based coding agent. Each user brings their own AI provider key, connects GitHub, and delegates tasks to an agent that reads, searches and edits real repository files on its own branch.

## Features

- **BYOK providers:** OpenAI, Anthropic, Google Gemini, OpenRouter, any OpenAI-compatible endpoint (incl. Ollama). Keys are validated with the provider, AES-GCM encrypted at rest, and only ever decrypted on the server.
- **GitHub:** personal access token (`repo` scope). Each task gets a fresh `agent/<id>` branch; the base branch is never modified.
- **Agent tools:** `list_files`, `read_file`, `search_files`, `write_file`, `delete_file`, with streaming progress.
- **Modes:** *Supervised* stages every edit for approval with a diff; *Autonomous* commits as it works.
- **Checkpoints:** every agent commit is a checkpoint; rewind the task branch to any of them or undo everything.
- **Editor:** view and edit files in the browser, committing to the task branch.
- **Skills & project instructions:** reusable instructions per user, plus `AGENTS.md` / `CLAUDE.md` from the repo.
- **Pull requests:** open a PR from the task branch in one click.

- **External MCP tools:** connect public or bearer-token Streamable HTTP or SSE endpoints in Settings. Tokens are encrypted; tools are available through deferred discovery/invocation. Read-only calls execute directly. Opt in to action requests to expose other tools: every external action requires separate approval in the task's Changes tab, even in autonomous mode. Approval uses the saved exact arguments, expires after 30 minutes and executes at most once. Results are saved and supplied on the next agent turn. DeepWiki's official endpoint is included as a preset. Trust only servers you control or recognize: tool annotations are not a security guarantee.

- **External service sign-in:** OAuth with PKCE, encrypted tokens and registration data, automatic SDK refresh and explicit reconnect. Notion's official endpoint is a preset. Callback completion requires the active Forge account and the browser that started sign-in; flows expire after 10 minutes and can complete only once. HTTPS services advertising client metadata documents use the public `/api/public/oauth-client` document; others use dynamic registration. Local HTTP development uses dynamic registration. Servers supporting neither require their own pre-registration and are not supported by this flow.

Not yet available: sandboxed terminal / test execution and local stdio transport (requires a local execution bridge). See `roadmap.md`.

OAuth checks: real Notion client registration, authorization URL/PKCE/state, cancellation and disconnect were verified. Successful Notion account consent, post-consent tool access, refresh and hosted HTTPS client metadata acceptance still require an external account and a published check; they are not claimed as end-to-end verified.

## Stack

TanStack Start (React 19, Vite, TypeScript), Tailwind CSS v4, shadcn/ui, Vercel AI SDK, Supabase (Auth + Postgres with Row Level Security). Runs on Cloudflare Workers or any Node 20+ host.

## Self-hosting

1. Install: `bun install` (Node 20 LTS or newer also works).
2. Create a Supabase project and apply the SQL files in `drizzle/migrations/` in order.
3. Set environment variables:
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (server)
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (browser)
   - `KEY_ENCRYPTION_SECRET` — a random string of 64+ characters. Losing it makes saved keys unreadable; rotating it requires users to re-enter keys.
4. Run `bun run dev`, or `bun run build` and deploy.

No platform AI key is required: all inference uses the user's own credentials.

## Security notes

- Keys never reach the browser after saving; only the last 4 characters are shown.
- All tables use RLS scoped to `auth.uid()`.
- Repository file contents are treated as data; the system prompt tells the model to ignore instructions found inside them.
- Checkpoint restore only accepts commits that belong to the task branch.

## License

MIT — see `LICENSE`.

## Forge Universal Agent Foundation

The working agent is named **Forge** and follows the model-independent operating specification in [UAF](UAF/README.md). The constitution, task/tool/recovery protocols, customer infrastructure sync contract, portable schemas, evaluation cases and audited built-in skills live in the repository.

UAF augments the existing engine rather than replacing provider adapters, the task lifecycle, skill/memory systems, MCP, sandbox, or control plane. Customer GitHub, Supabase and Vercel remain customer-owned BYO infrastructure; Forge does not silently create, replace or migrate those resources. See [the adoption plan](docs/ADOPT_UAF_IN_FORGE.md).

The synchronization target is **recoverable and verifiable**, not a claim of zero provider failures: durable per-step state, pinned ownership, idempotency, bounded retries, read-back verification, and safe resume after partial failure.
