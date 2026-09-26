// Production server for the SSR build. It mirrors what `react-router-serve`
// does (compression, immutable /assets, static files from build/client, the
// React Router request handler for everything else) with one difference:
// prerendered routes are served at their extensionless URL.
//
// `react-router-serve` uses express.static with its default directory
// redirect, so "/privacy" answered 301 → "/privacy/" because the prerender
// writes build/client/privacy/index.html. The sitemap and every page's
// canonical tag name the slash-less URL, so Google saw a canonical that
// redirects and filed those pages as "duplicate without user-selected
// canonical". Here the index.html is sent directly and the directory
// redirect is off, so "/privacy" is a 200 like every other page.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Must run before anything that pulls in React: react's entry picks its
// development or production build by NODE_ENV at load time, and a server
// where react-router loaded react in development mode while react-dom/server
// loaded in production mode throws "dispatcher.getOwner is not a function"
// on every render. Static imports are hoisted above this line, so the
// packages are imported dynamically below.
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const [{ createRequestHandler }, { default: compression }, { default: express }, { default: morgan }] =
  await Promise.all([
    import("@react-router/express"),
    import("compression"),
    import("express"),
    import("morgan"),
  ]);

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "build");
const clientDir = path.join(buildDir, "client");
const serverBuild = await import(pathToFileURL(path.join(buildDir, "server", "index.js")).href);

const app = express();
app.disable("x-powered-by");
app.use(compression());

// Hashed bundles: cache forever.
app.use("/assets", express.static(path.join(clientDir, "assets"), { immutable: true, maxAge: "1y" }));

// Prerendered HTML at its canonical, slash-less URL. Only extensionless GET
// and HEAD paths qualify; anything else falls through to the static files
// or the request handler.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path === "/" || req.path.endsWith("/") || path.posix.extname(req.path) !== "") return next();
  const file = path.join(clientDir, req.path, "index.html");
  // req.path is not URL-decoded (encoded dots stay literal); path.join
  // normalizes any raw ".." and the prefix check rejects escapes.
  if (!file.startsWith(clientDir + path.sep)) return next();
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) return next();
    res.sendFile(file, (sendError) => {
      if (sendError) next(sendError);
    });
  });
});

// Everything else in build/client (the prerendered "/" index.html, .data
// files, copies of public/); no directory redirect.
app.use(express.static(clientDir, { redirect: false }));
app.use(express.static(path.join(here, "public"), { maxAge: "1h" }));

app.use(morgan("tiny"));
app.all("*", createRequestHandler({ build: serverBuild, mode: process.env.NODE_ENV }));

const port = Number(process.env.PORT) || 3000;
const server = process.env.HOST
  ? app.listen(port, process.env.HOST, onListen)
  : app.listen(port, onListen);

function onListen() {
  console.log(`[server] http://localhost:${port}`);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(console.error));
}
