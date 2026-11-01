import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AUTONOMY, AUTONOMY_LABEL, type Autonomy } from "@/lib/engine/autonomy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Bug, CheckCircle2, CircleDashed, Database, GitBranch, Layers, LayoutTemplate, Plus, Rocket, ShieldCheck } from "lucide-react";

const PRESETS = [
  { title: "Landing page", hint: "Modern, animated", icon: LayoutTemplate, prompt: "Build a modern, responsive, animated landing page for this project. Match the existing stack, keep it mobile-friendly, then run deployment_preflight." },
  { title: "Fix the build", hint: "Repair failures", icon: Bug, prompt: "Run the project's typecheck, tests and build in the sandbox. Fix every failure at its root cause and re-run until all pass. Report what was broken." },
  { title: "Security review", hint: "Find & fix risks", icon: ShieldCheck, prompt: "/review Audit this repository for security issues (secrets, auth, injection, unsafe data access). List findings by severity with file references." },
  { title: "Full-stack app", hint: "Auth + database", icon: Layers, prompt: "/plan Plan a full-stack app in this repo with sign-in, a database with migrations under supabase/migrations, and deployable pages. Show the plan before building." },
];
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createRepo, createSession, listBranches, listCredentials, listModels, listRepos, listSessions } from "@/lib/app.functions";
import { isAiProvider, providerName } from "@/lib/providers";
import { pageMeta } from "@/lib/page-meta";
import { taskRunStatus } from "@/lib/task-run-status";
import { WorkSplitPanel } from "@/components/WorkSplitPanel";
import { DeployPanel } from "@/components/DeployPanel";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/app")({
  head: () => ({ meta: pageMeta("Workspace — Forge", "Your coding agent tasks.") }),
  component: Dashboard,
});

