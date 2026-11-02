import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Database, ExternalLink, Globe, KeyRound, Loader2, Rocket } from "lucide-react";
import { saveCredential } from "@/lib/app.functions";
import { deployOAuthStatus, startDeployOAuth } from "@/lib/deploy-oauth.functions";
import { ConnectSyncCard } from "@/components/ProjectHealth";
import { ProjectSyncHistory } from "@/components/ProjectSyncHistory";
import { CustomDomainSetup } from "@/components/CustomDomainSetup";
import { ProjectSecrets } from "@/components/ProjectSecrets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  applyMigrations, getDeployments, getIntegrations, getMigrationStatus, identifyAccounts, linkSupabase, linkVercel,
  listSupabaseOptions, saveDatabaseSettings, setTaskAccount, setVercelTeam, syncDeployEnv, vercelAccess,
} from "@/lib/integrations.functions";

type Svc = "supabase" | "vercel";
type AccountOption = { id: string; provider: string; label: string; last4: string };
const NAME: Record<Svc, string> = { supabase: "database", vercel: "Vercel" };
const REGIONS = ["us-east-1", "us-west-1", "eu-central-1", "eu-west-2", "ap-southeast-1", "ap-south-1", "ap-northeast-1", "sa-east-1"];
const trig = "h-11 w-full min-w-0 [&>span]:truncate [&>span]:text-left";
const TOKEN_URL: Record<Svc, string> = {
  supabase: "https://supabase.com/dashboard/account/tokens",
  vercel: "https://vercel.com/account/settings/tokens",
};

/** Deploy tab: three steps — database, website, go live. */
export function DeployPanel({ id, onSend }: { id: string; onSend?: (prompt: string) => void }) {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["integrations", id], queryFn: useServerFn(getIntegrations).bind(null, { data: { id } }), retry: false, throwOnError: false });
  const refresh = () => {
    for (const k of ["integrations", "session", "deps", "migr", "sb-opts", "vc-access"]) qc.invalidateQueries({ queryKey: [k, id] });
  };
  if (!info.data) return <p className="p-4 text-sm text-muted-foreground">{info.error ? (info.error as Error).message : "Loading…"}</p>;
  const d = info.data;
  const vercelOpts = d.accountOptions.filter((o) => o.provider === "vercel");
  const sbOpts = d.accountOptions.filter((o) => o.provider === "supabase");
  const ghOpts = d.accountOptions.filter((o) => o.provider === "github");
  const live = !!d.supabase_ref && !!d.vercel_project_id;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-3 sm:p-4">
      <header className="px-1">
        <h2 className="text-lg font-semibold">Deploy</h2>
        <p className="text-sm text-muted-foreground">Use your own database and Vercel accounts. Each task keeps its own choices.</p>
      </header>

      <AccountWarnings onRenamed={refresh} />

      <Step n={1} done={!!d.supabase_ref} icon={<Database className="h-4 w-4" />} title="Database" hint="Where your app stores its data">
        <AccountPicker id={id} svc="supabase" options={sbOpts} active={d.activeAccounts.supabase} onChange={refresh} />
        {d.hasSupabase && (
          <DatabaseStep key={d.activeAccounts.supabase ?? "none"} id={id} account={d.activeAccounts.supabase} linked={d.supabase_ref} onChange={refresh} />
        )}
        {d.supabase_ref && <DatabaseKeys id={id} saved={d.hasDatabaseSettings} privileged={d.hasServiceRoleKey} onChange={refresh} />}
      </Step>

      <Step n={2} done={!!d.vercel_project_id} icon={<Globe className="h-4 w-4" />} title="Website" hint="Where your app goes online">
        <AccountPicker id={id} svc="vercel" options={vercelOpts} active={d.activeAccounts.vercel} onChange={refresh} />
        {d.hasVercel && (
          <WebsiteStep key={d.activeAccounts.vercel ?? "none"} id={id} account={d.activeAccounts.vercel} linked={d.vercel_project_id} dbLinked={!!d.supabase_ref} onChange={refresh} />
        )}
        {d.vercel_project_id && <><CustomDomainSetup taskId={id} {...(onSend ? { onSend } : {})} /><div className="border-t pt-4"><ProjectSecrets taskId={id} allowCreate /></div></>}
      </Step>

      <Step n={3} done={false} icon={<Rocket className="h-4 w-4" />} title="Go live" hint={live ? "Database and website are linked together" : "Finish steps 1 and 2 first, or sync what you have"}>
        <ConnectSyncCard id={id} {...(onSend ? { onSend } : {})} />
        <ProjectSyncHistory id={id} />
      </Step>

      {ghOpts.length > 1 && (
        <section className="rounded-lg border bg-card p-4">
          <AccountPicker id={id} svc="github" options={ghOpts} active={d.activeAccounts.github} onChange={refresh} />
        </section>
      )}
    </div>
  );
}

