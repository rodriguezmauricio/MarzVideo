import { invoke } from "@tauri-apps/api/core";
import { AiProviderError, buildPrompt, RESULT_SCHEMA, type AiErrorKind, type AiProvider, type AiResult, type EditPassInput } from "@marz/autoedit";

type AiErrorPayload = { kind: AiErrorKind; detail?: string };
/** provider.rs `Answer`. */
type Answer = { text: string; provider: string; model: string };

const MODEL_KEY = "marz.ai.model";
const EFFORT_KEY = "marz.ai.effort";
const read = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) || d;
  } catch {
    return d;
  }
};

/** The AI step in the desktop app, through the provider picked in Settings (src-tauri/src/provider.rs):
 * Claude Code by default (his subscription), the Anthropic API or a local model. `model` and `effort`
 * here are the Claude Code settings (default sonnet, high effort: the spike showed lower effort stops
 * reading part way); the other providers use their own. `name` and `model` become the provider that
 * answered once a call returns. */
export class DesktopProvider implements AiProvider {
  name: string;
  model: string;
  effort = read(EFFORT_KEY, "high");
  private claudeModel = read(MODEL_KEY, "sonnet");

  constructor(name = "claude-code", model?: string) {
    this.name = name;
    this.model = model ?? this.claudeModel;
  }

  async editPass(input: EditPassInput, signal: AbortSignal): Promise<AiResult> {
    if (signal.aborted) throw new AiProviderError("cancelled", "Cancelled");
    const onAbort = () => void invoke("ai_cancel").catch(() => {});
    signal.addEventListener("abort", onAbort);
    try {
      const a = await invoke<Answer>("ai_edit_pass", {
        prompt: buildPrompt(input),
        schema: JSON.stringify(RESULT_SCHEMA),
        model: this.claudeModel,
        effort: this.effort,
      });
      this.name = a.provider;
      this.model = a.model;
      try {
        return JSON.parse(a.text) as AiResult;
      } catch {
        throw new AiProviderError("badResult", "The AI answered with invalid JSON");
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
