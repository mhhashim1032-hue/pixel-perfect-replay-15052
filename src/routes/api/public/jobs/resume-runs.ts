import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { agentOrigin } from "@/lib/background-run";

export const Route = createFileRoute("/api/public/jobs/resume-runs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const origin = agentOrigin(request) ?? new URL(request.url).origin;
        const { resumeStaleRuns } = await import("@/lib/run-resume.server");
        const recovery = await resumeStaleRuns(origin);

        let projectSync: Record<string, unknown> = { enabled: false, reason: "Internal ledger credentials are not configured." };
        if (process.env["FORGE_INTERNAL_SUPABASE_URL"] && process.env["FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY"]) {
          try {
            const [{ getInternalLedgerAdmin }, { dispatchOnePendingProjectSyncRun }] = await Promise.all([
              import("@/lib/internal-ledger-client.server"),
              import("@/lib/project-sync-dispatcher.server"),
            ]);
            projectSync = await dispatchOnePendingProjectSyncRun(getInternalLedgerAdmin());
          } catch {
            // Do not fail stale-run recovery if the optional ledger is not migrated or available.
            projectSync = { enabled: true, processed: false, reason: "Project sync queue is temporarily unavailable." };
          }
        }
        return Response.json({ ...recovery, projectSync });
      },
    },
  },
});
