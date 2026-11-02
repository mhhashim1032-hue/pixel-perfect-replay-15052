import { describe, expect, it } from "vitest";
import { autoFixPrompt, customerAuthPatch, mergeAllowList, orderDomains, overall, pickSiteUrl, requiredAuthUrls } from "@/lib/connect";

describe("connect & sync rules", () => {
  it("allows the live site, Vercel previews and local dev for sign-in", () => {
    const urls = requiredAuthUrls(["shop.example.com"]);
    expect(urls).toContain("https://shop.example.com/**");
    expect(urls).toContain("https://*.vercel.app/**");
    expect(urls).toContain("http://localhost:3000/**");
  });
  it("keeps existing allowed links and only adds missing ones", () => {
    const r = mergeAllowList("https://old.com/**", ["https://old.com/**", "https://*.vercel.app/**"]);
    expect(r.value).toBe("https://old.com/**,https://*.vercel.app/**");
    expect(r.added).toEqual(["https://*.vercel.app/**"]);
  });
  it("uses Vercel's assigned production address even when a different site was configured", () => {
    expect(pickSiteUrl("http://localhost:3000", ["app.vercel.app"])).toBe("https://app.vercel.app");
    expect(pickSiteUrl("https://mysite.com", ["app.vercel.app"])).toBe("https://app.vercel.app");
    expect(pickSiteUrl("https://app.vercel.app", ["app.vercel.app"])).toBeNull();
    expect(pickSiteUrl("https://mysite.com", ["shop.com"])).toBeNull();
  });
  it("prefers the registered Vercel production alias over custom domains", () => {
    expect(orderDomains(["my-app-x1.vercel.app", "my-app.vercel.app", "shop.com"])).toEqual(["my-app.vercel.app", "my-app-x1.vercel.app", "shop.com"]);
  });
  it("preserves customer email confirmation and existing return links", () => {
    const cfg = { mailer_autoconfirm: false, uri_allow_list: "https://old.com/**", site_url: "https://old.com", disable_signup: true, password_hibp_enabled: true };
    const patch = customerAuthPatch(cfg, ["app.vercel.app"]);
    expect(patch).not.toHaveProperty("mailer_autoconfirm");
    expect(patch.site_url).toBe("https://app.vercel.app");
    expect(patch.uri_allow_list).toContain("https://old.com/**");
    expect(patch).not.toHaveProperty("disable_signup");
    expect(patch).not.toHaveProperty("password_hibp_enabled");
    expect(customerAuthPatch({ mailer_autoconfirm: true, uri_allow_list: requiredAuthUrls([]).join(",") }, [])).toEqual({});
  });
  it("any failure makes the overall state fail", () => {
    expect(overall([{ key: "a", label: "A", state: "ok", note: "" }, { key: "b", label: "B", state: "fail", note: "" }])).toBe("fail");
  });
  it("Auto-fix has nothing to do when everything passes", () => {
    expect(autoFixPrompt([{ key: "a", label: "A", state: "ok", note: "" }], [])).toBeNull();
    expect(autoFixPrompt([{ key: "b", label: "Build", state: "fail", note: "ERROR" }], ["x"])).toContain("Build: ERROR");
  });
  it("Auto-fix never claims customer infrastructure was already changed", () => {
    const prompt = autoFixPrompt([{ key: "database", label: "Database settings", state: "warn", note: "Pending approval" }], []);
    expect(prompt).toContain("without changing customer infrastructure");
    expect(prompt).toContain("never write customer environment/auth settings");
    expect(prompt).toContain("migrations remain pending explicit review and approval");
    expect(prompt).toContain("Do not promote to production");
    expect(prompt).toContain("never to trigger production deployment");
    expect(prompt).toContain("do not change customer Supabase Auth settings");
  });
});
