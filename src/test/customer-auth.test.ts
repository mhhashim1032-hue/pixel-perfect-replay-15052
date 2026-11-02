import { afterEach, describe, expect, it, vi } from "vitest";
import { syncDeploymentAuth } from "@/lib/customer-auth.server";

afterEach(() => vi.unstubAllGlobals());
describe("authorized customer redirect synchronization", () => {
  it("reads, patches only required auth fields and verifies settings on the pinned project", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ domains: [{ name: "customer.vercel.app" }] }))
      .mockResolvedValueOnce(Response.json({ mailer_autoconfirm: false, site_url: "https://old.example", password_min_length: 12 }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ mailer_autoconfirm: false, site_url: "https://customer.vercel.app", uri_allow_list: "https://customer.vercel.app/**,https://*.vercel.app/**,http://localhost:3000/**,http://localhost:5173/**,http://localhost:8080/**" }));
    vi.stubGlobal("fetch", fetcher);
    await syncDeploymentAuth("customer-ref", "database-test", "customer-project", "vercel-test");
    expect(fetcher.mock.calls[0]?.[0]).toContain("/projects/customer-project/domains");
    expect(fetcher.mock.calls[2]?.[0]).toContain("/projects/customer-ref/config/auth");
    expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body)).toMatchObject({ site_url: "https://customer.vercel.app" });
    expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body)).not.toHaveProperty("mailer_autoconfirm");
    expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body)).not.toHaveProperty("password_min_length");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("does not report successful redirect configuration when provider readback is stale", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ domains: [] }))
      .mockResolvedValueOnce(Response.json({ mailer_autoconfirm: false }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ mailer_autoconfirm: false })));
    await expect(syncDeploymentAuth("customer-ref", "database-test", "customer-project", "vercel-test")).rejects.toThrow("could not be verified");
  });
});