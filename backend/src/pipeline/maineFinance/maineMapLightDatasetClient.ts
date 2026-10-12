import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

import {
  MAINE_MAPLIGHT_DATASET_CATALOG_URL,
  MAINE_MAPLIGHT_DATASET_GUIDE_MD_URL,
  MAINE_MAPLIGHT_DATASET_ORIGIN,
  decodeMaineMapLightDatasetCatalog,
  decodeMaineMapLightDatasetGuide,
  selectMaineMapLightDatasetAttachment,
  sameMaineMapLightDatasetSelection,
} from "./maineMapLightDatasetCatalog.js";
import { parseMaineMapLightAllFilerCsv } from "./maineMapLightAllFilerCsv.js";
import { parseMaineMapLightIndependentExpenditureCsv } from "./maineMapLightIndependentExpenditureCsv.js";

type Dataset = "all_filers" | "independent_expenditures";
type Selection = ReturnType<typeof selectMaineMapLightDatasetAttachment>;
type CatalogPage = ReturnType<typeof decodeMaineMapLightDatasetCatalog>;
type Artifact = {
  file: string;
  publicPath: string;
  startedAt: string;
  completedAt: string;
  status: number;
  bytes: number;
  sha256: string;
  redirected: boolean;
  reused: boolean;
};
type Manifest = {
  version: 1;
  year: number;
  openingGuide: Artifact;
  openingCatalog: Artifact[];
  datasets: Record<Dataset, Artifact>;
  closingGuide: Artifact;
  closingCatalog: Artifact[];
};

export type MaineMapLightDatasetCapture = {
  directory: string;
  capturedAt: string;
  captureDigest: string;
  selections: Record<Dataset, Selection>;
  datasets: Record<Dataset, Artifact & { path: string }>;
};

export type MaineMapLightDatasetCaptureResult =
  | { status: "captured"; capture: MaineMapLightDatasetCapture }
  | {
      status: "unavailable";
      previousCacheVerified: boolean;
      diagnostic: string;
    };

const DATASETS: readonly Dataset[] = ["independent_expenditures", "all_filers"];
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(): never {
  // Fetch errors and signed storage URLs must never enter diagnostics.
  throw new Error("Maine published dataset capture is unavailable");
}

function publicRedirect(raw: string, base: string): string {
  const url = new URL(raw, base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    /(^|\.)(localhost|local|internal)$/.test(url.hostname)
  )
    fail();
  return url.href;
}

