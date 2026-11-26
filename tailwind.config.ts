import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: { colors: { bg: "var(--bg)", ink: "var(--ink)", mute: "var(--mute)", sky: "var(--blue)", wash: "var(--blue2)" },
    fontFamily: { sans: ["Sora", "system-ui", "sans-serif"] } } },
} satisfies Config;
