import { describe, expect, it } from "vitest";
import { PROVIDERS, sentText } from "./AiProviderRows";
import { fakeSettingsApi } from "./settingsApi";

describe("AI provider settings", () => {
  it("offers Claude Code first, then the API, local and off", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(["claude-code", "anthropic", "local", "off"]);
  });

  it("says plainly what is sent", () => {
    for (const p of ["claude-code", "anthropic", "local"] as const) {
      expect(sentText(p)).toContain("Never video, audio, screenshots or file paths.");
    }
    expect(sentText("claude-code")).toContain("Claude subscription");
    expect(sentText("anthropic")).toContain("Billed per use");
    expect(sentText("off")).toMatch(/^Nothing is sent/);
  });

  it("the browser fake keeps only the last 4 characters of a saved key", async () => {
    const api = fakeSettingsApi();
    expect((await api.aiProvider()).provider).toBe("claude-code");
    await api.setAiProvider({ ...(await api.aiProvider()), provider: "anthropic" });
    expect(await api.testAiProvider()).toEqual({ ok: false, text: "No key saved yet." });
    const v = await api.saveAiKey("  sk-ant-test-wxyz ");
    expect(v.keySaved).toBe(true);
    expect(v.keyLast4).toBe("wxyz");
    expect(JSON.stringify(v)).not.toContain("sk-ant");
    expect((await api.testAiProvider()).ok).toBe(true);
    await expect(api.setAiProvider({ ...v, provider: "local", localUrl: "localhost:11434" })).rejects.toBe("The address starts with http:// or https://.");
  });
});
