import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

const HOST = "127.0.0.1";
const PORT = Number(process.env.FORGE_KEEPER_PORT || 8787);
const SECRET = process.env.FORGE_KEEPER_SECRET || "";
const MAX_ACTIVE = 4;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const PREPARED_TTL_MS = 5 * 60 * 1000;
const allowedOrigins = new Set(
  (process.env.FORGE_KEEPER_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);
const jobs = new Map();

if (SECRET.length < 32 || !/^[A-Za-z0-9_-]+$/.test(SECRET)) {
  throw new Error("FORGE_KEEPER_SECRET must contain at least 32 URL-safe characters.");
}
if (allowedOrigins.size === 0) {
  throw new Error("Set FORGE_KEEPER_ALLOWED_ORIGINS to the exact HTTPS origin(s) of your Forge app.");
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function authorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(SECRET, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function validOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function publicJob(job) {
  return { keeperId: job.id, state: job.state, status: job.status, message: job.message };
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const ttl = job.state === "prepared" ? PREPARED_TTL_MS : JOB_TTL_MS;
    if (now - job.updatedAt > ttl && job.state !== "starting" && job.state !== "accepted") {
      job.controller.abort();
      jobs.delete(id);
    }
  }
}

async function runAgentStream(job, input) {
  try {
    const response = await fetch(new URL("/api/agent", input.origin), {
      method: "POST",
      headers: {
        authorization: "Bearer " + input.token,
        "content-type": "application/json",
        "cache-control": "no-cache",
        "x-forge-keeper": job.id,
      },
      body: input.body,
      signal: job.controller.signal,
      redirect: "manual",
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      job.state = "failed";
      job.status = response.status;
      job.message = "Forge rejected the background run (HTTP " + response.status + ").";
      job.updatedAt = Date.now();
      return;
    }

    job.state = "accepted";
    job.status = 200;
    job.message = "Background run accepted.";
    job.updatedAt = Date.now();

    if (response.body) {
      for await (const _chunk of response.body) {
        if (job.controller.signal.aborted) break;
      }
    }
    job.state = job.controller.signal.aborted ? "stopped" : "finished";
    job.message = job.state === "finished" ? "Background run finished." : "Background run stopped.";
    job.updatedAt = Date.now();
  } catch {
    job.state = job.controller.signal.aborted ? "stopped" : "failed";
    job.status = job.controller.signal.aborted ? 409 : 502;
    job.message = job.controller.signal.aborted
      ? "Background run stopped."
      : "The keeper could not reach the Forge application.";
    job.updatedAt = Date.now();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://" + HOST + ":" + PORT);
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "forge-keeper" });
  }
  if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });

  pruneJobs();

  if (req.method === "POST" && url.pathname === "/prepare") {
    const active = [...jobs.values()].filter((job) => ["prepared", "starting", "accepted"].includes(job.state)).length;
    if (active >= MAX_ACTIVE) return send(res, 429, { error: "Keeper capacity is full." });
    const id = randomUUID();
    jobs.set(id, { id, state: "prepared", status: null, message: null, controller: new AbortController(), updatedAt: Date.now() });
    return send(res, 201, { keeperId: id });
  }

  if (req.method === "POST" && url.pathname === "/start") {
    let input;
    try { input = await readJson(req); } catch (error) {
      return send(res, error.status || 400, { error: error.message || "Invalid request" });
    }
    const job = jobs.get(input?.keeperId);
    if (!job || job.state !== "prepared") return send(res, 409, { error: "Keeper was not prepared or was already started." });
    if (!validOrigin(input.origin)) return send(res, 400, { error: "Forge origin is not in the keeper allowlist." });
    if (typeof input.token !== "string" || input.token.length < 20 || input.token.length > 8192 || !/^[A-Za-z0-9._~+/-=]+$/.test(input.token)) {
      return send(res, 400, { error: "Invalid session token." });
    }
    if (typeof input.body !== "string" || input.body.length > MAX_BODY_BYTES) return send(res, 413, { error: "Invalid or oversized agent request." });
    let payload;
    try { payload = JSON.parse(input.body); } catch { return send(res, 400, { error: "Agent request must be valid JSON." }); }
    if (!payload || typeof payload.sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sessionId)) {
      return send(res, 400, { error: "Agent request must include a valid task ID." });
    }

    job.state = "starting";
    job.updatedAt = Date.now();
    void runAgentStream(job, { origin: input.origin, token: input.token, body: input.body });
    return send(res, 202, { accepted: true, keeperId: job.id });
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const id = url.searchParams.get("id") || "";
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: "Keeper not found." });
    return send(res, 200, publicJob(job));
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    let input;
    try { input = await readJson(req); } catch (error) {
      return send(res, error.status || 400, { error: error.message || "Invalid request" });
    }
    const job = jobs.get(input?.keeperId);
    if (!job) return send(res, 404, { error: "Keeper not found." });
    job.controller.abort(new Error("Stopped by Forge."));
    job.state = "stopped";
    job.status = 409;
    job.message = "Background run stopped.";
    job.updatedAt = Date.now();
    return send(res, 200, publicJob(job));
  }

  return send(res, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log("Forge keeper listening on " + HOST + ":" + PORT + "; active capacity " + MAX_ACTIVE + ".");
});
