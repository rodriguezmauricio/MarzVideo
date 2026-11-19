import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { nextTheme, onThemeChange, readTheme, setTheme, type ThemeChoice } from "../theme";

const LABEL: Record<ThemeChoice, string> = { dark: "Dark theme", light: "Light theme", system: "Windows theme" };
const TIP: Record<ThemeChoice, string> = { dark: "Switch to light", light: "Switch to follow Windows", system: "Switch to dark" };

/** Home strip toggle: one click cycles Dark, Light, Windows. Self-contained so it can move to Settings. */
export function ThemeButton() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  useEffect(() => onThemeChange(setChoice), []);
  return (
    <button
      type="button"
      className="h-settings tip-left"
      data-tip={TIP[choice]}
      onClick={() => setTheme(nextTheme(choice))}
      data-testid="theme-button"
    >
      <Icon name="contrast" size={14} />
      {LABEL[choice]}
    </button>
  );
}
