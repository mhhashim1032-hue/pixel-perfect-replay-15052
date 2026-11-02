\set ON_ERROR_STOP on

-- Minimal Supabase-compatible auth surface for a disposable PostgreSQL instance.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.agent_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id)
);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT EXECUTE ON FUNCTION auth.role() TO service_role;

INSERT INTO auth.users(id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002');
INSERT INTO public.agent_sessions(id, user_id) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');

\ir ../drizzle/migrations/0029_project_sync_ledger.sql

-- Exercise the real migration RPCs: idempotency, dependency gating, lease fencing,
-- step completion, and run finalization.
SELECT set_config('request.jwt.claim.role', 'service_role', false);
DO $verify_ledger$
DECLARE
  v_run uuid;
  v_duplicate uuid;
  v_step public.project_sync_steps%ROWTYPE;
  v_second public.project_sync_steps%ROWTYPE;
  v_no_step boolean;
BEGIN
  v_run := public.project_sync_create_run(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'sync-test-key-0001',
    'sync-test-plan-binding-0001',
    '[
      {"step_key":"first_step","operation":"inspect_repository","input_fingerprint":"fp-first","depends_on":[]},
      {"step_key":"second_step","operation":"verify_deployment_binding","input_fingerprint":"fp-second","depends_on":["first_step"]}
    ]'::jsonb
  );
  v_duplicate := public.project_sync_create_run(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'sync-test-key-0001',
    'sync-test-plan-binding-0001',
    '[
      {"step_key":"first_step","operation":"inspect_repository","input_fingerprint":"fp-first","depends_on":[]},
      {"step_key":"second_step","operation":"verify_deployment_binding","input_fingerprint":"fp-second","depends_on":["first_step"]}
    ]'::jsonb
  );
  IF v_run <> v_duplicate THEN RAISE EXCEPTION 'idempotent run creation returned a different run'; END IF;

  SELECT * INTO v_step FROM public.project_sync_claim_step(v_run, 90);
  IF NOT FOUND OR v_step.step_key <> 'first_step' THEN
    RAISE EXCEPTION 'worker did not claim the first dependency-ready step';
  END IF;
  IF public.project_sync_finish_step(v_step.id, gen_random_uuid(), 'succeeded') THEN
    RAISE EXCEPTION 'stale lease token unexpectedly finished a step';
  END IF;

  SELECT NOT EXISTS (SELECT 1 FROM public.project_sync_claim_step(v_run, 90)) INTO v_no_step;
  IF NOT v_no_step THEN RAISE EXCEPTION 'dependent step was claimed before its prerequisite completed'; END IF;

  IF NOT public.project_sync_finish_step(v_step.id, v_step.lease_token, 'succeeded', 'out-first', NULL, NULL) THEN
    RAISE EXCEPTION 'valid lease token failed to finish the first step';
  END IF;
  SELECT * INTO v_second FROM public.project_sync_claim_step(v_run, 90);
  IF NOT FOUND OR v_second.step_key <> 'second_step' THEN
    RAISE EXCEPTION 'dependent step did not become claimable after its prerequisite completed';
  END IF;
  IF NOT public.project_sync_finish_step(v_second.id, v_second.lease_token, 'succeeded', 'out-second', NULL, NULL) THEN
    RAISE EXCEPTION 'valid lease token failed to finish the second step';
  END IF;
  IF public.project_sync_finalize_run(v_run) <> 'succeeded' THEN
    RAISE EXCEPTION 'completed run did not finalize as succeeded';
  END IF;
END;
$verify_ledger$;

-- Verify owner-scoped RLS and ensure authenticated users cannot invoke worker RPCs.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
DO $verify_rls$
DECLARE visible_count integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
  SELECT count(*) INTO visible_count FROM public.project_sync_runs;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'owner should see exactly their own run, got %', visible_count; END IF;

  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
  SELECT count(*) INTO visible_count FROM public.project_sync_runs;
  IF visible_count <> 0 THEN RAISE EXCEPTION 'another user must not see this run, got % rows', visible_count; END IF;

  BEGIN
    PERFORM public.project_sync_claim_step(gen_random_uuid(), 90);
    RAISE EXCEPTION 'authenticated role unexpectedly invoked worker RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$verify_rls$;
ROLLBACK;

RESET ROLE;
