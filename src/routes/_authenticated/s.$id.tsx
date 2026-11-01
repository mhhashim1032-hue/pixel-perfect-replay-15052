import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { FileText, ImagePlus, Check, ChevronRight, ListChecks, Coins, History, Pencil, Save, FileCode, GitPullRequest, Loader2, Send, Square, Trash2, Wrench, X, MessageSquare, Activity, FolderTree, TerminalSquare, Rocket, GitCompare, Sparkles, Network, BookOpen, PanelRightClose, Globe, MoreHorizontal } from "lucide-react";
import { PreviewPanel } from "@/components/PreviewPanel";
import { AutoFixButton } from "@/components/ProjectHealth";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RunTimeline } from "@/components/RunTimeline";
import { AUTONOMY, AUTONOMY_LABEL, asAutonomy, type Autonomy } from "@/lib/engine/autonomy";
import { supabase } from "@/integrations/supabase/client";
import { getRepoMemory, clearRepoMemory, stopSession, deleteSession, getDiff, getSession, getTree, openPullRequest, readFile, resolvePending, restoreCheckpoint, saveFile, updateSession } from "@/lib/app.functions";
import type { AgentEvent, ChatMessage, PendingChange, ToolLog } from "@/lib/providers";
import { pageMeta } from "@/lib/page-meta";
import { McpActionApprovals } from "@/components/McpActionApprovals";
import { TerminalDeck } from "@/components/TerminalDeck";
import { DeployPanel } from "@/components/DeployPanel";
import { ModelSwitcher } from "@/components/ModelSwitcher";
import { SwarmMatrix } from "@/components/SwarmMatrix";
import { KnowledgeDirector } from "@/components/KnowledgeDirector";
import { FileWorkbench } from "@/components/FileWorkbench";
import { MAX_PROMPT_CHARS, promptCapacity, promptError } from "@/lib/agent-request";
import { STALE_MS, taskRunStatus } from "@/lib/task-run-status";
import { ATTACH_ACCEPT, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, attachmentType } from "@/lib/agent-request";
import { SharedFiles } from "@/components/SharedFiles";
import { DatabaseApproval } from "@/components/DatabaseApproval";
import { TaskInteractions } from "@/components/TaskInteractions";
import { createAgentEventDecoder } from "@/lib/agent-stream";

export const Route = createFileRoute("/_authenticated/s/$id")({
  head: () => ({ meta: pageMeta("Task — Forge", "Review your coding agent's conversation, files and proposed changes.") }),
  component: Workspace,
});

type PanelKey = "preview" | "chat" | "swarm" | "run" | "knowledge" | "changes" | "deploy" | "terminal" | "files";
// Simple by default: Preview and Deploy up front, everything advanced under "More".
const MAIN = [["preview", "Preview", Globe], ["deploy", "Deploy", Rocket]] as const;
const MORE = [
  ["changes", "Changes", GitCompare], ["files", "Files", FolderTree], ["terminal", "Terminal", TerminalSquare],
  ["run", "Run timeline", Activity], ["swarm", "Agents", Network], ["knowledge", "Knowledge", BookOpen],
] as const;
const ALL = [...MAIN, ...MORE];

