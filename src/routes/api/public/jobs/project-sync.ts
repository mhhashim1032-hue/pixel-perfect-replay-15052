import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

export const Route = createFileRoute("/api/public/jobs/project-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { runProjectSyncWorker } = await import("@/lib/project-sync-worker.server");
        const result = await runProjectSyncWorker();
        return Response.json(result);
      },
    },
  },
});
