-- Atomic, service-only claim primitive for durable project sync jobs.
-- SKIP LOCKED prevents two workers from claiming the same queued/expired job.
CREATE OR REPLACE FUNCTION public.claim_project_sync_job(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 90
)
RETURNS SETOF public.project_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) < 8 OR length(p_worker_id) > 160 THEN
    RAISE EXCEPTION 'invalid worker id';
  END IF;
  IF p_lease_seconds < 15 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid lease duration';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT id
    FROM public.project_sync_jobs
    WHERE attempt < 8
      AND (
        status = 'queued'
        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.project_sync_jobs AS job
  SET status = 'running',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt = job.attempt + 1,
      started_at = COALESCE(job.started_at, now()),
      updated_at = now()
  FROM candidate
  WHERE job.id = candidate.id
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_project_sync_job(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_project_sync_job(text, integer) TO service_role;
