import { invoke } from "@tauri-apps/api/core";
import { AiProviderError, buildPrompt, RESULT_SCHEMA, type AiProvider, type AiResult, type EditPassInput } from "@marz/autoedit";

type AiErrorPayload = { kind: "notInstalled" | "notSignedIn" | "usageLimit" | "failed" | "cancelled"; detail?: string };

const MODEL_KEY = "marz.ai.model";
const EFFORT_KEY = "marz.ai.effort";
const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};

/** The AI step through the installed Claude Code CLI (his subscription). Desktop only. The model is a
 * setting (default sonnet, high effort: the spike showed lower effort stops reading part way). */
export class ClaudeCodeProvider implements AiProvider {
  name = "claude-code";
  model = read(MODEL_KEY, "sonnet");
  effort = read(EFFORT_KEY, "high");

  async editPass(input: EditPassInput, signal: AbortSignal): Promise<AiResult> {
    if (signal.aborted) throw new AiProviderError("cancelled", "Cancelled");
    const onAbort = () => void invoke("ai_cancel").catch(() => {});
    signal.addEventListener("abort", onAbort);
    try {
      const text = await invoke<string>("ai_edit_pass", {
        prompt: buildPrompt(input),
        schema: JSON.stringify(RESULT_SCHEMA),
        model: this.model,
        effort: this.effort,
      });
      try {
        return JSON.parse(text) as AiResult;
      } catch {
        throw new AiProviderError("badResult", "Claude Code answered with invalid JSON");
      }
    } catch (e) {
      if (e instanceof AiProviderError) throw e;
      const p = e as AiErrorPayload;
      if (p && typeof p === "object" && "kind" in p) throw new AiProviderError(p.kind, p.detail ?? p.kind);
      throw new AiProviderError("failed", String(e));
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
