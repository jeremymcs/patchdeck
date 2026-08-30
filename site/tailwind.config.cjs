// PatchDeck Website — Tailwind theme tokens
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html"],
  theme: {
    extend: {
      colors: {
        // Product surfaces — matches the real dashboard chrome.
        ink: {
          950: "#08090C",
          900: "#0B0D11",
          850: "#0F1116",
          800: "#141720",
          700: "#1C202B",
          600: "#272C3A",
        },
        // Primary CTA — design-system "run green".
        run: {
          400: "#4ADE80",
          500: "#22C55E",
          600: "#16A34A",
        },
        // Live status accents, lifted from the app's own state colors.
        state: {
          processing: "#60A5FA",
          progress: "#F59E0B",
          failed: "#EF4444",
          resolved: "#22C55E",
        },
      },
      fontFamily: {
        mono: [
          "Fira Code",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
        sans: [
          "Fira Sans",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
      maxWidth: {
        shell: "76rem",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        "rise": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 2s ease-in-out infinite",
        rise: "rise 0.5s ease-out both",
      },
    },
  },
  plugins: [],
};
