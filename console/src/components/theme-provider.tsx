// Adapted from https://ui.shadcn.com/docs/dark-mode/vite.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "dark" | "light" | "system";
const ThemeContext = createContext<
  { theme: Theme; setTheme: (theme: Theme) => void } | undefined
>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(() => {
    try {
      const value = localStorage.getItem("cody-theme");
      return value === "dark" || value === "light" ? value : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(
        theme === "system" ? (media.matches ? "dark" : "light") : theme,
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme: (value) => {
          try {
            localStorage.setItem("cody-theme", value);
          } catch {
            /* Session-only theme if storage is unavailable. */
          }
          updateTheme(value);
        },
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
