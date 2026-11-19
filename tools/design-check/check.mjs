// Design guard. Run: pnpm design:check
// Fails on anything that breaks docs/design/avant-garde/DESIGN-SYSTEM.md.
// Allow a deliberate exception with a comment on the same or previous line:
//   /* design-check-ignore: reason */   or   // design-check-ignore: reason
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "desktop", "src");
const EXT = new Set([".ts", ".tsx", ".css", ".html"]);
const SKIP_FILE = (p) => /tokens\.css$/.test(p) || /\.test\.tsx?$/.test(p);

const COLORS = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black";
const RULES = [
  ["no-radius", /border-radius\s*:\s*(?!0\b)|\brounded(-[a-z0-9]+)?\b/, "Rounded corners are banned (radius is 0)."],
  ["no-shadow", /box-shadow\s*:|drop-shadow|\bshadow(-[a-z0-9]+)?\b/, "Shadows are banned (only the zoom dim and selection ring, which need an ignore comment)."],
  ["no-blur", /backdrop-|\bblur(-[a-z0-9]+)?\b|filter\s*:\s*blur/, "Blur and glass are banned."],
  ["no-gradient", /gradient\(|\bbg-gradient|from-|via-|to-\[/, "Gradients are banned except grid lines and cut hatching (use an ignore comment)."],
  ["no-transition", /\btransition(-[a-z]+)?\b|\banimate-[a-z]+|@keyframes|\bduration-\d+/, "UI state changes are instant: no transitions or animations."],
  ["no-hex", /#[0-9a-fA-F]{3,8}\b(?![0-9a-zA-Z-])/, "Hex colours live only in tokens.css. Use variables or Tailwind names (bg-ink, text-paper, bg-accent, bg-rec)."],
  ["no-rgb", /\brgba?\(|\bhsla?\(/, "Colour functions live only in tokens.css."],
  ["no-default-palette", new RegExp(`\\b(bg|text|border|ring|fill|stroke|outline|divide|from|to|via)-(${COLORS})(-\\d{2,3})?\\b`), "Tailwind default palette is deleted. Use ink, paper, accent, rec, faint, line."],
  ["banned-font", /\b(Inter|Roboto|Arial|Helvetica(?! Neue)|system-ui|Segoe UI|JetBrains Mono|Space Grotesk|IBM Plex|DM Sans|Open Sans|Poppins|Montserrat|Lato|SF Pro|font-sans|font-serif)\b/, "Fonts are Familjen Grotesk (font-display) and Martian Mono (font-mono) only."],
  ["no-emoji", /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "No emoji."],
  ["no-lorem", /lorem ipsum/i, "No placeholder copy."],
  ["theme-in-tokens", /\[data-theme\b|@media[^{]*prefers-color-scheme/, "The light theme lives only in tokens.css (redefine tokens there, never write light-only rules)."],
  ["video-brand-token", /["'`]--(ink|paper|accent|accent-ink|rec|rec-ink)["'`]/, "Video code reads the fixed --brand-* tokens; --ink, --paper, --accent, --rec change with the theme."],
  ["copy-banned-words", /["'`>][^"'`<]*\b(successfully|please|oops|simply)\b[^"'`<]*["'`<]/i, "Banned copy word (see DESIGN-SYSTEM.md section 8)."],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (EXT.has(extname(p)) && !SKIP_FILE(p)) out.push(p);
  }
  return out;
}

let files;
try { files = walk(SRC); } catch { console.error("design-check: apps/desktop/src not found. Run from the repo root."); process.exit(2); }

const problems = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const near = line + " " + (lines[i - 1] ?? "");
    if (/design-check-ignore/.test(near)) return;
    for (const [id, re, msg] of RULES) {
      if (re.test(line)) problems.push(`${relative(ROOT, f).split(sep).join("/")}:${i + 1}  [${id}]  ${msg}\n    ${line.trim().slice(0, 140)}`);
    }
  });
}

// tokens.css must exist and import must be first in index.css
const tokens = join(SRC, "styles", "tokens.css");
try { statSync(tokens); } catch { problems.push("apps/desktop/src/styles/tokens.css is missing. Copy docs/design/avant-garde/tokens.css there."); }
try {
  const idx = readFileSync(join(SRC, "index.css"), "utf8");
  if (!/@import\s+["']\.\/styles\/tokens\.css["']/.test(idx)) problems.push("apps/desktop/src/index.css must import ./styles/tokens.css (first).");
} catch { /* index.css absent: other rules will complain */ }

// Light theme: every themed colour token of the dark :root is redefined in the light block,
// and the app copy of tokens.css equals the design copy.
try {
  const tok = readFileSync(tokens, "utf8").replace(/\r\n/g, "\n");
  const design = readFileSync(join(ROOT, "docs", "design", "avant-garde", "tokens.css"), "utf8").replace(/\r\n/g, "\n");
  if (tok !== design) problems.push("apps/desktop/src/styles/tokens.css differs from docs/design/avant-garde/tokens.css. Edit the design copy, then copy it.");
  const block = (re) => (tok.match(re) ?? [null, ""])[1];
  const names = (css) => new Set([...css.matchAll(/^\s*(--[a-z-]+)\s*:/gm)].map((m) => m[1]));
  const dark = names(block(/^:root\s*\{([\s\S]*?)^\}/m));
  const light = names(block(/^:root\[data-theme="light"\]\s*\{([\s\S]*?)^\}/m));
  if (!light.size) problems.push('tokens.css: the :root[data-theme="light"] block is missing.');
  // Colour tokens that are the same in both themes on purpose (DESIGN-SYSTEM.md "Light theme").
  const FIXED = new Set(["--accent", "--accent-ink", "--rec", "--rec-ink", "--dim", "--dim-rec"]);
  const NOT_COLOUR = /^--(brand-|font-|margin|col-pitch|strip-h|row-h|ruler-h|gutter-w|pps)/;
  for (const n of dark) {
    if (NOT_COLOUR.test(n) || FIXED.has(n)) continue;
    if (!light.has(n)) problems.push(`tokens.css: ${n} is not redefined in the light theme block (or add it to FIXED in tools/design-check/check.mjs with a reason).`);
  }
} catch { /* a missing tokens.css is reported above */ }

if (problems.length) {
  console.error(`design-check: ${problems.length} problem(s)\n\n` + problems.join("\n\n"));
  console.error("\nSee docs/design/avant-garde/DESIGN-SYSTEM.md. Fix the code, do not weaken the rule.");
  process.exit(1);
}
console.log(`design-check: ok (${files.length} files)`);
