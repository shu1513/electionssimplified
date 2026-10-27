import { pathToFileURL } from "node:url";
import { loadProjectEnv } from "../config/env.js";
import { isRhodeIslandErtsRawDataRefreshEnabled } from "../config/featureFlags.js";
import { createErtsTransport } from "../pipeline/rhodeIslandFinance/rhodeIslandErtsClient.js";
import { DEFAULT_RHODE_ISLAND_ERTS_CACHE_DIR } from "../pipeline/rhodeIslandFinance/rhodeIslandErtsArtifactCache.js";
import { acquireRhodeIslandCf8Filer } from "../pipeline/rhodeIslandFinance/rhodeIslandCf8FilerCache.js";
import { readStrictFlagValues } from "../utils/cliFlags.js";

export function parseRefreshRhodeIslandCf8FilerArgs(args: readonly string[]) {
  const names = ["--cycle-year", "--filer", "--cache-dir"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, name = arg.split("=", 1)[0]!;
    if (!names.includes(name)) throw new Error("Unknown Rhode Island CF8 refresh option");
    if (arg === name) i++;
  }
  const read = (name: string) => {
    const values = readStrictFlagValues(args, name);
    if (values.length > 1) throw new Error("Duplicate Rhode Island CF8 refresh option");
    return values[0];
  };
  const year = read("--cycle-year"), spenderName = read("--filer")?.trim();
  if (!year || !/^\d{4}$/u.test(year) || Number(year) < 2000 || Number(year) > 2100 || Number(year) % 2 !== 0 ||
    !spenderName || spenderName.length > 500 || /[\x00-\x1f\x7f]/u.test(spenderName))
    throw new Error("An even cycle year and exact native filer name are required");
  return { electionYear: Number(year), spenderName, cacheDir: read("--cache-dir")?.trim() || DEFAULT_RHODE_ISLAND_ERTS_CACHE_DIR };
}

/** Default paced public client, no receiving organization or financial write. */
export async function runRefreshRhodeIslandCf8Filer(input: ReturnType<typeof parseRefreshRhodeIslandCf8FilerArgs>) {
  if (!isRhodeIslandErtsRawDataRefreshEnabled()) throw new Error("Rhode Island raw refresh is disabled");
  return acquireRhodeIslandCf8Filer({ ...input, transport: createErtsTransport() });
}

async function main() {
  process.umask(0o077);
  loadProjectEnv();
  const result = await runRefreshRhodeIslandCf8Filer(parseRefreshRhodeIslandCf8FilerArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ status: "acquired", ...result, financialWrites: 0 }));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error("Rhode Island CF8 source refresh held; previous generation preserved"); process.exitCode = 1; });
}
