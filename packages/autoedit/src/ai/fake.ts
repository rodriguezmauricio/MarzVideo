import { norm } from "../fillers";
import { AiProviderError, type AiProvider, type AiResult, type EditPassInput } from "./types";

/** The browser and test provider: no network. Finds the sample's restarted sentence ("Agora a gente
 * vai, agora a gente vai abrir o menu"), marks "tipo" as filler and picks the first zoom candidate
 * that has words over it. Works on any transcript with the same patterns. */
export class FakeProvider implements AiProvider {
  name = "fake";
  model = "fixture";
  constructor(private readonly delayMs = 400) {}

  async editPass(input: EditPassInput, signal: AbortSignal): Promise<AiResult> {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, this.delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new AiProviderError("cancelled", "Cancelled"));
      });
    });
    const words = input.words;
    const texts = words.map((w) => norm(w.text));
    const result: AiResult = { mistakes: [], contextFillers: [], zooms: [] };

    // A restart: the same three words again within a few words; cut the first try.
    for (let i = 0; i + 3 < texts.length; i++) {
      for (let j = i + 2; j < Math.min(texts.length - 2, i + 8); j++) {
        if (texts[i] && texts[i] === texts[j] && texts[i + 1] === texts[j + 1] && texts[i + 2] === texts[j + 2]) {
          result.mistakes.push({ fromWordId: words[i]!.id, toWordId: words[j - 1]!.id, why: "restarted sentence" });
          i = j;
          break;
        }
      }
    }
    for (let i = 0; i < texts.length; i++) if (texts[i] === "tipo") result.contextFillers.push(words[i]!.id);
    for (const c of input.candidates) {
      const over = words.filter((w) => w.endUs > c.startUs - 1_000_000 && w.startUs < c.endUs + 1_000_000);
      if (over.length > 0) {
        result.zooms.push({ candidateId: c.id, fromWordId: over[0]!.id, toWordId: over[over.length - 1]!.id });
        break;
      }
    }
    return result;
  }
}
