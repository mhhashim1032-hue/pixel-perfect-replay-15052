import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";

const HOST = "127.0.0.1";
const SECRET = "test-secret-".padEnd(64, "x");
let port;
let child;
let baseUrl;

async function freePort() {
  const probe = createServer();
  probe.listen(0, HOST);
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(baseUrl + "/health");
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Keeper service did not become healthy.");
}

async function request(path, options = {}) {
  return fetch(baseUrl + path, options);
}

before(async () => {
  port = await freePort();
  baseUrl = "http://" + HOST + ":" + port;
  child = spawn(process.execPath, ["ops/oci-keeper/server.mjs"], {
    env: {
      ...process.env,
      FORGE_KEEPER_PORT: String(port),
      FORGE_KEEPER_SECRET: SECRET,
      FORGE_KEEPER_ALLOWED_ORIGINS: "https://forge.example.com",
    },
    stdio: "ignore",
  });
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("health is public and does not expose configuration", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "forge-keeper" });
});

test("all keeper operations require the shared secret", async () => {
  const response = await request("/prepare", { method: "POST" });
  assert.equal(response.status, 401);
});

test("prepare, exact-origin validation, status and stop are enforced", async () => {
  const headers = { authorization: "Bearer " + SECRET, "content-type": "application/json" };
  const prepared = await request("/prepare", { method: "POST", headers, body: "{}" });
  assert.equal(prepared.status, 201);
  const { keeperId } = await prepared.json();
  assert.match(keeperId, /^[0-9a-f-]{36}$/i);

  const rejected = await request("/start", {
    method: "POST",
    headers,
    body: JSON.stringify({
      keeperId,
      origin: "https://attacker.example",
      token: "x".repeat(40),
      body: JSON.stringify({ sessionId: "10000000-0000-4000-8000-000000000001" }),
    }),
  });
  assert.equal(rejected.status, 400);

  const status = await request("/status?id=" + encodeURIComponent(keeperId), { headers });
  assert.equal((await status.json()).state, "prepared");

  const stopped = await request("/stop", { method: "POST", headers, body: JSON.stringify({ keeperId }) });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).state, "stopped");
});
