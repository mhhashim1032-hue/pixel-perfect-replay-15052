import { b64ToUtf8, utf8ToB64 } from "./crypto.server";
import { commitSafely } from "./branch-write-queue";

export class GitHub {
  constructor(private token: string, private signal?: AbortSignal) {}

  async req<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`https://api.github.com/${path}`, {
      ...init,
      signal: init.signal ?? this.signal,
      headers: {
        Accept: "application/vnd.github+json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        "User-Agent": "byok-coding-agent",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : (null as T);
  }

  user() {
    return this.req<{ login: string }>("user");
  }
  repoInfo(repo: string) {
    return this.req<{ default_branch: string }>(`repos/${repo}`);
  }
  async repos() {
    const r = await this.req<any[]>("user/repos?sort=updated&per_page=100");
    return r.map((x) => ({ full_name: x.full_name as string, default_branch: x.default_branch as string, private: x.private as boolean }));
  }
  async createRepo(name: string, description: string, isPrivate: boolean) {
    const r = await this.req<any>("user/repos", {
      method: "POST",
      body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
    });
    return { full_name: r.full_name as string, default_branch: (r.default_branch as string) || "main" };
  }
  async branches(repo: string) {
    const r = await this.req<any[]>(`repos/${repo}/branches?per_page=100`);
    return r.map((b) => b.name as string);
  }
  async createBranch(repo: string, from: string, name: string) {
    const ref = await this.req<any>(`repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
    await this.req(`repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${name}`, sha: ref.object.sha }) });
  }
  async headSha(repo: string, branch: string): Promise<string> {
    const ref = await this.req<{ object: { sha: string } }>(`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  }
  async tree(repo: string, branch: string) {
    const t = await this.req<any>(`repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    return (t.tree as any[]).filter((e) => e.type === "blob").map((e) => e.path as string);
  }
  private enc(path: string) {
    return path.split("/").map(encodeURIComponent).join("/");
  }
  async getFile(repo: string, branch: string, path: string): Promise<{ content: string; sha: string } | null> {
    try {
      const f = await this.req<any>(`repos/${repo}/contents/${this.enc(path)}?ref=${encodeURIComponent(branch)}`);
      if (Array.isArray(f)) throw new Error(`${path} is a directory`);
      return { content: b64ToUtf8(f.content ?? ""), sha: f.sha };
    } catch (e) {
      if (String(e).includes("GitHub 404")) return null;
      throw e;
    }
  }
  putFile(repo: string, branch: string, path: string, content: string, message: string) {
    return commitSafely(repo, branch, async () => {
      const existing = await this.getFile(repo, branch, path);
      const r = await this.req<any>(`repos/${repo}/contents/${this.enc(path)}`, {
        method: "PUT",
        body: JSON.stringify({ message, content: utf8ToB64(content), branch, ...(existing ? { sha: existing.sha } : {}) }),
      });
      return r.commit.sha as string;
    });
  }
  deleteFile(repo: string, branch: string, path: string, message: string) {
    return commitSafely(repo, branch, async () => {
      const existing = await this.getFile(repo, branch, path);
      if (!existing) throw new Error(`${path} does not exist`);
      const r = await this.req<any>(`repos/${repo}/contents/${this.enc(path)}`, {
        method: "DELETE",
        body: JSON.stringify({ message, sha: existing.sha, branch }),
      });
      return r.commit.sha as string;
    });
  }
  async compare(repo: string, base: string, head: string) {
    const c = await this.req<any>(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return {
      ahead_by: c.ahead_by as number,
      base_sha: c.merge_base_commit.sha as string,
      commits: (c.commits as any[]).map((x) => ({ sha: x.sha as string, message: x.commit.message as string })),
      files: ((c.files ?? []) as any[]).map((f) => ({ filename: f.filename as string, status: f.status as string, patch: (f.patch ?? "") as string })),
    };
  }
  async resetBranch(repo: string, branch: string, sha: string) {
    await this.req(`repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha, force: true }),
    });
  }
  /** Adds an empty commit (same tree) on top of the branch, e.g. to trigger exactly one deploy. */
  async emptyCommit(repo: string, branch: string, message: string) {
    return commitSafely(repo, branch, async () => {
      const head = await this.headSha(repo, branch);
      const c = await this.req<any>(`repos/${repo}/git/commits/${head}`);
      const n = await this.req<any>(`repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: c.tree.sha, parents: [head] }) });
      await this.req(`repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: n.sha }) });
      return n.sha as string;
    });
  }
  /** Writes many files as ONE commit (a fixed 4–5 API calls instead of two per file). */
  putFiles(repo: string, branch: string, files: { path: string; content: string }[], message: string) {
    return commitSafely(repo, branch, async () => {
      const head = await this.headSha(repo, branch);
      const c = await this.req<any>(`repos/${repo}/git/commits/${head}`);
      const t = await this.req<any>(`repos/${repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: c.tree.sha, tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })) }),
      });
      const n = await this.req<any>(`repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: t.sha, parents: [head] }) });
      await this.req(`repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: n.sha }) });
      return n.sha as string;
    });
  }
  async openPr(repo: string, base: string, head: string, title: string, body: string) {
    const p = await this.req<any>(`repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, body, head, base }) });
    return p.html_url as string;
  }
}
