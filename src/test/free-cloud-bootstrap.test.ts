import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync("ops/free-cloud/oci-bootstrap.sh", "utf8");
const guide = readFileSync("ops/free-cloud/README.md", "utf8");

describe("free cloud bootstrap safety", () => {
  it("prepares a host without deploying code or registering a runner", () => {
    expect(bootstrap).toContain("does NOT deploy Forge");
    expect(bootstrap).toContain("does NOT");
    expect(bootstrap).not.toMatch(/config\.(sh|cmd).*--url/);
    expect(bootstrap).not.toMatch(/\.\/run\.sh/);
    expect(bootstrap).not.toMatch(/git clone/);
    expect(bootstrap).not.toMatch(/systemctl enable --now forge/);
  });

  it("does not grant the untrusted forge account Docker daemon access", () => {
    expect(bootstrap).toContain("Do not add the forge account to the docker group");
    expect(bootstrap).not.toMatch(/usermod\s+-aG\s+docker\s+forge/);
  });

  it("opens only the configured SSH port and enables basic host protections", () => {
    expect(bootstrap).toContain('ufw allow "${SSH_PORT}/tcp"');
    expect(bootstrap).toContain("fail2ban");
    expect(bootstrap).toContain("unattended-upgrades");
    expect(bootstrap).not.toMatch(/ufw allow (80|443|3000|8080)/);
  });

  it("documents free-tier limits and warns about persistent runner risks", () => {
    expect(guide).toContain("2 OCPU + 12 GB RAM");
    expect(guide).toContain("4-hour session limit");
    expect(guide).toContain("self-hosted Actions runner");
    expect(guide).toContain("GPU only for local inference/training");
  });
});
