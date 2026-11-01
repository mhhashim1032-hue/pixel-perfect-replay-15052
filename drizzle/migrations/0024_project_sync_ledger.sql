-- Durable, customer-scoped project synchronization ledger.
CREATE TABLE IF NOT EXISTS public.project_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.agent_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled')),
  mode text NOT NULL DEFAULT 'connect_existing' CHECK (mode IN ('connect_existing','create_new')),
  source_commit_sha text,
  account_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS project_sync_jobs_user_created_idx ON public.project_sync_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_sync_jobs_claim_idx ON public.project_sync_jobs(status, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS public.project_sync_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.project_sync_jobs(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.agent_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  operation text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','waiting_approval','succeeded','failed','skipped','cancelled')),
  depends_on text[] NOT NULL DEFAULT '{}',
  requires_approval boolean NOT NULL DEFAULT false,
  approved_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  safe_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_summary text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, operation)
);
CREATE INDEX IF NOT EXISTS project_sync_steps_job_idx ON public.project_sync_steps(job_id, created_at);
CREATE INDEX IF NOT EXISTS project_sync_steps_user_idx ON public.project_sync_steps(user_id, created_at DESC);

ALTER TABLE public.project_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_sync_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users read own project sync jobs" ON public.project_sync_jobs;
CREATE POLICY "users read own project sync jobs" ON public.project_sync_jobs
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.agent_sessions s WHERE s.id = task_id AND s.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "users read own project sync steps" ON public.project_sync_steps;
CREATE POLICY "users read own project sync steps" ON public.project_sync_steps
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.agent_sessions s WHERE s.id = task_id AND s.user_id = auth.uid()
    )
  );
REVOKE ALL ON public.project_sync_jobs FROM anon, authenticated;
REVOKE ALL ON public.project_sync_steps FROM anon, authenticated;
GRANT SELECT ON public.project_sync_jobs TO authenticated;
GRANT SELECT ON public.project_sync_steps TO authenticated;
GRANT ALL ON public.project_sync_jobs TO service_role;
GRANT ALL ON public.project_sync_steps TO service_role;
