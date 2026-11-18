import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        // Status colors
        status: {
          running: "#f59e0b",
          submitted: "#10b981",
          failed: "#ef4444",
          cancelled: "#71717a",
          awaiting: "#f59e0b",
          stuck: "#ef4444",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
