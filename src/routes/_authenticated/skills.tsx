import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Download, Pencil, Search, Trash2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteSkill,
  importSkills,
  listSkills,
  previewSkillImport,
  upsertSkill,
  type Skill,
  type SkillCandidate,
} from "@/lib/app.functions";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/_authenticated/skills")({
  head: () => ({ meta: pageMeta("Skills — Forge", "Reusable instructions the agent follows on every task, including skills imported from GitHub repositories.") }),
  component: SkillsPage,
});

type Found = { repo: string; branch: string; candidates: SkillCandidate[] };

function SkillsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listSkills);
  const upsert = useServerFn(upsertSkill);
  const del = useServerFn(deleteSkill);
  const find = useServerFn(previewSkillImport);
  const add = useServerFn(importSkills);
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => list(), retry: 1 });
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [found, setFound] = useState<Found | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const refresh = () => qc.invalidateQueries({ queryKey: ["skills"] });
  const resetEditor = () => { setEditId(null); setName(""); setText(""); };
  const saveM = useMutation({
    mutationFn: () => upsert({ data: { id: editId, name: name.trim(), instructions: text.trim(), enabled: true } }),
    onSuccess: () => { toast.success("Skill saved"); resetEditor(); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const edit = (s: Skill) => { setEditId(s.id); setName(s.name); setText(s.instructions); window.scrollTo({ top: 0, behavior: "smooth" }); };

  const findM = useMutation({
    mutationFn: () => find({ data: { source } }),
    onSuccess: (r) => {
      setFound(r);
      setPicked(new Set(r.candidates.filter((c) => !c.already).map((c) => c.path)));
      toast.success(`${r.candidates.length} file${r.candidates.length === 1 ? "" : "s"} found in ${r.repo}`);
    },
    onError: (e: Error) => { setFound(null); setPicked(new Set()); toast.error(e.message); },
  });

  const addM = useMutation({
    mutationFn: () => add({ data: { source, paths: [...picked] } }),
    onSuccess: (r) => {
      toast.success(r.added.length
        ? `Added ${r.added.length} skill${r.added.length === 1 ? "" : "s"}${r.skipped.length ? ` · ${r.skipped.length} already saved` : ""}`
        : "Already saved — nothing new to add");
      setFound(null); setPicked(new Set()); setSource(""); refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleM = useMutation({
    mutationFn: (s: Skill & { enabled: boolean }) => upsert({ data: { id: s.id, name: s.name, instructions: s.instructions, enabled: !s.enabled } }),
    onSuccess: (_, s) => { toast.success(s.enabled ? "Skill disabled" : "Skill enabled"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => { toast.success("Skill deleted"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const visibleSkills = useMemo(() => (skills.data ?? []).filter((s) => {
    const matches = `${s.name} ${s.instructions} ${s.source ?? ""}`.toLowerCase().includes(search.toLowerCase());
    return matches && (filter === "all" || (filter === "enabled" ? s.enabled : !s.enabled));
  }), [skills.data, search, filter]);

  const toggle = (path: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  return (
    <div className="min-h-screen">
      <AppHeader><span className="text-sm text-muted-foreground">Skills</span></AppHeader>
      <main className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
        <section className="rounded-lg border bg-card p-4 sm:p-5">
          <h2 className="font-semibold">Import skills from GitHub</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Paste a repository link (or <span className="font-mono text-xs">owner/repo</span>), optionally pointing to a folder. Forge recognises folders containing <span className="font-mono text-xs">SKILL.md</span>.
          </p>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); findM.mutate(); }}>
            <Input required value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://github.com/owner/repo/tree/main/skills" className="min-w-0 flex-1" />
            <Button disabled={findM.isPending || !source.trim()} className="shrink-0">{findM.isPending ? "Searching…" : "Find skills"}</Button>
          </form>
          {findM.isError && <p role="alert" className="mt-2 text-sm text-destructive">Could not find skills. Check the repository link and try again.</p>}
          {found && (
            <div className="mt-4 space-y-2">
              <p className="truncate text-xs text-muted-foreground">{found.repo} · branch {found.branch} · select the skills to import</p>
              {found.candidates.length === 0 ? <p className="rounded-md border p-3 text-sm text-muted-foreground">No importable skill files were found in this location.</p> : (
                <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-1">
                  {found.candidates.map((c) => {
                    const on = picked.has(c.path);
                    return <li key={c.path}><button type="button" onClick={() => toggle(c.path)} aria-pressed={on} className="flex w-full items-start gap-2.5 rounded px-2 py-2 text-left hover:bg-muted/60">
                      <span className={on ? "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border border-primary bg-primary text-primary-foreground" : "mt-0.5 size-4 shrink-0 rounded-[4px] border border-input"}>{on && <Check className="size-3" />}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{c.name}</span><span className="block truncate text-xs text-muted-foreground">{c.already ? "already saved" : c.description || c.path}</span></span>
                      <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">{Math.round(c.chars / 100) / 10}k</span>
                    </button></li>;
                  })}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button disabled={addM.isPending || picked.size === 0} onClick={() => addM.mutate()}><Download />{addM.isPending ? "Adding…" : `Add ${picked.size} skill${picked.size === 1 ? "" : "s"}`}</Button>
                <Button type="button" variant="ghost" onClick={() => { setFound(null); setPicked(new Set()); }}>Cancel</Button>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-card p-4 sm:p-5">
          <h2 className="font-semibold">{editId ? "Edit skill" : "Create a skill"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Enabled skills are included with every task. Repository-level AGENTS.md and CLAUDE.md instructions are also read automatically.</p>
          <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); saveM.mutate(); }}>
            <div className="space-y-1.5"><Label>Name</Label><Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Write tests first" /></div>
            <div className="space-y-1.5"><Label>Instructions</Label><Textarea required rows={6} maxLength={20000} value={text} onChange={(e) => setText(e.target.value)} placeholder="When adding a feature, add or update a unit test next to it…" /><p className="text-right text-xs text-muted-foreground">{text.length.toLocaleString()} / 20,000</p></div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={saveM.isPending || !name.trim() || !text.trim()}>{saveM.isPending ? "Saving…" : editId ? "Save changes" : "Save skill"}</Button>
              {editId && <Button type="button" variant="ghost" onClick={resetEditor}>Cancel edit</Button>}
            </div>
          </form>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Your skills</h2><p className="text-xs text-muted-foreground">{skills.data?.length ?? 0} saved · {skills.data?.filter((s) => s.enabled).length ?? 0} enabled</p></div></div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search skills" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names, instructions or source…" className="pl-9" /></div>
            <div className="flex rounded-md border p-1 text-xs" aria-label="Filter skills">
              {(["all", "enabled", "disabled"] as const).map((v) => <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)} className={`rounded px-3 py-1.5 capitalize ${filter === v ? "bg-accent text-foreground" : "text-muted-foreground"}`}>{v}</button>)}
            </div>
          </div>
          {skills.isLoading && <p className="rounded-md border p-4 text-sm text-muted-foreground">Loading your skills…</p>}
          {skills.isError && <div role="alert" className="rounded-md border p-4 text-sm"><p>Could not load skills.</p><Button size="sm" variant="outline" className="mt-2" onClick={() => skills.refetch()}>Try again</Button></div>}
          {!skills.isLoading && !skills.isError && skills.data?.length === 0 && <p className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">No skills yet. Create one above or import from GitHub.</p>}
          {!skills.isLoading && !skills.isError && skills.data && skills.data.length > 0 && visibleSkills.length === 0 && <p className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">No skills match this search or filter.</p>}
          <ul className="space-y-2">
            {visibleSkills.map((s) => <li key={s.id} className="flex min-w-0 items-start gap-2 rounded-md border bg-card px-3 py-3 sm:gap-3 sm:px-4">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{s.name}</p><p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{s.instructions}</p>{s.source && <p className="mt-1 truncate text-[11px] text-muted-foreground">from {s.source}</p>}</div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch checked={s.enabled} disabled={toggleM.isPending} aria-label={`Enable ${s.name}`} onCheckedChange={() => toggleM.mutate(s)} />
                <Button variant="ghost" size="icon" aria-label={`Edit ${s.name}`} onClick={() => edit(s)}><Pencil /></Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${s.name}`} disabled={deleteM.isPending} onClick={() => { if (window.confirm(`Delete “${s.name}”? This cannot be undone.`)) deleteM.mutate(s.id); }}><Trash2 /></Button>
              </div>
            </li>)}
          </ul>
        </section>
      </main>
    </div>
  );
}
