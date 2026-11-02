// Pure rules for "Connect & sync": sign-in return links, health steps and the Auto-fix brief.
import { productionInstructions } from "./deployment-quality";

export type StepState = "ok" | "warn" | "fail" | "skip";
export type SyncStep = { key: string; label: string; state: StepState; note: string };

const LOCAL = ["http://localhost:3000/**", "http://localhost:5173/**", "http://localhost:8080/**"];

/** Return links sign-in must allow so login/logout work on the live site, Vercel previews and local dev. */
export function requiredAuthUrls(domains: string[]): string[] {
  const live = domains.filter((d) => /^[a-z0-9.-]+$/i.test(d)).map((d) => `https://${d.toLowerCase()}/**`);
  return [...new Set([...live, "https://*.vercel.app/**", ...LOCAL])];
}

/** Keeps every existing allowed link and adds the missing required ones. */
export function mergeAllowList(existing: string | null | undefined, required: string[]): { value: string; added: string[] } {
  const have = (existing ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const added = required.filter((u) => !have.includes(u));
  return { value: [...have, ...added].join(","), added };
}

/** Only a registered Vercel production domain determines the final site address. */
export function pickSiteUrl(current: string | null | undefined, domains: string[], verifiedCustomDomain?: string): string | null {
  const assigned = verifiedCustomDomain && domains.includes(verifiedCustomDomain) ? verifiedCustomDomain : orderDomains(domains).find((d) => /^[a-z0-9-]+\.vercel\.app$/.test(d));
  const live = assigned ? `https://${assigned}` : null;
  if (!live) return null;
  return current?.replace(/\/$/, "") === live ? null : live;
}

/** Prefer the registered Vercel production alias, then additional custom domains. */
export function orderDomains(domains: string[]): string[] {
  const uniq = [...new Set(domains.map((d) => d.toLowerCase()))];
  const custom = uniq.filter((d) => !d.endsWith(".vercel.app"));
  const vercel = uniq.filter((d) => d.endsWith(".vercel.app")).sort((a, b) => a.length - b.length);
  return [...vercel, ...custom];
}

/** A narrow Management API patch leaves signup, passwords and all other protections untouched. */
export function customerAuthPatch(cfg: { site_url?: string; uri_allow_list?: string; mailer_autoconfirm?: boolean }, domains: string[], verifiedCustomDomain?: string) {
  const merged = mergeAllowList(cfg.uri_allow_list, requiredAuthUrls(domains));
  const site = pickSiteUrl(cfg.site_url, domains, verifiedCustomDomain);
  return {
    ...(cfg.mailer_autoconfirm !== true ? { mailer_autoconfirm: true } : {}),
    ...(merged.added.length ? { uri_allow_list: merged.value } : {}),
    ...(site ? { site_url: site } : {}),
  };
}

export function overall(steps: SyncStep[]): StepState {
  if (steps.some((s) => s.state === "fail")) return "fail";
  if (steps.some((s) => s.state === "warn")) return "warn";
  return steps.some((s) => s.state === "ok") ? "ok" : "skip";
}

/** The focused repair brief Auto-fix sends to the agent; only real blockers, never secrets. */
export function autoFixPrompt(steps: SyncStep[], buildErrors: string[]): string | null {
  const problems = steps.filter((s) => s.state === "fail" || s.state === "warn");
  if (!problems.length && !buildErrors.length) return null;
  const lines = [
    productionInstructions,
    "AUTO-FIX: repair source-code and build issues, then verify the task-branch preview. Do not promote to production or mutate customer infrastructure.",
    "Forge inspected the customer connections without changing customer infrastructure. Environment settings, auth configuration and database migrations remain pending explicit review and approval. Remaining blockers:",
    ...problems.map((p) => `- ${p.label}: ${p.note}`),
    ...(buildErrors.length ? ["Latest build errors:", ...buildErrors.slice(0, 12).map((e) => `  ${e}`)] : []),
    "",
    "Rules: follow the deployment-safe-coding skill; fix root causes in code, not by disabling checks; keep server-only keys out of browser code; never write customer environment/auth settings or apply migrations from Auto-fix;",
    "keep sign-in and sign-out code paths correct, but do not change customer Supabase Auth settings or redirect allow-lists without their separate approval;",
    "run relevant source-level tests and preview checks; use deploy_status only to inspect an existing deployment, never to trigger production deployment. Repeat at most 3 repair rounds. Finish with one short result: preview verified, or the single remaining blocker.",
  ];
  return lines.join("\n");
}
