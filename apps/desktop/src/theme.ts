// App theme (DESIGN-SYSTEM.md section 3 "Light theme"). The choice is an app preference in localStorage;
// every window applies it to <html data-theme> and follows changes made in other windows and in Windows.
// Only the app chrome changes: video code reads the fixed --brand-* tokens.

export type ThemeChoice = "dark" | "light" | "system";
export type Theme = "dark" | "light";

export const THEME_KEY = "marz.theme";
export const THEME_ORDER: ThemeChoice[] = ["dark", "light", "system"];

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function parseTheme(v: string | null | undefined): ThemeChoice {
  return v === "light" || v === "system" ? v : "dark";
}

export function readTheme(): ThemeChoice {
  try {
    return parseTheme(storage()?.getItem(THEME_KEY));
  } catch {
    return "dark";
  }
}

export function nextTheme(c: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(c) + 1) % THEME_ORDER.length] ?? "dark";
}

export function resolveTheme(c: ThemeChoice, windowsPrefersLight: boolean): Theme {
  if (c === "system") return windowsPrefersLight ? "light" : "dark";
  return c;
}

function systemQuery(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  } catch {
    return null;
  }
}

function apply(c: ThemeChoice): void {
  const theme = resolveTheme(c, systemQuery()?.matches ?? false);
  document.documentElement.dataset.theme = theme;
}

const listeners = new Set<(c: ThemeChoice) => void>();

export function setTheme(c: ThemeChoice): void {
  try {
    storage()?.setItem(THEME_KEY, c);
  } catch {
    /* not saved: still applied for this window */
  }
  apply(c);
  listeners.forEach((f) => f(c));
}

export function onThemeChange(f: (c: ThemeChoice) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

let started = false;

/** Applies the stored choice now and keeps following it. Call once per window, before the first render. */
export function startTheme(): void {
  apply(readTheme());
  if (started) return;
  started = true;
  systemQuery()?.addEventListener?.("change", () => {
    if (readTheme() === "system") apply("system");
  });
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY) return;
    const c = parseTheme(e.newValue);
    apply(c);
    listeners.forEach((f) => f(c));
  });
}
