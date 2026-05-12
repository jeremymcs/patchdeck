import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

type Mode = "system" | "light" | "dark";

const ORDER: Mode[] = ["system", "light", "dark"];

const LABELS: Record<Mode, string> = {
  system: "Match system",
  light: "Light",
  dark: "Dark",
};

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const current: Mode = (theme as Mode | undefined) ?? "system";
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  const showDark = mounted && (current === "dark" || (current === "system" && resolvedTheme === "dark"));
  const ariaLabel = mounted ? `Theme: ${LABELS[current]}. Click for ${LABELS[next]}.` : "Toggle theme";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={ariaLabel}
      title={ariaLabel}
      data-testid="theme-toggle"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background cursor-pointer"
    >
      {mounted && current === "system" ? (
        <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
      ) : showDark ? (
        <Moon className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Sun className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}
