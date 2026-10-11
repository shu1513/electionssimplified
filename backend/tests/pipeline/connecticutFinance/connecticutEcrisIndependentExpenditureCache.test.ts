import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runRefreshConnecticutEcrisIndependentExpendituresScript } from "../../../src/scripts/refreshConnecticutEcrisIndependentExpenditures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getConnecticutEcrisIndependentExpenditureCachePath,
  readConnecticutEcrisIndependentExpenditureCache,
  writeConnecticutEcrisIndependentExpenditureCache,
} from "../../../src/pipeline/connecticutFinance/connecticutEcrisIndependentExpenditureCache.js";
import type { ConnecticutEcrisIndependentExpenditureRow } from "../../../src/pipeline/connecticutFinance/connecticutEcrisIndependentExpenditureParsers.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voteapp-ct-ecris-ie-cache-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function row(overrides: Partial<ConnecticutEcrisIndependentExpenditureRow> = {}): ConnecticutEcrisIndependentExpenditureRow {
  return {
    rootExpenditureId: "0",
    committeeName: "Nutmeg Forward",
    formTag: "SEEC40",
    documentUrl: "https://seec.ct.gov/eCrisReporting/Data/Attachment/Unassigned/SEEC40_July_10_Filing_1.PDF",
    reportType: "July 10 Filing",
    documentType: "Original",
    payee: "Vendor",
    receivedDate: "2026-06-30",
    fileYear: 2026,
    periodStartDate: "2026-04-01",
    periodEndDate: "2026-06-30",
    amountCents: 1000,
    formSection: "G. Expenses Paid by Committee",
    supportingCandidates: ["Jane Q Doe"],
    supportingOffices: ["State Representative"],
    opposingCandidates: [],
    opposingOffices: [],
    dataSource: "eFile",
    ...overrides,
  };
}

describe("connecticutEcrisIndependentExpenditureCache", () => {
  it("writes and reads back a yearly artifact", async () => {
    const cacheDir = await makeTempDir();
    const rows = [row(), row({ amountCents: null, formTag: "SEEC40", supportingCandidates: [] })];

    const written = await writeConnecticutEcrisIndependentExpenditureCache({
      cacheDir,
      now: new Date("2026-09-01T12:00:00.000Z"),
      fetchResult: {
        year: 2026,
        sourceUrl: "https://seec.ct.gov/eCrisReporting/SearchingIndependentExpenditure.aspx",
        rows,
        searchWindows: [{ startDate: "2026-01-01", endDate: "2026-12-31", rowCount: 2 }],
      },
    });

    expect(written.filePath).toBe(getConnecticutEcrisIndependentExpenditureCachePath({ cacheDir, year: 2026 }));
    expect(written.filePath.endsWith("/2026_independent_expenditures.json")).toBe(true);
    expect(written.artifact).toMatchObject({ version: 1, year: 2026, fetchedAt: "2026-09-01T12:00:00.000Z", rowCount: 2 });

    const read = await readConnecticutEcrisIndependentExpenditureCache({ cacheDir, year: 2026 });
    expect(read).toEqual(written.artifact);
    expect(JSON.parse(await readFile(written.filePath, "utf8"))).toEqual(written.artifact);
  });

  it("returns null when the year has no artifact", async () => {
    const cacheDir = await makeTempDir();

    await expect(readConnecticutEcrisIndependentExpenditureCache({ cacheDir, year: 2024 })).resolves.toBeNull();
  });

  it("rejects a malformed artifact instead of syncing from it", async () => {
    const cacheDir = await makeTempDir();
    const filePath = getConnecticutEcrisIndependentExpenditureCachePath({ cacheDir, year: 2026 });
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, year: 2026, fetchedAt: "x", sourceUrl: "y", searchWindows: [], rowCount: 1, rows: [{ committeeName: 1 }] })
    );

    await expect(readConnecticutEcrisIndependentExpenditureCache({ cacheDir, year: 2026 })).rejects.toThrow(
      "Malformed Connecticut eCRIS independent expenditure artifact"
    );
  });
});

it("keeps the saved IE artifact when the live refresh fails", async () => {
  const cacheDir = await makeTempDir();
  const written = await writeConnecticutEcrisIndependentExpenditureCache({
    cacheDir, fetchResult: { year: 2026, sourceUrl: "https://seec.ct.gov/eCrisReporting/SearchingIndependentExpenditure.aspx", rows: [row()], searchWindows: [] },
  });
  const before = await readFile(written.filePath, "utf8");
  await expect(runRefreshConnecticutEcrisIndependentExpendituresScript({
    options: { year: 2026, cacheDir, force: true, timeoutMs: 1000 },
    fetchImpl: async () => new Response("Unavailable", { status: 503 }),
  })).rejects.toThrow();
  expect(await readFile(written.filePath, "utf8")).toBe(before);
});
