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
  CHECK ((state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
ALTER TABLE public.project_sync_steps
  ADD COLUMN IF NOT EXISTS depends_on text[] NOT NULL DEFAULT '{}';

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
  -- Exhausted retries and repeatedly expired leases become terminal failures.
  UPDATE public.project_sync_steps
    SET state = 'failed', lease_token = NULL, lease_expires_at = NULL,
        last_error = coalesce(last_error, 'Retry limit reached'), updated_at = now()
    WHERE run_id = _run AND attempt >= max_attempts
      AND (state = 'retryable' OR (state = 'leased' AND lease_expires_at <= now()));
  WITH candidate AS (
    SELECT s.id FROM public.project_sync_steps s
    WHERE s.run_id = _run AND s.attempt < s.max_attempts
      AND ((s.state IN ('queued','retryable') AND coalesce(s.next_retry_at, now()) <= now())
        OR (s.state = 'leased' AND s.lease_expires_at <= now()))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(s.depends_on) AS dependency(step_key)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.project_sync_steps prerequisite
          WHERE prerequisite.run_id = s.run_id
            AND prerequisite.step_key = dependency.step_key
            AND prerequisite.state IN ('succeeded','skipped')
        )
      )
    ORDER BY s.created_at, s.id
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
    SET state = CASE WHEN _state = 'retryable' AND attempt >= max_attempts THEN 'failed' ELSE _state END,
        output_fingerprint = _output_fingerprint,
        last_error = CASE WHEN _state = 'retryable' AND attempt >= max_attempts THEN coalesce(left(_safe_error, 500), 'Retry limit reached') ELSE left(_safe_error, 500) END,
        next_retry_at = CASE WHEN _state = 'retryable' AND attempt < max_attempts THEN _retry_at ELSE NULL END,
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

-- Create a run and its immutable step graph in one transaction. The session owner is
-- checked independently of the supplied user id; idempotent retries return the original run.
CREATE OR REPLACE FUNCTION public.project_sync_create_run(
  _user uuid, _session uuid, _idempotency_key text, _plan_binding text, _steps jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run_id uuid; existing_binding text; existing_session uuid; item jsonb; step_count integer;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF length(coalesce(_idempotency_key,'')) NOT BETWEEN 8 AND 200
    OR length(coalesce(_plan_binding,'')) NOT BETWEEN 8 AND 512
    OR jsonb_typeof(_steps) <> 'array' THEN
    RAISE EXCEPTION 'invalid sync run input' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO step_count FROM jsonb_array_elements(_steps);
  IF step_count < 1 OR step_count > 50 THEN
    RAISE EXCEPTION 'sync run must contain 1 to 50 steps' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agent_sessions WHERE id = _session AND user_id = _user) THEN
    RAISE EXCEPTION 'session owner mismatch' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.project_sync_runs(user_id, session_id, idempotency_key, plan_binding)
    VALUES (_user, _session, _idempotency_key, _plan_binding)
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_run_id;
  IF v_run_id IS NULL THEN
    SELECT id, plan_binding, session_id INTO v_run_id, existing_binding, existing_session
      FROM public.project_sync_runs WHERE user_id = _user AND idempotency_key = _idempotency_key;
    IF existing_binding <> _plan_binding OR existing_session <> _session THEN
      RAISE EXCEPTION 'idempotency key already belongs to a different plan' USING ERRCODE = '23505';
    END IF;
    RETURN v_run_id;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(_steps)
  LOOP
    IF coalesce(item->>'step_key','') = '' OR coalesce(item->>'operation','') = ''
      OR coalesce(item->>'input_fingerprint','') = '' THEN
      RAISE EXCEPTION 'each sync step requires key, operation and input fingerprint' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.project_sync_steps(
      run_id, step_key, operation, state, input_fingerprint, depends_on, approval_binding
    ) VALUES (
      v_run_id, item->>'step_key', item->>'operation',
      CASE WHEN item->>'state' = 'approval_required' THEN 'approval_required' ELSE 'queued' END,
      item->>'input_fingerprint',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'depends_on','[]'::jsonb))),
      item->>'approval_binding'
    );
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.project_sync_steps s
    CROSS JOIN LATERAL unnest(s.depends_on) AS dependency(step_key)
    WHERE s.run_id = v_run_id AND NOT EXISTS (
      SELECT 1 FROM public.project_sync_steps p WHERE p.run_id = s.run_id AND p.step_key = dependency.step_key
    )
  ) THEN
    RAISE EXCEPTION 'sync graph references an unknown prerequisite' USING ERRCODE = '22023';
  END IF;
  RETURN v_run_id;
END;
$$;

-- Lease renewal is compare-and-set; a worker that lost its lease cannot resurrect it.
CREATE OR REPLACE FUNCTION public.project_sync_renew_step(
  _step uuid, _lease_token uuid, _lease_seconds integer DEFAULT 90
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF _lease_seconds < 15 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease duration out of range' USING ERRCODE = '22023';
  END IF;
  UPDATE public.project_sync_steps SET lease_expires_at = now() + make_interval(secs => _lease_seconds), updated_at = now()
    WHERE id = _step AND state = 'leased' AND lease_token = _lease_token AND lease_expires_at > now();
  RETURN FOUND;
END;
$$;

-- Finalize only when no runnable/leased/approval-required steps remain.
CREATE OR REPLACE FUNCTION public.project_sync_finalize_run(_run uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_sync_steps WHERE run_id = _run AND state = 'leased')
    OR EXISTS (
      SELECT 1 FROM public.project_sync_steps s
      WHERE s.run_id = _run AND s.state IN ('queued','retryable')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(s.depends_on) dependency(step_key)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.project_sync_steps p
            WHERE p.run_id = s.run_id AND p.step_key = dependency.step_key
              AND p.state IN ('succeeded','skipped')
          )
        )
    ) THEN
    RETURN 'running';
  END IF;
  SELECT CASE
    WHEN bool_or(state = 'failed') THEN 'failed'
    WHEN bool_or(state = 'approval_required') THEN 'partial'
    WHEN bool_and(state IN ('succeeded','skipped','cancelled')) THEN
      CASE WHEN bool_or(state = 'cancelled') THEN 'cancelled' ELSE 'succeeded' END
    ELSE 'partial'
  END INTO result FROM public.project_sync_steps WHERE run_id = _run;
  UPDATE public.project_sync_runs SET status = result, updated_at = now(),
    finished_at = CASE WHEN result = 'running' THEN NULL ELSE now() END
    WHERE id = _run AND status IN ('queued','running','partial');
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.project_sync_create_run(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_sync_renew_step(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_sync_finalize_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_sync_create_run(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_sync_renew_step(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_sync_finalize_run(uuid) TO service_role;

-- Explicitly release an approval-gated step only when the caller supplies the exact
-- approval binding captured for that step. Approval is not inherited across steps.
CREATE OR REPLACE FUNCTION public.project_sync_approve_step(_step uuid, _approval_binding text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE affected_run uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF length(coalesce(_approval_binding,'')) < 8 OR length(_approval_binding) > 512 THEN
    RAISE EXCEPTION 'invalid approval binding' USING ERRCODE = '22023';
  END IF;
  UPDATE public.project_sync_steps
    SET state = 'queued', updated_at = now()
    WHERE id = _step AND state = 'approval_required' AND approval_binding = _approval_binding
    RETURNING run_id INTO affected_run;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.project_sync_runs SET status = 'queued', finished_at = NULL, updated_at = now()
    WHERE id = affected_run AND status = 'partial';
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.project_sync_approve_step(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_sync_approve_step(uuid, text) TO service_role;
