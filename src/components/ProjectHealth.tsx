import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Circle, Link2, Loader2, Wand2, XCircle } from "lucide-react";
import { autoFix, syncProject } from "@/lib/connect.functions";
import type { SyncStep } from "@/lib/connect";
import { Button } from "@/components/ui/button";

const ICON = {
  ok: <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />,
  warn: <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />,
  fail: <XCircle className="h-4 w-4 shrink-0 text-destructive" />,
  skip: <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />,
};

export function HealthList({ steps }: { steps: SyncStep[] }) {
  return (
    <ul className="space-y-2">
      {steps.map((s) => (
        <li key={s.key} className="flex gap-2 text-sm">
          {ICON[s.state]}
          <div className="min-w-0"><p className="font-medium leading-tight">{s.label}</p><p className="break-words text-xs text-muted-foreground">{s.note}</p></div>
        </li>
      ))}
    </ul>
  );
}

/** Read-only resource health card for the Deploy tab. */
export function ConnectSyncCard({ id, onSend }: { id: string; onSend?: (prompt: string) => void }) {
  const [steps, setSteps] = useState<SyncStep[] | null>(null);
  const sync = useServerFn(syncProject);
  const m = useMutation({
    mutationFn: () => sync({ data: { id } }),
    onSuccess: (r) => { setSteps(r.steps); if (r.overall === "ok") toast.success("Everything is connected and in sync"); else toast.message("Synced — see what still needs attention"); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section className="min-w-0 rounded-lg border border-primary/30 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">Resource health checks</h2>
          <p className="text-xs text-muted-foreground">Checks GitHub, database and Vercel connections, flags pending migrations and verifies deployment health. It does not change customer settings or deploy.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? <Loader2 className="animate-spin" /> : <Link2 />} Check now</Button>
          {onSend && <AutoFixButton id={id} onSend={onSend} onSteps={setSteps} />}
        </div>
      </div>
      {steps && <div className="mt-3"><HealthList steps={steps} /></div>}
    </section>
  );
}

/** One-click repair: sync, then hand the agent only the real blockers. */
export function AutoFixButton({ id, onSend, onSteps, compact, disabled }: { id: string; onSend: (prompt: string) => void; onSteps?: (s: SyncStep[]) => void; compact?: boolean; disabled?: boolean }) {
  const fix = useServerFn(autoFix);
  const m = useMutation({
    mutationFn: () => fix({ data: { id } }),
    onSuccess: (r) => {
      if (onSteps) onSteps(r.steps);
      if (!r.prompt) { toast.success("Nothing to fix — connections are in sync and the site is healthy"); return; }
      toast.success("Synced. The agent is fixing the remaining problems");
      onSend(r.prompt);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Button size="sm" onClick={() => m.mutate()} disabled={disabled || m.isPending} title="Run read-only checks and ask Forge to address verified blockers; approval may be required.">
      {m.isPending ? <Loader2 className="animate-spin" /> : <Wand2 />}{compact ? null : " Auto-fix"}
    </Button>
  );
}
