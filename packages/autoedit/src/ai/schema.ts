/** JSON Schema of `AiResult`, given to `claude -p --json-schema`. */
export const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mistakes", "contextFillers", "zooms"],
  properties: {
    mistakes: {
      type: "array",
      description: "Word ranges to cut: false starts, restarted sentences, repeated takes. Keep the last good try.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fromWordId", "toWordId", "why"],
        properties: {
          fromWordId: { type: "string" },
          toWordId: { type: "string" },
          why: { type: "string", description: "A few words, e.g. restarted sentence, repeated take." },
        },
      },
    },
    contextFillers: {
      type: "array",
      description: "Ids of single words that are filler here and carry no meaning.",
      items: { type: "string" },
    },
    zooms: {
      type: "array",
      description: "Zoom candidates to use, each spanning the words that talk about that spot on screen.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "fromWordId", "toWordId"],
        properties: {
          candidateId: { type: "string" },
          fromWordId: { type: "string" },
          toWordId: { type: "string" },
        },
      },
    },
  },
} as const;
