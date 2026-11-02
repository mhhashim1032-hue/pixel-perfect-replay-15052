import { describe, it, expect } from "vitest";
import { agentSkills } from "@/lib/agent-skills";

const options = { toolCallId: "skills", messages: [], context: {} };
describe("saved skill access", () => {
  it("lists and reads enabled saved instructions without repository access", async () => {
    const access = agentSkills([{ name: "frontend-design", instructions: "Use purposeful motion." }], null);
    expect(await access.tools.list_skills.execute({}, options)).toEqual({ skills: [{ name: "frontend-design", chars: 22, loaded: true }] });
    expect(await access.tools.read_skill.execute({ name: "Frontend-design" }, options)).toEqual({ name: "frontend-design", instructions: "Use purposeful motion." });
  });
  it("keeps loaded skills below user and project instruction authority", () => {
    const access = agentSkills([{ name: "frontend-design", instructions: "Use purposeful motion." }], null);
    expect(access.context).toContain("the user's explicit instructions and authorization");
    expect(access.context).toContain("project instructions");
    expect(access.context).toContain("loaded skills");
    expect(access.context.indexOf("project instructions")).toBeLessThan(access.context.indexOf("loaded skills"));
  });
  it("does not silently treat failed skill loading as an empty collection", () => {
    expect(() => agentSkills(null, { code: "denied" })).toThrow("Could not load your saved skills");
  });
  it("refuses unknown or disabled skills", async () => {
    expect(await agentSkills([], null).tools.read_skill.execute({ name: "disabled" }, options)).toMatchObject({ error: expect.any(String) });
  });
});