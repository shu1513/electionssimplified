import { execSync } from "node:child_process";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// The Sentry release must match between the SDK init and the source-map
// upload or stacks stay minified. DEPLOY_RELEASE is authoritative at deploy
// time; local builds fall back to the current git SHA.
function resolveRelease(): string | undefined {
  const fromEnv = process.env.DEPLOY_RELEASE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

const release = resolveRelease();
// Source maps upload to Sentry only when a CI/deploy token is present; the
// maps are generated hidden (no sourceMappingURL comment, nothing served
// publicly) and deleted from the React Router client build after upload.
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN?.trim());

// Dev proxy makes the app same-origin with the backend: no CORS config, and
// the SameSite=Lax session cookie just works. Test config lives in
// vitest.config.ts (vite 8 and vitest's bundled vite types conflict).
//
// ADDRESS_API_PROXY_TARGET lets a second dev stack (e.g. a worktree session)
// point its frontend at a backend on an alternate ADDRESS_API_PORT while the
// main checkout's backend still holds 3001.
const apiProxyTarget = process.env.ADDRESS_API_PROXY_TARGET ?? "http://127.0.0.1:3001";

// /api/geo-hint is answered by the Cloudflare Worker in production
// (infra/cloudflare/router-worker.js), so a dev stack has no edge to answer
// it and the home page's nearby-elections block never shows. DEV_GEO_HINT
// ("CA/Fresno": state abbreviation, slash, city) stubs the hint in dev; unset,
// the path proxies to the backend and 404s like a Worker-less deploy.
const devGeoHint = (() => {
  const match = /^([A-Za-z]{2})\/(.+)$/.exec(process.env.DEV_GEO_HINT?.trim() ?? "");
  return match ? { state: match[1].toUpperCase(), city: match[2].trim() } : null;
})();
const devGeoHintPlugin: Plugin = {
  name: "voteapp-dev-geo-hint",
  // configureServer middlewares run ahead of Vite's own, including the /api
  // proxy, so this path never reaches the backend while the stub is on.
  configureServer(server) {
    server.middlewares.use("/api/geo-hint", (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ location: devGeoHint }));
    });
  },
};

export default defineConfig({
  plugins: [
    reactRouter(),
    tailwindcss(),
    ...(devGeoHint ? [devGeoHintPlugin] : []),
    ...(uploadSourceMaps
      ? [
          sentryVitePlugin({
            org: "solo-developer-xv",
            project: "voteapp-frontend",
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: release ? { name: release } : undefined,
            sourcemaps: { filesToDeleteAfterUpload: ["build/client/**/*.map"] },
          }),
        ]
      : []),
  ],
  define: {
    "import.meta.env.VITE_RELEASE": JSON.stringify(release ?? ""),
  },
  resolve: {
    // Pin the workspace package to THIS checkout's sources. Without the
    // alias, node resolution walks into node_modules — which a worktree
    // symlinks to the main checkout — so a worktree dev server would serve
    // the main checkout's api-client instead of the code under review. In
    // the main checkout the alias resolves to the same files as before.
    alias: {
      "@voteapp/api-client": path.resolve(__dirname, "../packages/api-client/src/index.ts"),
    },
  },
  build: {
    sourcemap: uploadSourceMaps ? "hidden" : false,
  },
  server: {
    // Harness-assigned port (e.g. Claude Code preview autoPort); vite does
    // not read PORT on its own. Strict only when PORT is assigned: a silent
    // fallback would leave the preview pointed at the wrong port, but manual
    // `npm run dev` should keep vite's pick-next-free-port behavior.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    strictPort: Boolean(process.env.PORT),
    proxy: {
      "/api": {
        target: apiProxyTarget,
        // Browsers attach an Origin header to POSTs even same-origin; the
        // backend's CORS allowlist would reject it. The proxy makes the app
        // same-origin in substance, so drop the header to match.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
          });
        },
      },
      "/sitemap.xml": {
        target: apiProxyTarget,
      },
    },
    fs: {
      // The disclaimer page raw-imports docs/legal/disclaimer.md. Allow ONLY
      // that directory beyond the app root: widening to the repo root would
      // let the dev server serve arbitrary repo files (backend/.env holds
      // real credentials).
      allow: [".", path.resolve(__dirname, "../docs/legal")],
    },
  },
});
