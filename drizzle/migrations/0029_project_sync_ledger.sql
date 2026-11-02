-- Internal Forge control-plane ledger. This is Forge's own application database,
-- never a customer-owned Supabase project. Customer resources remain read-only until
-- an exact, separately approved operation is executed.
CREATE TABLE IF NOT EXISTS public.project_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.agent_sessions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  plan_binding text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS project_sync_runs_session_created
  ON public.project_sync_runs(user_id, session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.project_sync_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.project_sync_runs(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  operation text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','leased','succeeded','skipped','approval_required','retryable','failed','cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  approval_binding text,
  input_fingerprint text NOT NULL,
  output_fingerprint text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS project_sync_steps_claim
  ON public.project_sync_steps(state, next_retry_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS public.project_sync_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.project_sync_runs(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS project_sync_events_run_created
  ON public.project_sync_events(run_id, created_at);

ALTER TABLE public.project_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_sync_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_sync_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS own_project_sync_runs_read ON public.project_sync_runs;
CREATE POLICY own_project_sync_runs_read ON public.project_sync_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS own_project_sync_steps_read ON public.project_sync_steps;
CREATE POLICY own_project_sync_steps_read ON public.project_sync_steps
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.project_sync_runs r
      WHERE r.id = run_id AND r.user_id = auth.uid())
  );
DROP POLICY IF EXISTS own_project_sync_events_read ON public.project_sync_events;
CREATE POLICY own_project_sync_events_read ON public.project_sync_events
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.project_sync_runs r
      WHERE r.id = run_id AND r.user_id = auth.uid())
  );

REVOKE ALL ON public.project_sync_runs, public.project_sync_steps, public.project_sync_events FROM anon, authenticated;
GRANT SELECT ON public.project_sync_runs, public.project_sync_steps, public.project_sync_events TO authenticated;
GRANT ALL ON public.project_sync_runs, public.project_sync_steps, public.project_sync_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.project_sync_events_id_seq TO service_role;

COMMENT ON TABLE public.project_sync_runs IS 'Durable, idempotent project sync runs in Forge internal DB; not customer Supabase.';
COMMENT ON TABLE public.project_sync_steps IS 'Per-operation sync ledger with leases and fencing tokens for safe retries.';
COMMENT ON TABLE public.project_sync_events IS 'Deduplicated append-only sync event journal.';