function Step({ n, done, icon, title, hint, children }: { n: number; done: boolean; icon: ReactNode; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b p-4">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? "bg-primary text-primary-foreground" : "bg-accent"}`}>
          {done ? <Check className="h-4 w-4" /> : n}
        </span>
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 font-semibold">{icon}{title}</h3>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

/** Choose a saved account for this task, or connect a new one (one-click sign-in when available, token otherwise). */
function AccountPicker({ id, svc, options, active, onChange }: { id: string; svc: Svc | "github"; options: AccountOption[]; active: string | null; onChange: () => void }) {
  const save = useServerFn(setTaskAccount);
  const [adding, setAdding] = useState(false);
  const m = useMutation({
    mutationFn: (account: string | null) => save({ data: { id, provider: svc, account } }),
    onSuccess: () => { toast.success("Account updated for this task"); onChange(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const label = svc === "github" ? "GitHub account" : `${svc === "vercel" ? "Vercel" : "Database"} account`;

  return (
    <div className="space-y-2">
      {options.length > 0 && (
        <div className="grid gap-1.5 sm:grid-cols-[9rem_1fr] sm:items-center">
          <Label htmlFor={`acct-${svc}`} className="text-sm">{label}</Label>
          <div className="flex min-w-0 gap-2">
            <Select value={active ?? ""} onValueChange={(v) => m.mutate(v)} disabled={m.isPending}>
              <SelectTrigger id={`acct-${svc}`} className={trig}><SelectValue placeholder="Choose account" /></SelectTrigger>
              <SelectContent>{options.map((o) => <SelectItem key={o.id} value={o.id}>{o.label} ···{o.last4}</SelectItem>)}</SelectContent>
            </Select>
            {active && svc !== "github" && <Button variant="ghost" className="h-11 shrink-0" disabled={m.isPending} onClick={() => m.mutate(null)}>Unlink</Button>}
          </div>
        </div>
      )}
      {svc === "github" ? (
        <Button asChild variant="link" size="sm" className="h-auto px-0"><Link to="/settings">Add a GitHub account in Settings</Link></Button>
      ) : options.length === 0 || adding ? (
        <Connect svc={svc} onDone={async (acct) => { await m.mutateAsync(acct); setAdding(false); }} />
      ) : (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setAdding(true)}>Connect another {NAME[svc]} account</Button>
      )}
    </div>
  );
}

function Connect({ svc, onDone }: { svc: Svc; onDone: (accountId: string) => void | Promise<void> }) {
  const status = useQuery({ queryKey: ["deploy-oauth-status"], queryFn: useServerFn(deployOAuthStatus), staleTime: 60_000 });
  const start = useServerFn(startDeployOAuth);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const oauth = status.data?.[svc];
  const go = async () => {
    setBusy(true);
    try { const { url } = await start({ data: { provider: svc } }); window.location.assign(url); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't start sign-in"); setBusy(false); }
  };
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      {oauth && (
        <Button className="h-11 w-full" disabled={busy} onClick={go}>
          {busy ? <Loader2 className="animate-spin" /> : null} Sign in with {svc === "vercel" ? "Vercel" : "Supabase"}
        </Button>
      )}
      {oauth && !showToken ? (
        <button type="button" className="w-full text-center text-xs text-muted-foreground underline" onClick={() => setShowToken(true)}>Use an access token instead</button>
      ) : <TokenForm svc={svc} onDone={onDone} />}
    </div>
  );
}

function TokenForm({ svc, onDone }: { svc: Svc; onDone: (accountId: string) => void | Promise<void> }) {
  const [key, setKey] = useState("");
  const save = useServerFn(saveCredential);
  const qc = useQueryClient();
  const label = svc === "vercel" ? "Vercel" : "Supabase";
  const m = useMutation({
    mutationFn: () => save({ data: { provider: svc, label, key: key.trim(), base_url: null, custom_models: [], extra_body: null } }),
    onSuccess: async (r) => {
      toast.success(`${label} connected`); setKey("");
      qc.invalidateQueries({ queryKey: ["creds"] }); qc.invalidateQueries({ queryKey: ["account-identities"] });
      await onDone(r.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        Create a {label} access token{svc === "vercel" ? " (scope: Full Account)" : ""}, then paste it here.{" "}
        <a className="inline-flex items-center gap-1 text-primary underline" href={TOKEN_URL[svc]} target="_blank" rel="noreferrer">Open {label} <ExternalLink className="h-3 w-3" /></a>
      </p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Input className="h-11 min-w-0 flex-1 text-base sm:text-sm" type="password" autoComplete="off" placeholder="Paste token" value={key} onChange={(e) => setKey(e.target.value)} />
        <Button className="h-11 shrink-0" disabled={!key.trim() || m.isPending}><KeyRound /> {m.isPending ? "Checking…" : "Connect"}</Button>
      </form>
      <p className="text-xs text-muted-foreground">Checked, encrypted and never shown again.</p>
    </div>
  );
}

function AccountWarnings({ onRenamed }: { onRenamed: () => void }) {
  const q = useQuery({ queryKey: ["account-identities"], queryFn: useServerFn(identifyAccounts), staleTime: 5 * 60_000 });
  const renamed = q.data?.renamed;
  useEffect(() => { if (renamed) onRenamed(); }, [renamed]); // eslint-disable-line react-hooks/exhaustive-deps
  const dups = q.data?.duplicates ?? [];
  const broken = (q.data?.accounts ?? []).filter((a) => !a.reachable);
  if (!dups.length && !broken.length) return null;
  return (
    <section role="alert" className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
      {dups.map((g) => (
        <p key={g.provider + g.name} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Tokens {g.last4.map((l) => `···${l}`).join(" and ")} are the same {g.provider === "vercel" ? "Vercel" : "database"} account (<b>{g.name}</b>). Remove one in Settings → Accounts.</span>
        </p>
      ))}
      {broken.map((a) => <p key={a.id} className="text-xs">Token ···{a.last4} ({a.label}) stopped working. Remove it in Settings → Accounts and connect again.</p>)}
    </section>
  );
}

function Choice({ mode, setMode }: { mode: "existing" | "new"; setMode: (m: "existing" | "new") => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {(["new", "existing"] as const).map((m) => (
        <button key={m} type="button" onClick={() => setMode(m)}
          className={`h-10 rounded-md text-sm font-medium transition ${mode === m ? "bg-background shadow-sm" : "text-muted-foreground"}`}>
          {m === "new" ? "Create new" : "Use existing"}
        </button>
      ))}
    </div>
  );
}

function DatabaseStep({ id, account, linked, onChange }: { id: string; account: string | null; linked: string | null; onChange: () => void }) {
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [pick, setPick] = useState("");
  const [name, setName] = useState(`forge-${id.slice(0, 6)}`);
  const [org, setOrg] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const opts = useQuery({ queryKey: ["sb-opts", id, account], queryFn: useServerFn(listSupabaseOptions).bind(null, { data: { id, ...(account ? { account } : {}) } }), enabled: !linked });
  const status = useQuery({ queryKey: ["migr", id, linked], queryFn: useServerFn(getMigrationStatus).bind(null, { data: { id } }), enabled: !!linked, refetchInterval: 15000, retry: false, throwOnError: false });
  const link = useServerFn(linkSupabase);
  const apply = useServerFn(applyMigrations);
  const orgId = org || opts.data?.orgs[0]?.id || "";
  const linkM = useMutation({
    mutationFn: (v: Parameters<typeof link>[0]["data"]) => link({ data: v }),
    onSuccess: (r) => { onChange(); r.syncError ? toast.error(r.syncError) : toast.success("Database updated"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const applyM = useMutation({
    mutationFn: () => apply({ data: { id } }),
    onSuccess: (r) => { status.refetch(); r.error ? toast.error(`${r.error.file}: ${r.error.message}`) : toast.success(r.applied.length ? `Applied ${r.applied.length} change(s)` : "Nothing to apply"); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (linked) {
    const pending = status.data?.pending ?? [];
    return (
      <div className="space-y-3 text-sm">
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2">
          <span className="truncate font-mono text-xs">{linked}{status.data?.dbStatus ? ` · ${status.data.dbStatus.toLowerCase().replace(/_/g, " ")}` : ""}</span>
          <Button size="sm" variant="ghost" disabled={linkM.isPending} onClick={() => linkM.mutate({ id, unlink: true })}>Unlink</Button>
        </div>
        {status.isError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Database changes could not be checked.</span><Button variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>Retry</Button></div>}
        <div className="flex items-center justify-between gap-2">
          <p>{status.data ? `${pending.length} change(s) waiting · ${status.data.applied.length} applied` : "Checking changes…"}</p>
          <Button size="sm" disabled={status.isError || !pending.length || applyM.isPending} onClick={() => applyM.mutate()}>{applyM.isPending ? "Applying…" : "Apply"}</Button>
        </div>
        {pending.map((p) => <p key={p} className="truncate font-mono text-xs text-muted-foreground">{p.replace("supabase/migrations/", "")}</p>)}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <Choice mode={mode} setMode={setMode} />
      {opts.error && <p className="text-xs text-destructive">{(opts.error as Error).message}</p>}
      {mode === "existing" ? (
        <>
          <Select value={pick} onValueChange={setPick}>
            <SelectTrigger className={trig}><SelectValue placeholder={opts.isLoading ? "Loading…" : "Choose a project"} /></SelectTrigger>
            <SelectContent className="max-w-[calc(100vw-2rem)]">{opts.data?.projects.map((p) => <SelectItem key={p.ref} value={p.ref}>{p.name} · {p.region}</SelectItem>)}</SelectContent>
          </Select>
          <Button className="h-11 w-full" disabled={!pick || linkM.isPending} onClick={() => linkM.mutate({ id, ref: pick })}>{linkM.isPending ? "Linking…" : "Link database"}</Button>
        </>
      ) : (
        <>
          <Input className="h-11 text-base sm:text-sm" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Select value={orgId} onValueChange={setOrg}>
              <SelectTrigger className={trig}><SelectValue placeholder="Organization" /></SelectTrigger>
              <SelectContent>{opts.data?.orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger className={trig}><SelectValue /></SelectTrigger>
              <SelectContent>{REGIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button className="h-11 w-full" disabled={!name.trim() || !orgId || linkM.isPending} onClick={() => linkM.mutate({ id, create: { name: name.trim(), orgId, region } })}>
            {linkM.isPending ? "Creating…" : "Create database"}
          </Button>
          <p className="text-xs text-muted-foreground">A new database takes about 2 minutes to start.</p>
        </>
      )}
    </div>
  );
}

function WebsiteStep({ id, account, linked, dbLinked, onChange }: { id: string; account: string | null; linked: string | null; dbLinked: boolean; onChange: () => void }) {
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [pick, setPick] = useState("");
  const qc = useQueryClient();
  const access = useQuery({ queryKey: ["vc-access", id, account], queryFn: useServerFn(vercelAccess).bind(null, { data: { id, ...(account ? { account } : {}) } }), enabled: !linked });
  const setTeam = useServerFn(setVercelTeam);
  const teamM = useMutation({
    mutationFn: (teamId: string) => setTeam({ data: { account: account!, teamId } }),
    onSuccess: () => { toast.success("Team remembered for this account"); qc.invalidateQueries({ queryKey: ["vc-access"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const deps = useQuery({ queryKey: ["deps", id, linked, account], queryFn: useServerFn(getDeployments).bind(null, { data: { id } }), enabled: !!linked, refetchInterval: 10000 });
  const link = useServerFn(linkVercel);
  const sync = useServerFn(syncDeployEnv);
  const linkM = useMutation({
    mutationFn: (v: Parameters<typeof link>[0]["data"]) => link({ data: v }),
    onSuccess: (r) => { onChange(); r.syncError ? toast.error(r.syncError) : toast.success("Website updated"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const syncM = useMutation({
    mutationFn: (redeploy: boolean) => sync({ data: { id, redeploy } }),
    onSuccess: (r) => { toast.success(r.redeployed ? "Settings sent to Vercel — rebuilding now" : "Settings sent to Vercel"); deps.refetch(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (linked) {
    const latest = deps.data?.deployments[0];
    const runtime = deps.data?.runtime;
    const failed = latest?.state === "ERROR" || runtime?.state === "ERROR";
    const ok = runtime?.state === "PASSED";
    const text = runtime?.state === "ERROR" ? "Built, but the page is failing" : runtime?.state === "UNVERIFIED" ? "Built · page health not checked yet" : ok ? "Live · page responding" : latest ? latest.state.toLowerCase() : deps.isLoading ? "Checking…" : "Not deployed yet";
    return (
      <div className="space-y-3 text-sm">
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2">
          <span className="truncate font-mono text-xs">{linked}</span>
          <Button size="sm" variant="ghost" disabled={linkM.isPending} onClick={() => linkM.mutate({ id, unlink: true })}>Unlink</Button>
        </div>
        <p className={`font-medium ${failed ? "text-destructive" : ok ? "text-primary" : "text-muted-foreground"}`}>{text}</p>
        {runtime && !ok && <p className="text-xs text-muted-foreground">{runtime.note}</p>}
        {latest?.state === "READY" && <Button asChild className="h-11 w-full"><a href={latest.url} target="_blank" rel="noreferrer"><ExternalLink /> Open website</a></Button>}
        {dbLinked && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" className="h-11" disabled={syncM.isPending} onClick={() => syncM.mutate(false)}>Send settings</Button>
            <Button variant="outline" className="h-11" disabled={syncM.isPending} onClick={() => syncM.mutate(true)}>{syncM.isPending ? "Syncing…" : "Send & rebuild"}</Button>
          </div>
        )}
        {deps.data?.log && (
          <details><summary className="cursor-pointer text-xs text-muted-foreground">Build log</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-[11px]">{deps.data.log}</pre>
          </details>
        )}
        {failed && <p className="text-xs text-muted-foreground">Use Auto-fix in step 3 to have the agent repair it.</p>}
        {deps.error && <p className="text-xs text-destructive">{(deps.error as Error).message}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <Choice mode={mode} setMode={setMode} />
      {access.error && <p className="text-xs text-destructive">{(access.error as Error).message}</p>}
      {account && access.data?.teams?.length && !access.data.hasTeam && (
        <Select value="" onValueChange={(t) => teamM.mutate(t)} disabled={teamM.isPending}>
          <SelectTrigger className={trig}><SelectValue placeholder="Which team are your websites in?" /></SelectTrigger>
          <SelectContent className="max-w-[calc(100vw-2rem)]">{access.data.teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}{t.slug ? ` · ${t.slug}` : ""}</SelectItem>)}</SelectContent>
        </Select>
      )}
      {mode === "existing" ? (
        <>
          <Select value={pick} onValueChange={setPick} disabled={access.isFetching || linkM.isPending}>
            <SelectTrigger className={trig}><SelectValue placeholder={access.isLoading ? "Loading…" : "Choose a project"} /></SelectTrigger>
            <SelectContent className="max-w-[calc(100vw-2rem)]">{access.data?.projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.repo ? ` · ${p.repo}` : ""}</SelectItem>)}</SelectContent>
          </Select>
          {!access.isFetching && !access.error && access.data?.projects.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {access.data.verdict === "limited"
                ? "This Vercel sign-in only proves who you are; it can't see your websites. Pick your saved Vercel access-token account above (Settings → add a Vercel token) to list and deploy your sites."
                : "No websites in this Vercel account yet."}
            </p>
          )}
          <Button className="h-11 w-full" disabled={!pick || !access.data?.projects.some((p) => p.id === pick) || linkM.isPending} onClick={() => linkM.mutate({ id, projectId: pick })}>{linkM.isPending ? "Linking…" : "Link website"}</Button>
        </>
      ) : (
        <>
          <Button className="h-11 w-full" disabled={linkM.isPending} onClick={() => linkM.mutate({ id, create: true })}>{linkM.isPending ? "Creating…" : "Create website"}</Button>
          <p className="text-xs text-muted-foreground">Getting a GitHub error? <a className="text-primary underline" href="https://github.com/apps/vercel/installations/new" target="_blank" rel="noreferrer">Let Vercel see your repository</a>, then try again.</p>
        </>
      )}
    </div>
  );
}

function DatabaseKeys({ id, saved, privileged, onChange }: { id: string; saved: boolean; privileged: boolean; onChange: () => void }) {
  const [url, setUrl] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [serviceRoleKey, setServiceRoleKey] = useState("");
  const save = useServerFn(saveDatabaseSettings);
  const m = useMutation({
    mutationFn: () => save({ data: { id, url: url.trim(), publicKey: publicKey.trim(), serviceRoleKey: serviceRoleKey.trim() || undefined, removeServiceRole: false } }),
    onSuccess: (r) => { setUrl(""); setPublicKey(""); setServiceRoleKey(""); onChange(); toast.success(r.synced ? "Saved securely and sent to Vercel" : "Saved securely; link a website next"); },
    onError: () => { setServiceRoleKey(""); toast.error("Couldn't save or sync the settings. Check the linked database and try again."); },
  });
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Database address & keys <span className="font-normal text-muted-foreground">· {saved ? "saved" : "filled in automatically"}</span></summary>
      <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="space-y-1"><Label htmlFor={`db-url-${id}`}>Project address</Label><Input id={`db-url-${id}`} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" /></div>
        <div className="space-y-1"><Label htmlFor={`db-key-${id}`}>Public key</Label><Input id={`db-key-${id}`} type="password" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} required autoComplete="off" /></div>
        <div className="space-y-1"><Label htmlFor={`db-service-${id}`}>Private service key (optional)</Label><Input id={`db-service-${id}`} type="password" value={serviceRoleKey} onChange={(e) => setServiceRoleKey(e.target.value)} autoComplete="off" placeholder={privileged ? "Already saved — leave blank to keep" : "Only if your app needs it"} /></div>
        <p className="text-xs text-muted-foreground">Private keys stay encrypted and go only to Vercel's server settings — never to GitHub or the public site.</p>
        <Button type="submit" className="h-11 w-full" disabled={m.isPending}>{m.isPending ? "Saving…" : "Save & sync"}</Button>
      </form>
    </details>
  );
}
