-- Lease-fenced mutations: stale workers cannot renew or complete another worker's job.
CREATE OR REPLACE FUNCTION public.renew_project_sync_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 90
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE changed integer;
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) < 8 OR length(p_worker_id) > 160 THEN
    RAISE EXCEPTION 'invalid worker id';
  END IF;
  IF p_lease_seconds < 15 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid lease duration';
  END IF;

  UPDATE public.project_sync_jobs
  SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  WHERE id = p_job_id
    AND status = 'running'
    AND lease_owner = p_worker_id
    AND lease_expires_at > now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_project_sync_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_summary jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE changed integer;
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) < 8 OR length(p_worker_id) > 160 THEN
    RAISE EXCEPTION 'invalid worker id';
  END IF;
  IF p_status NOT IN ('succeeded','failed','waiting_approval','cancelled') THEN
    RAISE EXCEPTION 'invalid terminal job status';
  END IF;
  IF p_summary IS NULL OR pg_column_size(p_summary) > 16384 THEN
    RAISE EXCEPTION 'invalid job summary';
  END IF;

  UPDATE public.project_sync_jobs
  SET status = p_status,
      summary = p_summary,
      lease_owner = NULL,
      lease_expires_at = NULL,
      finished_at = CASE WHEN p_status IN ('succeeded','failed','cancelled') THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_job_id
    AND status = 'running'
    AND lease_owner = p_worker_id
    AND lease_expires_at > now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_project_sync_job_lease(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_project_sync_job(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_project_sync_job_lease(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_project_sync_job(uuid, text, text, jsonb) TO service_role;