function Dashboard() {
  const nav = useNavigate();
  const fetchSessions = useServerFn(listSessions);
  const fetchCreds = useServerFn(listCredentials);
  const fetchRepos = useServerFn(listRepos);
  const fetchBranches = useServerFn(listBranches);
  const fetchModels = useServerFn(listModels);
  const create = useServerFn(createSession);
  const makeRepo = useServerFn(createRepo);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [setupConnections, setSetupConnections] = useState(true);

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => fetchSessions(),
    // Poll even when idle so runs started on another device become visible.
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const creds = useQuery({ queryKey: ["creds"], queryFn: () => fetchCreds() });
  const aiCreds = useMemo(() => creds.data?.filter((c) => isAiProvider(c.provider)) ?? [], [creds.data]);
  const ghCreds = useMemo(() => creds.data?.filter((c) => c.provider === "github") ?? [], [creds.data]);
  const hasGh = ghCreds.length > 0;
  // Several GitHub accounts: the chosen one lists repos and is remembered by the new project.
  const [ghAccount, setGhAccount] = useState("");
  const ghId = ghAccount || ghCreds[0]?.id || "";
  const ghData = ghId ? { account: ghId } : {};
  const repos = useQuery({ queryKey: ["repos", ghId], queryFn: () => fetchRepos({ data: ghData }), enabled: !!hasGh });

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [credId, setCredId] = useState("");
  const [model, setModel] = useState("");
  const [teamPrompt, setTeamPrompt] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState("");
  const [mode, setMode] = useState<Autonomy>("supervised");

  const branches = useQuery({ queryKey: ["branches", repo, ghId], queryFn: () => fetchBranches({ data: { repo, ...ghData } }), enabled: !!repo });
  const models = useQuery({ queryKey: ["models", credId], queryFn: () => fetchModels({ data: { id: credId } }), enabled: !!credId, retry: false });

  useEffect(() => {
    const r = repos.data?.find((x) => x.full_name === repo);
    if (r) setBranch(r.default_branch);
  }, [repo, repos.data]);
  useEffect(() => {
    if (!credId && aiCreds[0]) setCredId(aiCreds[0].id);
  }, [aiCreds, credId]);

  const [showNew, setShowNew] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPrivate, setNewPrivate] = useState(true);
  const qc = useQueryClient();
  const createRepoM = useMutation({
    mutationFn: () => makeRepo({ data: { name: newName.trim(), description: newDesc, private: newPrivate, ...ghData } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["repos"] });
      await qc.refetchQueries({ queryKey: ["repos"] });
      setRepo(r.full_name);
      setBranch(r.default_branch);
      setShowNew(false);
      setNewName("");
      setNewDesc("");
      toast.success(`Created ${r.full_name}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createM = useMutation({
    mutationFn: () =>
      create({ data: { repo, base_branch: branch, credential_id: credId, model: manualModel || model, mode, title: "New task", accounts: ghId ? { github: ghId } : {} } }),
    onSuccess: (id) => { if (teamPrompt) sessionStorage.setItem(`forge:draft:${id}`, teamPrompt); return setupConnections ? setSetupId(id) : nav({ to: "/s/$id", params: { id } }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const ready = creds.data && aiCreds.length > 0 && hasGh;
  const hasDb = creds.data?.some((c) => c.provider === "supabase");
  const hasVercel = creds.data?.some((c) => c.provider === "vercel");
  const [goal, setGoal] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [filter, setFilter] = useState<"all" | "running" | "needs" | "done">("all");
  const [q, setQ] = useState("");
  // Pick the first model automatically so the simple path is: describe → choose repo → start.
  useEffect(() => { if (!model && !manualModel && models.data?.[0]) setModel(models.data[0]); }, [models.data, model, manualModel]);
  useEffect(() => { setTeamPrompt(goal.trim() ? goal : null); }, [goal]);
  const tasks = useMemo(() => (sessions.data ?? []).map((s) => {
    const st = taskRunStatus(s);
    const kind = st === "cloud" || st === "browser" ? "running" : st === "stale" || s.pendingCount > 0 ? "needs" : "done";
    return { s, st, kind } as const;
  }), [sessions.data]);
  const counts = { all: tasks.length, running: tasks.filter((t) => t.kind === "running").length, needs: tasks.filter((t) => t.kind === "needs").length, done: tasks.filter((t) => t.kind === "done").length };
  const shown = tasks.filter((t) => (filter === "all" || t.kind === filter) && `${t.s.title} ${t.s.repo}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="bg-aurora min-h-screen">
      <AppHeader />
      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-5 p-3 pb-10 sm:gap-7 sm:p-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] lg:p-8">
        <section className="min-w-0 space-y-4">
          <div>
            <h1 className="text-gradient text-2xl font-semibold tracking-tight sm:text-3xl">What would you like to build?</h1>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              {([["AI key", aiCreds.length > 0, true], ["GitHub", hasGh, true], ["Database", hasDb, false], ["Vercel", hasVercel, false]] as const).map(([label, ok, required]) => (
                <Link key={label} to="/settings" className={`flex items-center gap-1 rounded-full border px-2.5 py-1 ${ok ? "border-primary/40 text-foreground" : required ? "border-destructive/60 text-destructive" : "text-muted-foreground"}`}>
                  {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <CircleDashed className="h-3.5 w-3.5" />}{label}{!ok && !required && <span className="opacity-70">· optional</span>}
                </Link>
              ))}
            </div>
          </div>
          <div className="panel rounded-2xl p-4 shadow-lg shadow-black/10 sm:p-6">
            {creds.data && !ready ? (
              <div className="space-y-3 text-sm">
                <p>Two quick things first: {aiCreds.length === 0 && "an AI key"}{aiCreds.length === 0 && !hasGh && " and "}{!hasGh && "a GitHub token"}.</p>
                <Button asChild><Link to="/settings">Open setup</Link></Button>
              </div>
            ) : (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); createM.mutate(); }}>
                <Textarea value={goal} onChange={(e) => { setGoal(e.target.value); setPreset(null); }} rows={4} className="min-h-28 text-base"
                  placeholder="e.g. A booking site for my salon with sign-in, a calendar and payments" aria-label="What to build" />
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <button key={p.title} type="button" onClick={() => { const on = preset === p.title; setPreset(on ? null : p.title); setGoal(on ? "" : p.prompt); }}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:border-primary ${preset === p.title ? "border-primary bg-accent text-primary" : "text-muted-foreground"}`}>
                      <p.icon className="h-3.5 w-3.5" />{p.title}
                    </button>
                  ))}
                </div>
                {ghCreds.length > 1 && (
                  <div className="space-y-1.5">
                    <Label>GitHub account</Label>
                    <Select value={ghId} onValueChange={(v) => { setGhAccount(v); setRepo(""); setBranch(""); }}>
                      <SelectTrigger className="h-11 w-full min-w-0 [&>span]:truncate"><SelectValue placeholder="Choose account" /></SelectTrigger>
                      <SelectContent>{ghCreds.map((c) => <SelectItem key={c.id} value={c.id}>{c.label || "GitHub"} ···{c.last4}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Project (GitHub repository)</Label>
                    <button type="button" className="shrink-0 py-1 text-sm text-primary underline" onClick={() => setShowNew((v) => !v)}>{showNew ? "Use existing" : "+ New project"}</button>
                  </div>
                  {showNew ? (
                    <div className="space-y-2 rounded-md border bg-background p-3">
                      <Input className="h-11 text-base sm:text-sm" value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value.replace(/\s+/g, "-"))} placeholder="my-new-project" aria-label="New repository name" />
                      <p className="text-xs text-muted-foreground">Use letters, numbers, dots, hyphens or underscores.</p>
                      <Input className="h-10 text-sm" value={newDesc} maxLength={350} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description (optional)" aria-label="Repository description" />
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} /> Private repository</label>
                      {createRepoM.error && <p role="alert" className="text-xs text-destructive">{(createRepoM.error as Error).message}</p>}
                      <Button type="button" variant="secondary" size="sm" disabled={!/^[A-Za-z0-9._-]{1,100}$/.test(newName.trim()) || createRepoM.isPending} onClick={() => createRepoM.mutate()}>{createRepoM.isPending ? "Creating…" : "Create on GitHub"}</Button>
                    </div>
                  ) : (
                    <Select value={repo} onValueChange={setRepo}>
                      <SelectTrigger className="h-11 w-full min-w-0 [&>span]:truncate [&>span]:text-left"><SelectValue placeholder={repos.isLoading ? "Loading…" : "Choose a project"} /></SelectTrigger>
                      <SelectContent className="max-w-[calc(100vw-2rem)]">{repos.data?.map((r) => <SelectItem key={r.full_name} value={r.full_name}>{r.full_name}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                  {repos.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive"><span className="min-w-0 flex-1">{(repos.error as Error).message}</span><Button type="button" size="sm" variant="outline" onClick={() => void repos.refetch()} disabled={repos.isFetching}>Retry</Button></div>}
                  {!showNew && repos.data?.length === 0 && !repos.isLoading && !repos.error && <p className="text-xs text-muted-foreground">No repositories found. Create a project above or check GitHub account access.</p>}
                  {repo && branches.error && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive"><span className="min-w-0 flex-1">Branches could not be loaded: {(branches.error as Error).message}</span><Button type="button" size="sm" variant="outline" onClick={() => void branches.refetch()} disabled={branches.isFetching}>Retry</Button></div>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Using <span className="text-foreground">{aiCreds.find((c) => c.id === credId)?.label ?? "your AI key"}</span> · <span className="font-mono text-foreground">{manualModel || model || "…"}</span> · {AUTONOMY_LABEL[mode].title}{" "}
                  <button type="button" className="text-primary underline" onClick={() => setAdvanced((v) => !v)}>{advanced ? "Hide options" : "Change"}</button>
                </p>
                {advanced && (
                  <div className="space-y-4 rounded-lg border bg-background/50 p-3">
                    {repo && (
                      <div className="space-y-1.5">
                        <Label>Start from branch</Label>
                        <Select value={branch} onValueChange={setBranch}>
                          <SelectTrigger className="h-11 w-full min-w-0 [&>span]:truncate [&>span]:text-left"><SelectValue /></SelectTrigger>
                          <SelectContent className="max-w-[calc(100vw-2rem)]">{branches.data?.map((b) => <SelectItem className="break-all" key={b} value={b}>{b}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                    )}
                    {models.error && <div role="alert" className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">Could not load models for this AI key. Retry or enter a compatible model ID manually below. <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => void models.refetch()} disabled={models.isFetching}>Retry</Button></div>}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>AI key</Label>
                        <Select value={credId} onValueChange={(v) => { setCredId(v); setModel(""); }}>
                          <SelectTrigger className="h-11 w-full min-w-0 [&>span]:truncate [&>span]:text-left"><SelectValue /></SelectTrigger>
                          <SelectContent className="max-w-[calc(100vw-2rem)]">{aiCreds.map((c) => <SelectItem className="break-all" key={c.id} value={c.id}>{c.label} · {providerName(c.provider)}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Model</Label>
                        <Select value={model} onValueChange={setModel}>
                          <SelectTrigger className="h-11 w-full min-w-0 [&>span]:truncate [&>span]:text-left"><SelectValue placeholder={models.isLoading ? "Loading…" : "Choose model"} /></SelectTrigger>
                          <SelectContent className="max-w-[calc(100vw-2rem)]">{models.data?.map((m) => <SelectItem className="break-all" key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                    </div>
                    <Input className="h-11 text-base sm:text-sm" value={manualModel} onChange={(e) => setManualModel(e.target.value)} placeholder="…or type a model ID" aria-label="Model ID" />
                    <div className="grid grid-cols-2 gap-2">
                      {AUTONOMY.map((m) => (
                        <button type="button" key={m} onClick={() => setMode(m)} className={`min-w-0 rounded-md border p-2.5 text-left text-sm ${mode === m ? "border-primary bg-accent" : "bg-background"}`}>
                          <span className="font-medium">{AUTONOMY_LABEL[m].title}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">{AUTONOMY_LABEL[m].hint}</span>
                        </button>
                      ))}
                    </div>
                    <WorkSplitPanel credId={credId} model={manualModel || model} repo={repo} onPrompt={(p) => setGoal(p ?? "")} />
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={setupConnections} onChange={(e) => setSetupConnections(e.target.checked)} /> Connect database & website first</label>
                {createM.error && <p role="alert" className="text-sm text-destructive">{(createM.error as Error).message}</p>}
                <Button disabled={!repo || !branch || !credId || !(model || manualModel) || !goal.trim() || createM.isPending || !!setupId} className="h-12 w-full text-base">
                  <Plus /> {createM.isPending ? "Creating your workspace…" : "Start building"}
                </Button>
                {!goal.trim() && <p className="text-center text-xs text-muted-foreground">Describe what you want to build to start a task.</p>}
              </form>
            )}
          </div>
        </section>
        <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0"><h2 className="font-semibold tracking-tight">Your projects</h2><p className="mt-0.5 text-xs text-muted-foreground">Pick up where you left off</p></div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search tasks" className="h-8 w-32 rounded-md border bg-card/70 px-2 text-xs outline-none focus:border-primary" />
          </div>
          <div className="mb-3 flex gap-1 overflow-x-auto text-xs">
            {([["all", "All"], ["running", "Running"], ["needs", "Needs you"], ["done", "Done"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setFilter(k)} className={`shrink-0 rounded-full border px-3 py-1 ${filter === k ? "border-primary bg-accent text-primary" : "text-muted-foreground"}`}>{label} <span className="tabular-nums opacity-70">{counts[k]}</span></button>
            ))}
          </div>
          
          {sessions.isLoading && <div className="panel space-y-3 p-4" role="status" aria-live="polite"><div className="h-3 w-28 animate-pulse rounded bg-muted" /><div className="h-3 w-4/5 animate-pulse rounded bg-muted" /><div className="h-3 w-2/3 animate-pulse rounded bg-muted" /><span className="sr-only">Loading your projects…</span></div>}
          {sessions.error && <div className="panel p-4 text-sm"><p className="font-medium">Projects could not be loaded</p><p className="mt-1 text-xs text-muted-foreground">{(sessions.error as Error).message}</p><Button className="mt-3" size="sm" variant="outline" onClick={() => void sessions.refetch()}>Try again</Button></div>}
          {!sessions.isLoading && !sessions.error && sessions.data?.length === 0 && <div className="panel p-6 text-center"><div className="mx-auto grid size-10 place-items-center rounded-xl bg-accent text-primary"><GitBranch className="size-5" /></div><p className="mt-3 text-sm font-medium text-foreground">Your workspace starts here</p><p className="mt-1 text-xs text-muted-foreground">Start a task and your projects will appear here.</p></div>}
          {!sessions.isLoading && !sessions.error && sessions.data && sessions.data.length > 0 && shown.length === 0 && <div className="panel p-5 text-center text-sm"><p className="font-medium">No matching projects</p><p className="mt-1 text-xs text-muted-foreground">Try another search or clear the current filter.</p><Button className="mt-3" size="sm" variant="outline" onClick={() => { setQ(""); setFilter("all"); }}>Clear filters</Button></div>}
          <ul className="max-h-[32rem] space-y-2 overflow-y-auto lg:max-h-[calc(100dvh-16rem)]">
            {shown.map(({ s, st, kind }) => (
              <li key={s.id}>
                <Link to="/s/$id" params={{ id: s.id }} className={`panel block rounded-xl p-3.5 transition-all hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${kind === "running" ? "border-primary/50" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${kind === "running" ? "bg-accent text-primary" : kind === "needs" ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"}`}>
                      {st === "cloud" ? "Running in cloud" : st === "browser" ? "Running" : st === "stale" ? "Stopped reporting" : s.pendingCount > 0 ? `${s.pendingCount} to approve` : "Idle"}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3 shrink-0" /><span className="min-w-0 flex-1 truncate font-mono">{s.repo}</span>
                    {s.supabase_ref && <span title="Database linked"><Database className="h-3 w-3" /></span>}
                    {s.vercel_project_id && <span title="Website linked"><Rocket className="h-3 w-3" /></span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      </main>
      <Dialog open={!!setupId} onOpenChange={(open) => { if (!open && setupId) void nav({ to: "/s/$id", params: { id: setupId } }); }}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto p-4">
          <DialogTitle>Connect your new project</DialogTitle>
          <DialogDescription>Use existing accounts or connect once. Public settings sync to Vercel production and previews; private keys never go into GitHub.</DialogDescription>
          {setupId && <DeployPanel id={setupId} />}
          <Button onClick={() => { if (setupId) void nav({ to: "/s/$id", params: { id: setupId } }); }}>Continue to task</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
