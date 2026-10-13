import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock(
  "../../../src/pipeline/maineFinance/maineMapLightReportControls.js",
  () => ({
    parseMaineMapLightReportControls: (html: string) => {
      if (html !== "complete validated report")
        throw new Error("Source challenge or changed report");
    },
  }),
);
import {
  captureMaineMapLightReport,
  registerMaineMapLightSavedReport,
  validateMaineMapLightReportUrl,
} from "../../../src/pipeline/maineFinance/maineMapLightReportClient.js";
const url = `https://www.mainecampaignfinancedisclosure.com/public/filers/f_${"a".repeat(26)}/filings/d_${"b".repeat(26)}`;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maine-report-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe("Maine normal report acquisition", () => {
  async function savedOriginal(mode: "http" | "browser_dom" = "browser_dom") {
    const body = Buffer.from("complete validated report");
    const bodyFile = join(dir, "original.html"),
      metadataFile = join(dir, "original.json");
    const metadata = {
      sourceMode: mode,
      sourceUrl: url,
      canonicalPath: new URL(url).pathname,
      ...(mode === "http" ? { method: "GET", status: 200 } : {}),
      complete: true,
      startedAt: "2026-10-12T20:58:31Z",
      completedAt: "2026-10-12T20:58:32Z",
      byteCount: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    await writeFile(bodyFile, body);
    await writeFile(metadataFile, JSON.stringify(metadata));
    return {
      bodyFile,
      metadataFile,
      metadata,
      cacheDir: join(dir, "cache"),
      sourceUrl: url,
    };
  }
  it.each(["http", "browser_dom"] as const)(
    "validates/registers genuine saved %s originals without retiming",
    async (mode) => {
      const original = await savedOriginal(mode);
      const imported = await registerMaineMapLightSavedReport(original);
      expect(imported.completedAt).toBe(original.metadata.completedAt);
      const replay = await captureMaineMapLightReport({
        cacheDir: original.cacheDir,
        sourceUrl: url,
        allowNetwork: false,
      });
      expect(replay).toEqual({ status: "captured", report: imported });
      const pointer = JSON.parse(
        await readFile(
          join(
            original.cacheDir,
            createHash("sha256").update(url).digest("hex") + ".json",
          ),
          "utf8",
        ),
      );
      expect(pointer.sourceMode).toBe(mode);
    },
  );
  it.each([
    "wrong URL",
    "tampered bytes",
    "incomplete",
    "fake HTTP status",
    "unrecognized mode",
    "future interval order",
  ])("rejects saved source %s before cache promotion", async (which) => {
    const original = await savedOriginal();
    if (which === "wrong URL") original.metadata.canonicalPath = "/other";
    if (which === "tampered bytes")
      await writeFile(original.bodyFile, "tampered");
    if (which === "incomplete") original.metadata.complete = false;
    if (which === "fake HTTP status")
      Object.assign(original.metadata, { status: 200 });
    if (which === "unrecognized mode")
      Object.assign(original.metadata, { sourceMode: "invented" });
    if (which === "future interval order")
      original.metadata.startedAt = "2030-01-01T00:00:00Z";
    await writeFile(original.metadataFile, JSON.stringify(original.metadata));
    await expect(registerMaineMapLightSavedReport(original)).rejects.toThrow(
      "Maine",
    );
    expect(
      (
        await captureMaineMapLightReport({
          cacheDir: original.cacheDir,
          sourceUrl: url,
          allowNetwork: false,
        })
      ).status,
    ).toBe("unavailable");
  });
  it("captures original bytes once, then verifies saved evidence without retiming or network", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("complete validated report"));
    const first = await captureMaineMapLightReport({
      sourceUrl: url,
      cacheDir: dir,
      allowNetwork: true,
      fetchImpl,
    });
    expect(first.status).toBe("captured");
    const noFetch = vi.fn();
    const replay = await captureMaineMapLightReport({
      sourceUrl: url,
      cacheDir: dir,
      allowNetwork: false,
      fetchImpl: noFetch,
    });
    expect(replay).toEqual(first);
    expect(noFetch).not.toHaveBeenCalled();
    const files = await readdir(dir);
    for (const file of files)
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    const options = fetchImpl.mock.calls[0][1];
    expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(options.headers).not.toHaveProperty("Cookie");
    const metadata = await readFile(
      join(
        dir,
        files.find((f) => f.endsWith(".json"))!,
      ),
      "utf8",
    );
    expect(metadata).not.toMatch(/headers|cookie|location|return_to/i);
  });
  it.each(["http", "challenge", "oversized", "throw"])(
    "fresh %s failure never falls back to previously good report",
    async (which) => {
      await captureMaineMapLightReport({
        sourceUrl: url,
        cacheDir: dir,
        allowNetwork: true,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(new Response("complete validated report")),
      });
      const fetchImpl =
        which === "throw"
          ? vi.fn().mockRejectedValue(new Error("secret transport details"))
          : vi
              .fn()
              .mockResolvedValue(
                new Response(
                  which === "oversized" ? "x".repeat(200) : "challenge",
                  { status: which === "http" ? 403 : 200 },
                ),
              );
      const failed = await captureMaineMapLightReport({
        sourceUrl: url,
        cacheDir: dir,
        allowNetwork: true,
        refresh: true,
        maxBytes: which === "oversized" ? 100 : undefined,
        fetchImpl,
      });
      expect(failed.status).toBe("unavailable");
      expect(JSON.stringify(failed)).not.toContain("secret transport details");
      expect(
        (
          await captureMaineMapLightReport({
            sourceUrl: url,
            cacheDir: dir,
            allowNetwork: false,
          })
        ).status,
      ).toBe("captured");
    },
  );
  it("rejects tampered saved bytes", async () => {
    await captureMaineMapLightReport({
      sourceUrl: url,
      cacheDir: dir,
      allowNetwork: true,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response("complete validated report")),
    });
    const bodyFile = (await readdir(dir)).find((f) => f.endsWith(".html"))!;
    await writeFile(join(dir, bodyFile), "tampered");
    expect(
      (
        await captureMaineMapLightReport({
          sourceUrl: url,
          cacheDir: dir,
          allowNetwork: false,
        })
      ).status,
    ).toBe("unavailable");
  });
  it("missing saved source performs no hidden request", async () => {
    const fetchImpl = vi.fn();
    expect(
      (
        await captureMaineMapLightReport({
          sourceUrl: url,
          cacheDir: dir,
          allowNetwork: false,
          fetchImpl,
        })
      ).status,
    ).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    url + "?secret=token",
    url + "#fragment",
    url.replace("https:", "http:"),
    url.replace("www.mainecampaignfinancedisclosure.com", "evil.example"),
    url.replace("/filings/", "/activities/"),
    url.replace("https://", "https://name:password@"),
  ])("refuses noncanonical reference %s", (bad) => {
    expect(() => validateMaineMapLightReportUrl(bad)).toThrow("Invalid Maine");
  });
});