function useIsDesktop() {
  const [d, setD] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setD(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return d;
}

function Workspace() {
  const desktop = useIsDesktop();
  const [view, setView] = useState<PanelKey>("chat");
  const [right, setRight] = useState<PanelKey | null>("preview");
  const [moreOpen, setMoreOpen] = useState(false);
  const [dockPct, setDockPct] = useState(46);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => setDockPct(Math.min(75, Math.max(25, ((window.innerWidth - ev.clientX) / window.innerWidth) * 100)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const fetchSession = useServerFn(getSession);
  const update = useServerFn(updateSession);
  const remove = useServerFn(deleteSession);
  const stop = useServerFn(stopSession);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const session = useQuery({
    queryKey: ["session", id],
    queryFn: () => fetchSession({ data: { id } }),
    // While a run continues in the background (tab was closed/reopened), follow its saved progress.
    refetchInterval: running ? false : 3000,
  });
  const sd = session.data;
  // The server beats every 30s while alive; no beat for 2 min means the run died (e.g. hosting cut it off).
  const [, force] = useState(0);
  useEffect(() => { if (!sd?.running || running) return; const t = setInterval(() => force((n) => n + 1), 5000); return () => clearInterval(t); }, [sd?.running, running]);
  // Keep the phone screen awake while a run streams: a sleeping phone drops the connection and the run is cut off.
  useEffect(() => {
    if (!running) return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    const get = () => { if (document.visibilityState === "visible") nav.wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => {}); };
    get();
    const onVis = () => { get(); if (document.visibilityState === "visible") void qc.invalidateQueries({ queryKey: ["session", id] }); };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); void lock?.release().catch(() => {}); };
  }, [running, qc, id]);
  // Cloud-kept runs: notify when the saved run flips from running to finished.
  const wasBgRunning = useRef(false);
  useEffect(() => {
    if (wasBgRunning.current && !sd?.running && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Forge", { body: "Your agent finished." });
    wasBgRunning.current = !!sd?.running;
  }, [sd?.running]);
  const stale = !!sd?.running && !!sd.updated_at && Date.now() - new Date(sd.updated_at).getTime() > STALE_MS;
  const bgRunning = !running && !!sd?.running && !stale;
  const runStart = useRef<number>(0);
  const runPlan = useRef(false);
  const [images, setImages] = useState<{ mediaType: string; data: string; name: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  async function addImages(files: FileList | null) {
    for (const f of Array.from(files ?? []).slice(0, MAX_ATTACHMENTS - images.length)) {
      const type = attachmentType(f.name, f.type);
      if (!type || f.size > MAX_ATTACHMENT_BYTES) { toast.error(`${f.name}: use images, PDF, TXT, MD, CSV or JSON under 10 MB`); continue; }
      const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = rej; r.readAsDataURL(f); });
      setImages((x) => [...x, { mediaType: type, data, name: f.name }]);
    }
  }

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [input, setInput] = useState("");
  useEffect(() => {
    const key = `forge:draft:${id}`;
    const saved = sessionStorage.getItem(key);
    if (saved) { setInput(saved); sessionStorage.removeItem(key); }
  }, [id]);
  // Preserve an in-progress mobile prompt across accidental reloads or app/browser exits.
  useEffect(() => {
    const key = `forge:draft:${id}`;
    try {
      if (input.trim()) sessionStorage.setItem(key, input);
      else sessionStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in private/restricted browser contexts; composing still works.
    }
  }, [id, input]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [streamInterrupted, setStreamInterrupted] = useState(false);
  const capacity = promptCapacity(input);
  const [planMode, setPlanMode] = useState(false);
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const sendLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);
  const lastWasPlan = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (session.data && !running) {
      setMessages(session.data.messages ?? []);
      setPending(session.data.pending ?? []);
      setUsage(((session.data as { usage?: { input: number; output: number } }).usage) ?? { input: 0, output: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.data]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, pending.length]);
  useEffect(() => { taRef.current?.focus(); }, [running]);
  useEffect(() => { if (!running && !sd?.running) setStopping(false); }, [running, sd?.running]);

  async function stopWork() {
    if (stopping) return;
    manualStopRef.current = true;
    setStopping(true);
    try {
      await stop({ data: { id } });
      abortRef.current?.abort();
      setRunning(false);
      await qc.invalidateQueries({ queryKey: ["session", id] });
    } catch (error) {
      setStopping(false);
      toast.error(`Could not stop: ${(error as Error).message}. Try again.`);
    }
  }

  // A run that dies silently (server cut off) is resumed automatically, at most 3 times per visit.
  const autoResumes = useRef(0);
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!stale || running || stopping || manualStopRef.current || sd?.stop_requested || !sd?.updated_at) return;
    if (resumedFor.current === sd.updated_at || autoResumes.current >= 3) return;
    resumedFor.current = sd.updated_at;
    autoResumes.current++;
    toast.info(`The run was cut off — resuming automatically (${autoResumes.current}/3)`);
    void send("continue (the previous run was cut off; resume from saved progress, avoid repeating finished steps)");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, running, stopping, sd?.updated_at]);


  async function send(override?: string, forcePlan?: boolean) {
    let text = (override ?? input).trim();
    // State updates render asynchronously; this ref closes the same-tick double-submit race.
    if (!text || running || bgRunning || sendLockRef.current) return;
    manualStopRef.current = false;
    let plan = forcePlan ?? planMode;
    runStart.current = Date.now();
    const cmd = text.match(/^\/(\w+)\s*([\s\S]*)$/);
    if (cmd) {
      const [, name, rest] = cmd;
      if (name === "plan") { plan = true; text = rest || "Make a plan for the next step."; }
      else if (name === "test") text = `Run the project's tests/typecheck/build in the sandbox. Fix any failures and re-run until they pass. ${rest}`.trim();
      else if (name === "review") text = `Review the changes on this task branch versus the base branch for bugs, security issues and missing tests. Do not edit files; list findings by severity. ${rest}`.trim();
      else if (name === "explain") text = `Explain how this part of the codebase works, citing files: ${rest || "overall architecture"}`;
      else if (name === "help") { toast.info("Commands: /plan, /test, /review, /explain"); setInput(""); return; }
    }
    const validationError = promptError(text);
    if (validationError) { setSendError(validationError); return; }
    sendLockRef.current = true;
    setSendError(null);
    setStreamInterrupted(false);
    const sentImages = images;
    let accepted = false;
    setInput("");
    setImages([]);
    if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    setRunning(true);
    lastWasPlan.current = plan;
    setMessages((m) => [...m, { role: "user", content: sentImages.length ? `${text}\n\n📎 ${sentImages.map((im) => im.name).join(", ")}` : text }, { role: "assistant", content: "", tools: [] }]);
    const patchLast = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((ms) => { const last = ms.at(-1); return last ? [...ms.slice(0, -1), fn(last)] : ms; });
    const ac = new AbortController();
    abortRef.current = ac;
    let backgrounded = false;
    try {
      // A fresh token gives the cloud-kept run a full hour of access.
      const refreshed = await supabase.auth.refreshSession().catch(() => null);
      const token = refreshed?.data.session?.access_token ?? (await supabase.auth.getSession()).data.session?.access_token;
      const body = JSON.stringify((runPlan.current = plan, { sessionId: id, message: text, plan, images: sentImages.map(({ mediaType, data, name }) => ({ mediaType, data, name })) }));
      // Prefer a cloud-kept run so work continues when the phone sleeps or switches apps.
      const bg = await fetch("/api/agent-background", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body, signal: ac.signal });
      if (!bg.ok) throw new Error(await bg.text());
      if ((await bg.json() as { mode?: string }).mode === "background") {
        accepted = true;
        backgrounded = true;
        toast.success("Running in the cloud — you can switch apps or lock your phone.");
        return;
      }
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      accepted = true;
      const reader = res.body.getReader();
      const decoder = createAgentEventDecoder();
      let receivedDoneEvent = false;
      let receivedErrorEvent = false;
      for (;;) {
        const { done, value } = await reader.read();
        const events = done ? decoder.finish() : decoder.push(value!);
        for (const e of events) {
          if (e.t === "text") patchLast((m) => ({ ...m, content: m.content + e.d }));
          else if (e.t === "tool")
            patchLast((m) => ({
              ...m,
              content: "",
              tools: [
                ...(m.tools ?? []),
                ...(m.content.trim() ? [{ id: `note-${e.id}`, name: "note", input: {}, ok: true, summary: m.content.trim() }] : []),
                { id: e.id, name: e.name, input: e.input },
              ],
            }));
          else if (e.t === "tool-result")
            patchLast((m) => ({ ...m, tools: m.tools?.map((t) => (t.id === e.id ? { ...t, ok: e.ok, summary: e.summary } : t)) }));
          else if (e.t === "progress")
            patchLast((m) => ({ ...m, tools: m.tools?.map((t) => (t.id === e.id ? { ...t, summary: e.summary } : t)) }));
          else if (e.t === "pending") setPending([...e.pending]);
          else if (e.t === "usage") setUsage({ input: ((session.data as { usage?: { input: number } } | undefined)?.usage?.input ?? 0) + e.input, output: ((session.data as { usage?: { output: number } } | undefined)?.usage?.output ?? 0) + e.output });
          else if (e.t === "error") {
            receivedErrorEvent = true;
            setSendError(e.m);
            // The server reported a terminal run error even though the transport may close cleanly.
            // Offer the same safe continuation used for interrupted streams; never replay the prompt.
            setStreamInterrupted(true);
            patchLast((m) => ({ ...m, content: `${m.content}\n\n${e.m}` }));
            toast.error(e.m);
          }
          if (e.t === "done") receivedDoneEvent = true;
        }
        if (done) break;
      }
      // A clean EOF is not proof the agent finished: the API emits an explicit done event.
      if (!receivedDoneEvent && !receivedErrorEvent) {
        const detail = "The agent stream ended before completion was confirmed. Your saved progress is preserved; continue from the latest state.";
        setSendError(detail);
        setStreamInterrupted(true);
        toast.error("Agent connection ended before completion.");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const detail = (err as Error).message;
        setSendError(detail);
        toast.error(detail);
        if (!accepted) {
          setInput(text);
          setImages(sentImages);
          setMessages((ms) => ms.slice(0, -2));
        } else {
          // Server-side actions may have completed before the stream disconnected.
          // Do not replay the original prompt automatically; offer a safe continuation.
          setStreamInterrupted(true);
        }
      }
    } finally {
      sendLockRef.current = false;
      setRunning(false);
      abortRef.current = null;
      if (!backgrounded && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Forge", { body: "Your agent finished." });
      qc.invalidateQueries({ queryKey: ["session", id] });
      qc.invalidateQueries({ queryKey: ["diff", id] });
      qc.invalidateQueries({ queryKey: ["tree", id] });
      qc.invalidateQueries({ queryKey: ["mcp-actions", id] });
    }
  }

  const s = session.data;
  const autoFixSend = (prompt: string) => { if (!desktop) setView("chat"); void send(prompt, false); };
  const renderPanel = (k: PanelKey) => {
    if (!s) return null;
    switch (k) {
      case "swarm": return <SwarmMatrix messages={messages} usage={usage} model={s.model} running={running || bgRunning} />;
      case "run": return <RunTimeline sessionId={id} repo={s.repo} running={running || bgRunning} />;
      case "knowledge": return <KnowledgeDirector id={id} repo={s.repo} />;
      case "deploy": return <DeployPanel id={id} onSend={autoFixSend} />;
      case "preview": return <PreviewPanel id={id} agentBusy={running || bgRunning || stopping} onSend={async (prompt) => { if (!desktop) setView("chat"); await send(prompt, false); }} />;
      case "terminal": return <TerminalDeck id={id} />;
      case "files": return <FileWorkbench id={id} />;
      case "changes": return (
        <>
          <ChangesView id={id} pending={pending} onResolved={(rem) => { setPending(rem ?? []); qc.invalidateQueries({ queryKey: ["diff", id] }); qc.invalidateQueries({ queryKey: ["tree", id] }); }} />
          <MemoryView repo={s.repo} />
          <div className="px-3 pb-8">
            <Button variant="ghost" size="sm" className="text-destructive" onClick={async () => {
              if (!confirm("Delete this task from Forge? The GitHub branch and commits will remain untouched.")) return;
              try {
                await remove({ data: { id } });
                toast.success("Task deleted");
                nav({ to: "/app" });
              } catch (error) {
                toast.error("Could not delete task: " + (error as Error).message);
              }
            }}>
              <Trash2 /> Delete task (branch stays on GitHub)
            </Button>
          </div>
        </>
      );
      default: return null;
    }
  };
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader>
        {s && (
          <div className="flex min-w-0 max-w-[50vw] items-center gap-2 overflow-x-auto text-xs sm:max-w-none">
            <span className="hidden truncate font-mono text-muted-foreground md:inline">{s.repo} · {s.work_branch}</span>
            <select
              aria-label="Autonomy level"
              title={AUTONOMY_LABEL[asAutonomy(s.mode)].hint}
              className="h-7 shrink-0 rounded border bg-background px-1 font-mono text-xs hover:border-primary"
              value={asAutonomy(s.mode)}
              onChange={async (e) => {
                const nextMode = e.target.value as Autonomy;
                try {
                  await update({ data: { id, mode: nextMode } });
                  toast.success("Autonomy level updated");
                  await qc.invalidateQueries({ queryKey: ["session", id] });
                } catch (error) {
                  toast.error("Could not update autonomy: " + (error as Error).message);
                  await qc.invalidateQueries({ queryKey: ["session", id] });
                }
              }}
            >
              {AUTONOMY.map((a) => <option key={a} value={a}>{AUTONOMY_LABEL[a].title}</option>)}
            </select>
            <ModelSwitcher id={id} credentialId={s.credential_id} model={s.model} fallbackModel={s.fallback_model ?? null} profile={s.reasoning_profile ?? "auto"} codingModel={s.coding_model ?? null} reviewerModel={s.reviewer_model ?? null} disabled={running || bgRunning} />
            {desktop && <AutoFixButton id={id} onSend={autoFixSend} disabled={running || bgRunning} />}
            {usage.input + usage.output > 0 && (
              <span className="hidden shrink-0 items-center gap-1 font-mono text-muted-foreground sm:flex" title="Tokens used by this task (input / output)">
                <Coins className="h-3 w-3" />{fmt(usage.input)} / {fmt(usage.output)}
              </span>
            )}
          </div>
        )}
      </AppHeader>
      {!s && (
        <main className="mx-auto flex w-full max-w-xl flex-1 items-center justify-center p-5">
          <section className="w-full rounded-xl border bg-card p-5 text-center">
            {session.isLoading ? (
              <><Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" /><h1 className="font-semibold">Opening your workspace…</h1><p className="mt-1 text-sm text-muted-foreground">Loading the task, conversation and saved progress.</p></>
            ) : (
              <><h1 className="font-semibold">Could not open this task</h1><p role="alert" className="mt-2 break-words text-sm text-muted-foreground">{(session.error as Error | null)?.message ?? "This task may have been deleted or you may not have access."}</p><div className="mt-4 flex justify-center gap-2"><Button variant="outline" onClick={() => nav({ to: "/app" })}>Back to workspace</Button><Button onClick={() => session.refetch()} disabled={session.isFetching}>{session.isFetching ? <Loader2 className="animate-spin" /> : "Try again"}</Button></div></>
            )}
          </section>
        </main>
      )}
      <div className={`${!s ? "hidden " : ""}flex min-h-0 flex-1`}>
        <section className={`${!desktop && view !== "chat" ? "hidden" : "flex"} min-w-0 flex-1 flex-col`}>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
            <div className="mx-auto max-w-3xl space-y-5">
              {messages.length === 0 && (
                <div className="py-10 text-center sm:py-16">
                  <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-accent text-primary shadow-glow"><Sparkles className="h-5 w-5" /></div>
                  <h2 className="text-gradient text-xl font-semibold">What should we build?</h2>
                  <p className="mt-1 text-sm text-muted-foreground">Work happens on <span className="font-mono text-foreground">{s?.work_branch}</span> — your base branch stays untouched.</p>
                  <div className="mt-6 grid gap-2 text-left sm:grid-cols-2">
                    {[
                      ["Map the codebase", "/explain overall architecture and key modules"],
                      ["Run & fix checks", "/test"],
                      ["Review for bugs", "/review"],
                      ["Plan a feature", "/plan "],
                    ].map(([t, p]) => (
                      <button key={t} type="button" onClick={() => { setInput(p ?? ""); taRef.current?.focus(); }}
                        className="panel px-4 py-3 text-sm transition-colors hover:border-primary">
                        <span className="font-medium">{t}</span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{p}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) => (
                <MessageView key={i} sessionId={id} m={m} live={running && i === messages.length - 1} />
              ))}
              <PendingApprovals id={id} pending={pending} onResolved={(rem) => { setPending(rem); void qc.invalidateQueries({ queryKey: ["session", id] }); void qc.invalidateQueries({ queryKey: ["diff", id] }); void qc.invalidateQueries({ queryKey: ["tree", id] }); }} />
              <McpActionApprovals sessionId={id} chat />
              <DatabaseApproval id={id} busy={running || bgRunning || stopping} />
              <TaskInteractions sessionId={id} busy={running || bgRunning || stopping} onSend={(m) => send(m, false)} />
              {!running && messages.at(-1)?.role === "assistant" && lastWasPlan.current && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => { lastWasPlan.current = false; setPlanMode(false); send("The plan is approved. Implement it now, then verify with tests.", false); }}><Check /> Approve plan & build</Button>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>
          <form className="glass border-t p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <div className="mx-auto mb-2 flex max-w-3xl items-center gap-1.5 overflow-x-auto text-xs">
              {!desktop && <AutoFixButton id={id} onSend={autoFixSend} disabled={running || bgRunning} />}
              <button type="button" onClick={() => setPlanMode(!planMode)} aria-pressed={planMode}
                className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 ${planMode ? "border-primary bg-accent text-primary" : "text-muted-foreground"}`}>
                <ListChecks className="h-3 w-3" /> Plan first
              </button>
              {["/test", "/review", "/explain", "/plan"].map((c) => (
                <button key={c} type="button" onClick={() => { setInput((v) => (v.startsWith("/") ? v.replace(/^\/\w+\s*/, "") : v) ? `${c} ${v.replace(/^\/\w+\s*/, "")}` : `${c} `); taRef.current?.focus(); }}
                  className="shrink-0 rounded-full border px-2.5 py-1 font-mono text-muted-foreground transition-colors hover:border-primary hover:text-primary">{c}</button>
              ))}
            </div>
            {(running || bgRunning) && (
              <RunStatus
                start={running ? runStart.current : null}
                lastUpdate={running ? null : sd?.updated_at ?? null}
                steps={(messages.at(-1)?.role === "assistant" ? messages.at(-1)?.tools ?? [] : []).filter((t) => t.name !== "note" && t.ok !== undefined).length}
                limit={running && runPlan.current ? 20 : 50}
                background={bgRunning}
                cloud={taskRunStatus(sd ?? {}) === "cloud"}
                stopping={stopping}
                onStop={stopWork}
              />
            )}
            {stale && !running && <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs"><p className="min-w-0 flex-1 text-foreground">No progress update for over 2 minutes. Your saved work is safe. {autoResumes.current >= 3 ? "Automatic recovery has reached its limit." : "Forge is checking whether the run can recover."}</p><Button type="button" size="sm" variant="outline" onClick={() => void session.refetch()} disabled={session.isFetching}>Check status</Button>{autoResumes.current >= 3 && <Button type="button" size="sm" onClick={() => { autoResumes.current = 0; resumedFor.current = null; void send("Continue from the latest saved progress. First inspect the current state and completed work; do not repeat completed steps."); }}>Resume task</Button>}<Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={stopping} onClick={stopWork}><Square className="h-3 w-3" />{stopping ? "Stopping…" : "Stop run"}</Button></div>}
            {sendError && <div role="alert" className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 text-sm"><p className="min-w-0 flex-1 break-words text-destructive">{sendError}</p>{streamInterrupted && <Button type="button" size="sm" variant="outline" disabled={running || bgRunning} onClick={() => void send("The previous response stream disconnected. Inspect the current repository and task state, identify what was completed, then continue only unfinished work. Do not repeat completed actions.")}>Continue from saved progress</Button>}</div>}
            {images.length > 0 && (
              <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
                {images.map((im, i) => (
                  <span key={i} className="relative">
                    {im.mediaType.startsWith("image/")
                      ? <img src={`data:${im.mediaType};base64,${im.data}`} alt={im.name} className="h-14 w-14 rounded border object-cover" />
                      : <span className="flex h-14 max-w-40 items-center gap-1.5 rounded border bg-secondary px-2 text-xs"><FileText className="h-4 w-4 shrink-0 text-primary" /><span className="truncate">{im.name}</span></span>}
                    <button type="button" aria-label={`Remove ${im.name}`} className="absolute -right-1 -top-1 rounded-full border bg-background p-0.5" onClick={() => setImages((x) => x.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <Textarea
                ref={taRef}
                aria-label="Task prompt"
                aria-describedby="prompt-capacity"
                aria-invalid={capacity.overLimit}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={planMode ? "Describe the task — the agent will plan first" : "e.g. Add a dark-mode toggle to the header"}
                className="max-h-48 min-h-11 text-base resize-none md:text-sm"
                rows={1}
              />
              <input ref={fileRef} type="file" accept={ATTACH_ACCEPT} multiple hidden onChange={(e) => { addImages(e.target.files); e.target.value = ""; }} />
              <Button type="button" size="icon" variant="ghost" aria-label="Attach image or document" className="min-h-11 min-w-11" disabled={images.length >= MAX_ATTACHMENTS} onClick={() => fileRef.current?.click()}><ImagePlus /></Button>
              {running || bgRunning ? (
                <Button type="button" size="icon" variant="secondary" aria-label="Stop" className="min-h-11 min-w-11" disabled={stopping} onClick={stopWork}><Square /></Button>
              ) : (
                <Button size="icon" className="min-h-11 min-w-11" aria-label="Send" disabled={!input.trim() || capacity.overLimit}><Send /></Button>
              )}
            </div>
            <div id="prompt-capacity" className={`mx-auto mt-2 flex max-w-3xl flex-wrap justify-between gap-x-3 gap-y-1 text-xs ${capacity.overLimit || capacity.nearLimit ? "text-destructive" : "text-muted-foreground"}`}>
              <span className="tabular-nums">{capacity.used.toLocaleString("en-US")} / {MAX_PROMPT_CHARS.toLocaleString("en-US")} characters</span>
              <span role={capacity.nearLimit || capacity.overLimit ? "status" : undefined} className="tabular-nums">{capacity.overLimit ? `${Math.abs(capacity.remaining).toLocaleString("en-US")} over limit — shorten before sending` : `${capacity.remaining.toLocaleString("en-US")} remaining${capacity.nearLimit ? " — nearing limit" : ""}`}</span>
            </div>
          </form>
        </section>
        {desktop && right && (
          <aside className="relative flex min-h-0 flex-col border-l bg-card/30" style={{ width: `${dockPct}%` }}>
            <div role="separator" aria-label="Resize panels" onPointerDown={startResize} className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-primary/30" />
            <div className="flex items-center gap-1 border-b px-2 py-1.5">
              {MAIN.map(([k, label, Icon]) => (
                <button key={k} type="button" onClick={() => setRight(k)} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${right === k ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`}><Icon className="h-3.5 w-3.5" />{label}</button>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={`relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${MORE.some((m) => m[0] === right) ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                    <MoreHorizontal className="h-3.5 w-3.5" />{MORE.find((m) => m[0] === right)?.[1] ?? "More"}
                    {pending.length > 0 && <span className="rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">{pending.length}</span>}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {MORE.map(([k, label, Icon]) => (
                    <DropdownMenuItem key={k} onSelect={() => setRight(k)}><Icon className="h-4 w-4" />{label}{k === "changes" && pending.length > 0 && <span className="ml-auto text-xs text-primary">{pending.length}</span>}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <button type="button" aria-label="Close dock" onClick={() => setRight(null)} className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground"><PanelRightClose className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{renderPanel(right)}</div>
          </aside>
        )}
        {desktop && !right && (
          <button type="button" onClick={() => setRight("preview")} className="flex w-10 shrink-0 flex-col items-center gap-2 border-l bg-card/30 py-3 text-xs text-muted-foreground hover:text-foreground" aria-label="Open side panel"><Globe className="h-4 w-4" /></button>
        )}
        {!desktop && view !== "chat" && <div className="min-h-0 flex-1 overflow-y-auto">{renderPanel(view)}</div>}
      </div>
      {!desktop && (
        <nav className="glass flex shrink-0 overflow-x-auto border-t px-1 pb-[env(safe-area-inset-bottom)]" aria-label="Workspace panels">
          {([["chat", "Chat", MessageSquare] as const, ...MAIN]).map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => setView(k)} className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${view === k ? "text-primary" : "text-muted-foreground"}`}>
              <Icon className="h-5 w-5" />{label}
              {k === "chat" && (running || bgRunning) && <span className="absolute right-1/3 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
            </button>
          ))}
          <button type="button" onClick={() => setMoreOpen(true)} className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${MORE.some((m) => m[0] === view) ? "text-primary" : "text-muted-foreground"}`}>
            <MoreHorizontal className="h-5 w-5" />{MORE.find((m) => m[0] === view)?.[1] ?? "More"}
            {pending.length > 0 && <span className="absolute right-1/4 top-1 rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">{pending.length}</span>}
          </button>
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetContent side="bottom" className="pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              <SheetHeader><SheetTitle>More tools</SheetTitle></SheetHeader>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {MORE.map(([k, label, Icon]) => (
                  <button key={k} type="button" onClick={() => { setView(k); setMoreOpen(false); }} className={`relative flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs ${view === k ? "border-primary text-primary" : "text-muted-foreground"}`}>
                    <Icon className="h-5 w-5" />{label}
                    {k === "changes" && pending.length > 0 && <span className="absolute right-2 top-2 rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">{pending.length}</span>}
                  </button>
                ))}
              </div>
            </SheetContent>
          </Sheet>
        </nav>
      )}
    </div>
  );
}

function MessageView({ m, live, sessionId }: { m: ChatMessage; live: boolean; sessionId: string }) {
  if (m.role === "user")
    return <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-4 py-2.5 text-sm">{m.content}</div>;
  return (
    <div className="space-y-2 text-sm">
      {!!m.tools?.length && <ActivityView tools={m.tools} live={live} />}
      {m.content && <div className="prose-agent"><ReactMarkdown>{m.content}</ReactMarkdown></div>}
      <SharedFiles sessionId={sessionId} tools={m.tools ?? []} />
      {live && !m.content && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
    </div>
  );
}

function ActivityView({ tools, live }: { tools: ToolLog[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const busy = live && tools.some((t) => t.ok === undefined);
  const failed = tools.filter((t) => t.ok === false).length;
  const current = [...tools].reverse().find((t) => t.ok === undefined);
  const workers = live ? tools.filter((t) => t.name === "worker" && t.ok === undefined).length : 0;
  return (
    <div className="rounded-md border bg-muted/30 text-xs">
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground" onClick={() => setOpen(!open)}>
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
        {busy ? <Loader2 className="h-3 w-3 animate-spin text-primary" /> : <Wrench className="h-3 w-3" />}
        <span>{busy ? (workers > 0 ? `${workers} helpers working in parallel…` : `Working… ${current ? current.name : ""}`) : `Background activity · ${tools.filter((t) => t.name !== "note").length} steps`}</span>
        {failed > 0 && <span className="text-destructive">{failed} failed</span>}
      </button>
      {open && <div className="space-y-1 border-t p-2">{tools.map((t) => <ToolView key={t.id} t={t} />)}</div>}
    </div>
  );
}

function ToolView({ t }: { t: ToolLog }) {
  const [open, setOpen] = useState(false);
  if (t.name === "note") return <p className="px-1 py-0.5 text-xs italic text-muted-foreground">{t.summary}</p>;
  const arg = (t.input as { path?: string; prefix?: string; query?: string }) ?? {};
  const label = arg.path ?? arg.query ?? (arg.prefix || "/");
  return (
    <div className="rounded-md border bg-muted/40 font-mono text-xs">
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="text-primary">{t.name === "worker" ? "helper" : t.name}</span>
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="ml-auto">
          {t.ok === undefined ? <Loader2 className="h-3 w-3 animate-spin" /> : t.ok ? <Check className="h-3 w-3 text-success" /> : <X className="h-3 w-3 text-destructive" />}
        </span>
      </button>
      {t.name === "worker" && t.ok === undefined && t.summary && !open && <p className="truncate border-t px-3 py-1 text-muted-foreground">{t.summary}</p>}
      {open && <pre className="max-h-60 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-muted-foreground">{t.summary ?? "running…"}</pre>}
    </div>
  );
}

function FilesView({ id }: { id: string }) {
  const fetchTree = useServerFn(getTree);
  const fetchFile = useServerFn(readFile);
  const tree = useQuery({ queryKey: ["tree", id], queryFn: () => fetchTree({ data: { id } }) });
  const [path, setPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const file = useQuery({ queryKey: ["file", id, path], queryFn: () => fetchFile({ data: { id, path: path! } }), enabled: !!path });
  const save = useServerFn(saveFile);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [path]);
  const saveM = useMutation({
    mutationFn: () => save({ data: { id, path: path!, content: draft ?? "", message: `edit ${path}` } }),
    onSuccess: () => {
      toast.success("Committed to task branch");
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["file", id, path] });
      qc.invalidateQueries({ queryKey: ["diff", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const files = tree.data?.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className={`flex min-h-0 flex-col border-r md:w-72 ${path ? "hidden md:flex" : "flex flex-1 md:flex-none"}`}>
        <input className="m-2 rounded-md border bg-background px-2 py-1.5 text-sm" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ul className="min-h-0 flex-1 overflow-y-auto pb-4 font-mono text-xs">
          {tree.isLoading && <li className="px-3 text-muted-foreground">Loading…</li>}
          {tree.error && <li className="px-3 text-destructive">{(tree.error as Error).message}</li>}
          {files.slice(0, 1000).map((f) => (
            <li key={f}>
              <button onClick={() => setPath(f)} className={`flex w-full items-center gap-1.5 truncate px-3 py-1 text-left hover:bg-accent ${f === path ? "bg-accent text-primary" : ""}`}>
                <FileCode className="h-3 w-3 shrink-0" /> <span className="truncate">{f}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {path && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2 font-mono text-xs">
            <button className="md:hidden" onClick={() => setPath(null)}>← </button>
            <span className="flex-1 truncate">{path}</span>
            {draft === null ? (
              <Button size="sm" variant="ghost" disabled={typeof file.data !== "string"} onClick={() => setDraft(file.data ?? "")}><Pencil /> Edit</Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <Button size="sm" disabled={saveM.isPending || draft === file.data} onClick={() => saveM.mutate()}><Save /> Commit</Button>
              </>
            )}
          </div>
          {draft !== null ? (
            <textarea
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  const t = e.currentTarget, a = t.selectionStart;
                  setDraft(draft.slice(0, a) + "  " + draft.slice(t.selectionEnd));
                  requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 2; });
                }
              }}
              className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-xs leading-relaxed outline-none"
            />
          ) : (
            <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
              {file.isLoading ? "Loading…" : file.data ?? "(file not found)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PendingApprovals({ id, pending, onResolved }: { id: string; pending: PendingChange[]; onResolved: (remaining: PendingChange[]) => void }) {
  const resolve = useServerFn(resolvePending);
  const resolveM = useMutation({
    mutationFn: (v: { approve: boolean; paths?: string[] }) => resolve({ data: { id, ...v } }),
    onSuccess: (r) => { toast.success(r.committed.length ? `Committed ${r.committed.length} file(s)` : "Discarded"); onResolved(r.remaining as PendingChange[]); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!pending.length) return null;
  return <section className="space-y-2" aria-label="File and data change approvals" aria-live="polite">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="flex-1 font-semibold">Changes awaiting approval · {pending.length}</h3>
      <Button size="sm" variant="outline" onClick={() => resolveM.mutate({ approve: false })} disabled={resolveM.isPending}><X /> Reject all</Button>
      <Button size="sm" onClick={() => resolveM.mutate({ approve: true })} disabled={resolveM.isPending}><Check /> Approve & commit</Button>
    </div>
    {pending.map((c) => <PendingView key={c.path} c={c} busy={resolveM.isPending} onAccept={() => resolveM.mutate({ approve: true, paths: [c.path] })} onReject={() => resolveM.mutate({ approve: false, paths: [c.path] })} />)}
  </section>;
}

function ChangesView({ id, pending, onResolved }: { id: string; pending: PendingChange[]; onResolved: (remaining?: PendingChange[]) => void }) {
  const fetchDiff = useServerFn(getDiff);
  const pr = useServerFn(openPullRequest);
  const diff = useQuery({ queryKey: ["diff", id], queryFn: () => fetchDiff({ data: { id } }) });
  const restore = useServerFn(restoreCheckpoint);
  const restoreM = useMutation({
    mutationFn: (sha: string) => restore({ data: { id, sha } }),
    onSuccess: () => { toast.success("Branch restored"); onResolved(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const prM = useMutation({
    mutationFn: () => pr({ data: { id } }),
    onSuccess: (url) => { toast.success("Pull request opened"); window.open(url, "_blank", "noopener"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-3">
      <McpActionApprovals sessionId={id} />
      <PendingApprovals id={id} pending={pending} onResolved={onResolved} />
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="flex-1 font-semibold">Committed on branch</h3>
          <Button size="sm" variant="outline" disabled={!diff.data?.ahead_by || prM.isPending} onClick={() => prM.mutate()}><GitPullRequest /> Open pull request</Button>
        </div>
        {diff.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {diff.data && diff.data.commits.length > 0 && (
          <div className="mb-4 rounded-md border bg-card">
            <p className="flex items-center gap-2 border-b px-3 py-2 text-xs font-semibold text-muted-foreground"><History className="h-3 w-3" /> Checkpoints</p>
            <ul className="divide-y text-xs">
              {[...diff.data.commits].reverse().map((c, i) => (
                <li key={c.sha} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="font-mono text-muted-foreground">{c.sha.slice(0, 7)}</span>
                  <span className="flex-1 truncate">{c.message.split("\n")[0]}</span>
                  {i > 0 && (
                    <Button size="sm" variant="ghost" disabled={restoreM.isPending}
                      onClick={() => confirm("Rewind the task branch to this point? Later commits are removed from the branch.") && restoreM.mutate(c.sha)}>
                      Restore
                    </Button>
                  )}
                </li>
              ))}
              <li className="flex items-center gap-2 px-3 py-1.5">
                <span className="font-mono text-muted-foreground">{diff.data.base_sha.slice(0, 7)}</span>
                <span className="flex-1 truncate text-muted-foreground">Start (base branch)</span>
                <Button size="sm" variant="ghost" disabled={restoreM.isPending}
                  onClick={() => confirm("Undo all of this task's commits?") && restoreM.mutate(diff.data!.base_sha)}>
                  Undo all
                </Button>
              </li>
            </ul>
          </div>
        )}
        {diff.data && diff.data.files.length === 0 && <p className="text-sm text-muted-foreground">No commits yet.</p>}
        <div className="space-y-3">
          {diff.data?.files.map((f) => <DiffFile key={f.filename} filename={f.filename} status={f.status} patch={f.patch} />)}
        </div>
      </section>
    </div>
  );
}

function DiffFile({ filename, status, patch }: { filename: string; status: string; patch: string }) {
  const [open, setOpen] = useState(true);
  const lines = patch.split("\n");
  const add = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const del = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return (
    <div className="panel overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b bg-muted/60 px-3 py-2 text-left font-mono text-xs">
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="truncate"><span className="mr-2 rounded border px-1 py-px text-[10px] uppercase text-muted-foreground">{status}</span>{filename}</span>
        <span className="shrink-0 tabular-nums"><span className="text-success">+{add}</span> <span className="text-destructive">−{del}</span></span>
      </button>
      {open && <PatchView patch={patch} />}
    </div>
  );
}

function PatchView({ patch }: { patch: string }) {
  // Track old/new line numbers from hunk headers for a gutter.
  let o = 0, n = 0;
  const rows = patch.split("\n").map((l) => {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) { o = Number(h[1] ?? 0); n = Number(h[2] ?? 0); return { l, a: "", b: "", k: "h" }; }
    if (l.startsWith("+")) return { l, a: "", b: String(n++), k: "+" };
    if (l.startsWith("-")) return { l, a: String(o++), b: "", k: "-" };
    return { l, a: String(o++), b: String(n++), k: " " };
  });
  return (
    <pre className="max-h-[28rem] overflow-auto font-mono text-xs leading-5">
      {rows.map((r, i) => (
        <div key={i} className={`grid grid-cols-[2.5rem_2.5rem_minmax(0,1fr)] ${r.k === "+" ? "bg-added" : r.k === "-" ? "bg-removed" : r.k === "h" ? "bg-muted/50 text-primary/80" : ""}`}>
          <span className="select-none border-r pr-1 text-right text-muted-foreground/60">{r.a}</span>
          <span className="select-none border-r pr-1 text-right text-muted-foreground/60">{r.b}</span>
          <span className="whitespace-pre px-3">{r.l || " "}</span>
        </div>
      ))}
    </pre>
  );
}

function simpleDiff(a: string, b: string) {
  // Line-level diff via LCS (bounded for large files).
  const x = a.split("\n"), y = b.split("\n");
  if (x.length * y.length > 4_000_000) return [...x.map((l) => "-" + l), ...y.map((l) => "+" + l)].join("\n");
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push(" " + x[i]); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push("-" + x[i++]);
    else out.push("+" + y[j++]);
  }
  while (i < x.length) out.push("-" + x[i++]);
  while (j < y.length) out.push("+" + y[j++]);
  return out.join("\n");
}

function PendingView({ c, busy, onAccept, onReject }: { c: PendingChange; busy: boolean; onAccept: () => void; onReject: () => void }) {
  const patch = c.action === "delete" ? simpleDiff(c.original ?? "", "") : simpleDiff(c.original ?? "", c.content ?? "");
  return (
    <div className="border-b last:border-0">
      <div className="flex items-center gap-1 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="flex-1 truncate">{c.action === "delete" ? "delete" : c.original == null ? "create" : "modify"} · {c.path}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onReject} aria-label={`Reject ${c.path}`}><X /></Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onAccept} aria-label={`Accept ${c.path}`}><Check /></Button>
      </div>
      <PatchView patch={c.original == null && c.action === "write" ? (c.content ?? "").split("\n").map((l) => "+" + l).join("\n") : patch} />
    </div>
  );
}

function fmt(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

function MemoryView({ repo }: { repo: string }) {
  const get = useServerFn(getRepoMemory);
  const clear = useServerFn(clearRepoMemory);
  const qc = useQueryClient();
  const mem = useQuery({ queryKey: ["memory", repo], queryFn: () => get({ data: { repo } }) });
  const [open, setOpen] = useState(false);
  return (
    <section className="mx-auto max-w-3xl px-3 pb-4">
      <div className="rounded-md border bg-card">
        <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold" onClick={() => setOpen(!open)}>
          <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="flex-1">Repo memory</span>
          <span className="text-xs font-normal text-muted-foreground">{mem.data ? `saved ${new Date(mem.data.updated_at).toLocaleDateString()}` : "none yet"}</span>
        </button>
        {open && (
          <div className="border-t p-3">
            {mem.data ? (
              <>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{mem.data.notes}</pre>
                <Button size="sm" variant="ghost" className="mt-2 text-destructive" onClick={async () => { await clear({ data: { repo } }); qc.invalidateQueries({ queryKey: ["memory", repo] }); toast.success("Memory cleared"); }}><Trash2 /> Forget</Button>
              </>
            ) : <p className="text-xs text-muted-foreground">The agent saves notes about this repo after exploring it, so later tasks skip the full scan.</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function mmss(ms: number) {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Real timings only: elapsed time, finished steps and their measured average. No invented ETA. */
function RunStatus({ start, lastUpdate, steps, limit, background, cloud, stopping, onStop }: { start: number | null; lastUpdate: string | null; steps: number; limit: number; background: boolean; cloud: boolean; stopping: boolean; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const elapsed = start ? now - start : 0;
  const avg = start && steps > 0 ? elapsed / steps : 0;
  return (
    <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin text-primary" />
      {background ? (
        <span className="min-w-0 flex-1">{stopping ? "Stopping… saving progress" : `${cloud ? "Running in the cloud" : "Running in browser"} · last update ${lastUpdate ? `${mmss(now - new Date(lastUpdate).getTime())} ago` : "—"} · ${steps} steps done`}</span>
      ) : (
        <>
          <span>Running in browser</span>
          <span className="font-mono text-foreground">⌛ {mmss(elapsed)}</span>
          <span>{steps} step{steps === 1 ? "" : "s"} done</span>
          {avg > 0 && <span>~{Math.round(avg / 1000)}s per step</span>}
          {avg > 0 && <span>at most ~{Math.ceil(((limit - steps) * avg) / 60000)} min left (step cap {limit}); usually finishes sooner</span>}
        </>
      )}
      <Button type="button" size="sm" variant="outline" className="ml-auto shrink-0" disabled={stopping} onClick={onStop} aria-label="Stop background work"><Square className="h-3 w-3" />{stopping ? "Stopping…" : "Stop"}</Button>
    </div>
  );
}