/** Immutable publisher bodies, not a financial acceptance or latest-edition claim. */
export async function captureMaineMapLightDatasets(input: {
  cacheDir: string;
  year: number;
  refresh?: boolean;
  cacheOnly?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxDatasetBytes?: number;
  maxCatalogPages?: number;
}): Promise<MaineMapLightDatasetCaptureResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const cacheDir = input.cacheDir;
  const year = input.year;
  const refresh = input.refresh === true;
  const cacheOnly = input.cacheOnly === true;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const maxBytes = input.maxDatasetBytes ?? 64 * 1024 * 1024;
  const maxPages = input.maxCatalogPages ?? 20;
  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isInteger(maxPages) ||
    maxPages <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    fail();

  // Saved source comes first. Its HTTP intervals are never retimed on reuse.
  let saved:
    | {
        directory: string;
        manifest: Manifest;
        captureDigest: string;
        selections: Record<Dataset, Selection>;
      }
    | undefined;
  const text = (body: Buffer): string =>
    new TextDecoder("utf-8", { fatal: true }).decode(body);
  const verifiedBody = async (
    directory: string,
    artifact: Artifact,
    expectedPath: string,
  ): Promise<Buffer> => {
    if (
      !artifact ||
      !/^[a-z0-9_-]+\.(md|json|csv)$/.test(artifact.file) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      artifact.status !== 200 ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      !Number.isFinite(Date.parse(artifact.startedAt)) ||
      !Number.isFinite(Date.parse(artifact.completedAt)) ||
      Date.parse(artifact.completedAt) < Date.parse(artifact.startedAt) ||
      artifact.publicPath !== expectedPath
    )
      fail();
    const body = await readFile(join(directory, artifact.file));
    if (body.length !== artifact.bytes || hash(body) !== artifact.sha256)
      fail();
    return body;
  };
  const decodePages = async (
    directory: string,
    artifacts: Artifact[],
  ): Promise<CatalogPage[]> => {
    if (
      !Array.isArray(artifacts) ||
      !artifacts.length ||
      artifacts.length > maxPages
    )
      fail();
    const pages: CatalogPage[] = [];
    let url: string | null = MAINE_MAPLIGHT_DATASET_CATALOG_URL;
    for (const artifact of artifacts) {
      if (!url) fail();
      const body = await verifiedBody(
        directory,
        artifact,
        new URL(url).pathname,
      );
      const page = decodeMaineMapLightDatasetCatalog(text(body), {
        sourceUrl: url,
      });
      pages.push(page);
      url = page.nextUrl;
    }
    if (url) fail();
    return pages;
  };
  const selections = (
    guide: string,
    pages: CatalogPage[],
  ): Record<Dataset, Selection> =>
    Object.fromEntries(
      DATASETS.map((dataset) => [
        dataset,
        selectMaineMapLightDatasetAttachment(
          decodeMaineMapLightDatasetGuide(guide, { dataset, year }),
          pages,
        ),
      ]),
    ) as Record<Dataset, Selection>;
  const validateCsv = (dataset: Dataset, body: Buffer): void => {
    if (dataset === "all_filers") parseMaineMapLightAllFilerCsv(text(body));
    else parseMaineMapLightIndependentExpenditureCsv(text(body));
  };
  try {
    const pointer = JSON.parse(
      await readFile(join(cacheDir, "current.json"), "utf8"),
    );
    if (
      !pointer ||
      pointer.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(pointer.generation) ||
      !/^[a-f0-9]{64}$/.test(pointer.manifestSha256)
    )
      fail();
    const directory = join(cacheDir, pointer.generation);
    const manifestBytes = await readFile(join(directory, "manifest.json"));
    if (hash(manifestBytes) !== pointer.manifestSha256) fail();
    const manifest: Manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.version !== 1 || manifest.year !== year) fail();
    const guidePath = new URL(MAINE_MAPLIGHT_DATASET_GUIDE_MD_URL).pathname;
    const opening = selections(
      text(await verifiedBody(directory, manifest.openingGuide, guidePath)),
      await decodePages(directory, manifest.openingCatalog),
    );
    const closing = selections(
      text(await verifiedBody(directory, manifest.closingGuide, guidePath)),
      await decodePages(directory, manifest.closingCatalog),
    );
    for (const dataset of DATASETS) {
      if (
        !sameMaineMapLightDatasetSelection(opening[dataset], closing[dataset])
      )
        fail();
      const body = await verifiedBody(
        directory,
        manifest.datasets[dataset],
        new URL(
          opening[dataset].attachment.downloadLink,
          MAINE_MAPLIGHT_DATASET_ORIGIN,
        ).pathname,
      );
      if (body.length !== opening[dataset].attachment.fileSize) fail();
      validateCsv(dataset, body);
    }
    saved = {
      directory,
      manifest,
      captureDigest: hash(manifestBytes),
      selections: closing,
    };
  } catch {
    // Corrupt/missing cache can be repaired by a fresh complete source capture.
  }

  if (cacheOnly) {
    if (!saved)
      return {
        status: "unavailable",
        previousCacheVerified: false,
        diagnostic:
          "Maine saved dataset capture is unavailable; preserve stored financial components",
      };
    return {
      status: "captured",
      capture: {
        directory: saved.directory,
        captureDigest: saved.captureDigest,
        capturedAt: saved.manifest.closingCatalog.at(-1)!.completedAt,
        selections: saved.selections,
        datasets: Object.fromEntries(
          DATASETS.map((dataset) => [
            dataset,
            {
              ...saved!.manifest.datasets[dataset],
              path: join(
                saved!.directory,
                saved!.manifest.datasets[dataset].file,
              ),
            },
          ]),
        ) as MaineMapLightDatasetCapture["datasets"],
      },
    };
  }

  const generation = randomUUID();
  const directory = join(cacheDir, generation);
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    const request = async (
      url: string,
      file: string,
      limit: number,
      allowRedirect = false,
    ): Promise<{ artifact: Artifact; body: Buffer }> => {
      const startedAt = new Date().toISOString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit = {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
          },
          signal: controller.signal,
        };
        let response = await fetchImpl(url, init);
        let redirected = false;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!allowRedirect) fail();
          const location = response.headers.get("location");
          if (!location) fail();
          await response.body?.cancel();
          response = await fetchImpl(publicRedirect(location, url), init);
          redirected = true;
        }
        if (response.status !== 200 || !response.body) fail();
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > limit) {
              await reader.cancel();
              fail();
            }
            chunks.push(Buffer.from(chunk.value));
          }
        } finally {
          reader.releaseLock();
        }
        const body = Buffer.concat(chunks);
        const artifact: Artifact = {
          file,
          publicPath: new URL(url).pathname,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 200,
          bytes,
          sha256: hash(body),
          redirected,
          reused: false,
        };
        await writeFile(join(directory, file), body, {
          mode: 0o600,
          flag: "wx",
        });
        return { artifact, body };
      } finally {
        clearTimeout(timer);
      }
    };
    const observe = async (phase: "opening" | "closing") => {
      const guide = await request(
        MAINE_MAPLIGHT_DATASET_GUIDE_MD_URL,
        `${phase}-guide.md`,
        1024 * 1024,
      );
      const catalog: Artifact[] = [];
      const pages: CatalogPage[] = [];
      const visited = new Set<string>();
      let url: string | null = MAINE_MAPLIGHT_DATASET_CATALOG_URL;
      while (url) {
        if (pages.length >= maxPages || visited.has(url)) fail();
        visited.add(url);
        const result = await request(
          url,
          `${phase}-catalog-${pages.length}.json`,
          8 * 1024 * 1024,
        );
        const page = decodeMaineMapLightDatasetCatalog(text(result.body), {
          sourceUrl: url,
        });
        catalog.push(result.artifact);
        pages.push(page);
        url = page.nextUrl;
      }
      return {
        guide: guide.artifact,
        catalog,
        selections: selections(text(guide.body), pages),
      };
    };
    const opening = await observe("opening");
    const datasets = {} as Record<Dataset, Artifact>;
    for (const dataset of DATASETS) {
      const selected = opening.selections[dataset];
      if (selected.attachment.fileSize > maxBytes) fail();
      const file = `${dataset}.csv`;
      if (
        !refresh &&
        saved &&
        sameMaineMapLightDatasetSelection(saved.selections[dataset], selected)
      ) {
        const original = saved.manifest.datasets[dataset];
        const body = await verifiedBody(
          saved.directory,
          original,
          new URL(
            selected.attachment.downloadLink,
            MAINE_MAPLIGHT_DATASET_ORIGIN,
          ).pathname,
        );
        await writeFile(join(directory, file), body, {
          mode: 0o600,
          flag: "wx",
        });
        datasets[dataset] = { ...original, file, reused: true };
      } else {
        const url = new URL(
          selected.attachment.downloadLink,
          MAINE_MAPLIGHT_DATASET_ORIGIN,
        ).href;
        const result = await request(url, file, maxBytes, true);
        if (result.body.length !== selected.attachment.fileSize) fail();
        validateCsv(dataset, result.body);
        datasets[dataset] = result.artifact;
      }
    }
    const closing = await observe("closing");
    for (const dataset of DATASETS) {
      if (
        !sameMaineMapLightDatasetSelection(
          opening.selections[dataset],
          closing.selections[dataset],
        )
      )
        fail();
    }
    const manifest: Manifest = {
      version: 1,
      year,
      openingGuide: opening.guide,
      openingCatalog: opening.catalog,
      datasets,
      closingGuide: closing.guide,
      closingCatalog: closing.catalog,
    };
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    const captureDigest = hash(manifestBytes);
    await writeFile(join(directory, "manifest.json"), manifestBytes, {
      mode: 0o600,
      flag: "wx",
    });
    const pointerFile = join(cacheDir, `${generation}.pointer.json`);
    await writeFile(
      pointerFile,
      JSON.stringify({
        version: 1,
        generation,
        manifestSha256: captureDigest,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(pointerFile, join(cacheDir, "current.json"));
    return {
      status: "captured",
      capture: {
        directory,
        captureDigest,
        capturedAt: closing.catalog.at(-1)!.completedAt,
        selections: closing.selections,
        datasets: Object.fromEntries(
          DATASETS.map((dataset) => [
            dataset,
            {
              ...datasets[dataset],
              path: join(directory, datasets[dataset].file),
            },
          ]),
        ) as MaineMapLightDatasetCapture["datasets"],
      },
    };
  } catch {
    return {
      status: "unavailable",
      previousCacheVerified: saved !== undefined,
      diagnostic:
        "Maine published dataset capture is unavailable; preserve stored financial components",
    };
  }
}
