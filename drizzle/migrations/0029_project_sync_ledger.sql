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

-- Atomic worker claim: SKIP LOCKED prevents two workers from claiming the same step.
-- A fresh lease token fences out late results from an expired/replaced worker.
CREATE OR REPLACE FUNCTION public.project_sync_claim_step(_run uuid, _lease_seconds integer DEFAULT 90)
RETURNS SETOF public.project_sync_steps
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed public.project_sync_steps;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF _lease_seconds < 15 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease duration out of range' USING ERRCODE = '22023';
  END IF;
  UPDATE public.project_sync_runs SET status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
    WHERE id = _run AND status IN ('queued','running');
  IF NOT FOUND THEN RETURN; END IF;
  WITH candidate AS (
    SELECT id FROM public.project_sync_steps
    WHERE run_id = _run AND attempt < max_attempts
      AND ((state IN ('queued','retryable') AND coalesce(next_retry_at, now()) <= now())
        OR (state = 'leased' AND lease_expires_at <= now()))
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.project_sync_steps s
    SET state = 'leased', attempt = s.attempt + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => _lease_seconds),
        next_retry_at = NULL, updated_at = now()
    FROM candidate c WHERE s.id = c.id
    RETURNING s.* INTO claimed;
  IF FOUND THEN RETURN NEXT claimed; END IF;
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_sync_finish_step(
  _step uuid, _lease_token uuid, _state text,
  _output_fingerprint text DEFAULT NULL, _safe_error text DEFAULT NULL,
  _retry_at timestamptz DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF _state NOT IN ('succeeded','skipped','retryable','failed','cancelled') THEN
    RAISE EXCEPTION 'invalid terminal step state' USING ERRCODE = '22023';
  END IF;
  UPDATE public.project_sync_steps
    SET state = _state, output_fingerprint = _output_fingerprint,
        last_error = left(_safe_error, 500), next_retry_at = CASE WHEN _state = 'retryable' THEN _retry_at ELSE NULL END,
        lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = _step AND state = 'leased' AND lease_token = _lease_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_sync_append_event(
  _run uuid, _idempotency_key text, _event_type text, _payload jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.project_sync_events(run_id, idempotency_key, event_type, payload)
    SELECT _run, _idempotency_key, _event_type, coalesce(_payload, '{}'::jsonb)
    WHERE EXISTS (SELECT 1 FROM public.project_sync_runs WHERE id = _run)
    ON CONFLICT (run_id, idempotency_key) DO NOTHING;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.project_sync_claim_step(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_sync_finish_step(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_sync_append_event(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_sync_claim_step(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_sync_finish_step(uuid, uuid, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_sync_append_event(uuid, text, text, jsonb) TO service_role;
