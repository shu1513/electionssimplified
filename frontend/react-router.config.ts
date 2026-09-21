import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "src",
  // Server-render at request time so non-JS crawlers (GPTBot, ClaudeBot,
  // PerplexityBot) can read election/candidate content; the listed static
  // routes still prerender at build time and are served as static HTML.
  ssr: true,
  prerender: ["/", "/mission", "/embed-instructions", "/support", "/support/member", "/support/once", "/disclaimer", "/terms", "/privacy", "/register", "/login"],
} satisfies Config;
