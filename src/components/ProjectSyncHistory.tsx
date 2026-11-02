import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, Play, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { getProjectSyncHistory, startProjectSyncInspection } from "@/lib/connect.functions";
import { Button } from "@/components/ui/button";

type SyncState = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
type HistoryStep = {
  id: string;
  key: string;
  operation: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
type HistoryRun = {
  id: string;
  status: SyncState | string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: HistoryStep[];
  events: { id: number; type: string; createdAt: string; payload: Record<string, string | number | null> }[];
};

const ACTIVE = new Set(["queued", "running"]);
const STATE_LABEL: Record<string, string> = {
  queued: "Queued", running: "Running", succeeded: "Completed",
  partial: "Waiting for approval", failed: "Failed", cancelled: "Cancelled",
  leased: "Working", retryable: "Retry scheduled", approval_required: "Approval required",
  skipped: "Skipped",
};
const STATE_ICON: Record<string, typeof CheckCircle2> = {
  succeeded: CheckCircle2, failed: XCircle, cancelled: XCircle,
  partial: AlertTriangle, approval_required: AlertTriangle, retryable: Clock3,
  queued: Clock3, running: Loader2, leased: Loader2,
};

function stamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export function ProjectSyncHistory({ id }: { id: string }) {
  const qc = useQueryClient();
  const getHistory = useServerFn(getProjectSyncHistory);
  const startInspection = useServerFn(startProjectSyncInspection);
  const history = useQuery({
    queryKey: ["project-sync-history", id],
    queryFn: () => getHistory({ data: { id, page: 0 } }),
    refetchInterval: (query) => query.state.data?.runs?.some((run: HistoryRun) => ACTIVE.has(run.status)) ? 3000 : false,
    retry: false,
  });
  const start = useMutation({
    mutationFn: (requestId: string) => startInspection({ data: { id, requestId } }),
    onSuccess: async () => {
      toast.success("Read-only inspection queued");
      await qc.invalidateQueries({ queryKey: ["project-sync-history", id] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not start inspection"),
  });
  const runs = (history.data?.runs ?? []) as HistoryRun[];
  const active = runs.some((run) => ACTIVE.has(run.status));

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">Background sync history</h3>
          <p className="text-xs text-muted-foreground">
            Read-only checks of your pinned GitHub, Supabase and Vercel resources. No customer settings or data are changed.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void history.refetch()}
            disabled={history.isFetching}
            aria-label="Refresh sync history"
          >
            {history.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          <Button
            size="sm"
            onClick={() => start.mutate(crypto.randomUUID())}
            disabled={start.isPending || active}
          >
            {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Inspect
          </Button>
        </div>
      </div>

      {history.isLoading && <p className="text-xs text-muted-foreground">Loading inspection history…</p>}
      {history.isError && (
        <p role="alert" className="text-xs text-destructive">
          {(history.error as Error).message || "Could not load sync history. Check that the internal ledger migration is installed."}
        </p>
      )}
      {!history.isLoading && !history.isError && runs.length === 0 && (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          No inspection runs yet. Select and pin a GitHub account to this task, then choose Inspect.
        </p>
      )}

      <div className="space-y-3">
        {runs.map((run) => {
          const Icon = STATE_ICON[run.status] ?? Clock3;
          return (
            <article key={run.id} className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Icon className={"h-4 w-4 shrink-0 " + (run.status === "running" ? "animate-spin" : "")} />
                <span className="text-sm font-medium">{STATE_LABEL[run.status] ?? run.status}</span>
                <span className="ml-auto text-xs text-muted-foreground">{stamp(run.createdAt)}</span>
              </div>
              <div className="space-y-2">
                {run.steps.map((step) => {
                  const StepIcon = STATE_ICON[step.state] ?? Clock3;
                  return (
                    <div key={step.id} className="flex items-start gap-2 text-xs">
                      <StepIcon className={"mt-0.5 h-3.5 w-3.5 shrink-0 " + (step.state === "leased" ? "animate-spin" : "")} />
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-medium">{step.operation.replaceAll("_", " ")}</p>
                        <p className="text-muted-foreground">
                          {STATE_LABEL[step.state] ?? step.state} · attempt {step.attempt}/{step.maxAttempts}
                          {step.nextRetryAt ? " · retry after " + stamp(step.nextRetryAt) : ""}
                        </p>
                        {step.error && <p className="mt-1 break-words text-destructive">{step.error}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {run.finishedAt ? "Finished " + stamp(run.finishedAt) : run.startedAt ? "Started " + stamp(run.startedAt) : "Waiting for a worker"}
              </p>
            </article>
          );
        })}
      </div>
      {active && <p className="text-xs text-muted-foreground">This panel refreshes while a run is queued or running.</p>}
    </section>
  );
}
