/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ----------------------------------------------------
        // GITINGEST DESIGN LANGUAGE (theme-aware tokens)
        // The FULL palette is theme-selectable — canvas, ink,
        // hairline, field and the neutral ramp all shift per
        // theme (see src/theme.tsx). gray-* maps to the same
        // vars so every outline/muted/hairline usage follows
        // the active theme automatically.
        // ----------------------------------------------------
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        // Every literal `bg-white` / `text-white` rectangle follows
        // the ACTIVE theme's surface tint (each theme owns a
        // distinct near-white: ivory, apricot, ice, peach, ...).
        white: "rgb(var(--surface) / <alpha-value>)",
        surfaceAlt: "rgb(var(--surface-alt) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        field: "rgb(var(--field) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        accentSoft: "rgb(var(--accent-soft) / <alpha-value>)",

        // Auto-legibility text colors (picked per theme at runtime).
        onAccent: "rgb(var(--on-accent) / <alpha-value>)",
        onInk: "rgb(var(--on-ink) / <alpha-value>)",

        // Theme-driven neutral ramp (defaults to the amber ramp).
        gray: {
          50: "rgb(var(--gray-50) / <alpha-value>)",
          100: "rgb(var(--gray-100) / <alpha-value>)",
          200: "rgb(var(--gray-200) / <alpha-value>)",
          300: "rgb(var(--gray-300) / <alpha-value>)",
          400: "rgb(var(--gray-400) / <alpha-value>)",
          500: "rgb(var(--gray-500) / <alpha-value>)",
          600: "rgb(var(--gray-600) / <alpha-value>)",
          700: "rgb(var(--gray-700) / <alpha-value>)",
          800: "rgb(var(--gray-800) / <alpha-value>)",
          900: "rgb(var(--gray-900) / <alpha-value>)",
          950: "rgb(var(--gray-950) / <alpha-value>)",
        },

        // ----------------------------------------------------
        // Legacy aliases — kept so older class names still
        // resolve to the light design instead of breaking.
        // ----------------------------------------------------
        navy: "rgb(var(--canvas) / <alpha-value>)",
        line: "rgb(var(--hairline) / <alpha-value>)",
        gold: "rgb(var(--accent) / <alpha-value>)",

        // ----------------------------------------------------
        // Data-viz / taxonomy colors. The pipeline signal colors
        // (tfidf / sbert / meta) and the subject tag colors
        // (cs / math) all derive from the theme accent at
        // runtime — these tokens map to CSS variables.
        // ----------------------------------------------------
        tfidf: "rgb(var(--signal-tfidf) / <alpha-value>)",
        sbert: "rgb(var(--signal-sbert) / <alpha-value>)",
        meta: "rgb(var(--signal-meta) / <alpha-value>)",
        cs: "rgb(var(--tag-cs) / <alpha-value>)",
        math: "rgb(var(--tag-math) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-body, Inter)", "system-ui", "sans-serif"],
        // Pixel/Inter combination: the retro (mono) layer renders
        // in Pixelify Sans; Inter handles the body/UI text.
        mono: ["var(--font-display, Pixelify Sans)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
