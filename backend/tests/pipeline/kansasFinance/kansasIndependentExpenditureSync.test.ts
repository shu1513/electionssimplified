import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptedKansasIEStatements,
  syncKansasIndependentExpenditures,
  validateKansasIEBrowserObservation,
} from "../../../src/pipeline/kansasFinance/kansasIndependentExpenditureSync.js";
import { KANSAS_REVIEWED_IE_STATEMENTS } from "../../../src/pipeline/kansasFinance/kansasReviewedIEStatements.js";
import type { KansasIEPaperDocument } from "../../../src/pipeline/kansasFinance/kansasIndependentExpenditureClient.js";
import * as ieClient from "../../../src/pipeline/kansasFinance/kansasIndependentExpenditureClient.js";

// Keep the reviewed control groups and row arithmetic, with synthetic PDF bytes.
vi.mock(
  "../../../src/pipeline/kansasFinance/kansasReviewedIEStatements.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../src/pipeline/kansasFinance/kansasReviewedIEStatements.js")
      >();
    const { createHash } = await import("node:crypto");
    return {
      ...original,
      KANSAS_REVIEWED_IE_STATEMENTS: original.KANSAS_REVIEWED_IE_STATEMENTS.map(
        (statement) => ({
          ...statement,
          sha256: createHash("sha256")
            .update("%PDF-synthetic reviewed fixture")
            .digest("hex"),
        }),
      ),
    };
  },
);
afterEach(() => vi.restoreAllMocks());

const now = new Date("2026-10-12T18:00:00Z");
function packet() {
  return {
    version: 1,
    kind: "browser-rendered",
    observedAt: "2026-10-12T17:00:00Z",
    sourceUrl:
      "https://sos.ks.gov/elections/cfr_viewer/cfr_examiner_search_results.aspx",
    recordCount: 1,
    scope: {
      filerName: "TEST FUND",
      filingType: "Individual Expenditures",
      startDate: "01/01/2026",
      endDate: "10/12/2026",
    },
    filings: [
      {
        name: "TEST FUND",
        fileDate: "10/08/2026",
        officeSought: "INDIVIDUAL ENTITY",
        district: "",
        filingType: "INDIVIDUAL EXPENDITURES",
        paper: true,
        sourceUrl: KANSAS_REVIEWED_IE_STATEMENTS[0]!.sourceUrl,
        openerObservedAt: "2026-10-12T16:59:00Z",
      },
    ],
  };
}
const fixtureBody = Buffer.from("%PDF-synthetic reviewed fixture");
const fixtureHash = createHash("sha256").update(fixtureBody).digest("hex");
const reviewedFixtures = KANSAS_REVIEWED_IE_STATEMENTS.map((s) => ({
  ...s,
  sha256: fixtureHash,
}));
function originals(): KansasIEPaperDocument[] {
  return reviewedFixtures.map((statement) => ({
    sourceUrl: statement.sourceUrl,
    body: fixtureBody,
    observation: {
      status: 200,
      startedAt: now.toISOString(),
      endedAt: now.toISOString(),
      sha256: statement.sha256,
      byteSize: fixtureBody.byteLength,
    },
  }));
}
const facts = () =>
  new Map(
    KANSAS_REVIEWED_IE_STATEMENTS.map((statement) => [
      statement.sourceUrl,
      { payerName: statement.payerName, filingDate: statement.filingDate },
    ]),
  );

describe("Kansas IE reviewed source controls", () => {
  it("retains every printed occurrence and reconciles all six original document controls", () => {
    const accepted = acceptedKansasIEStatements({
      electionYear: 2026,
      documents: originals(),
      filingFacts: facts(),
      reviewed: reviewedFixtures,
    });
    expect(accepted).toHaveLength(6);
    expect(accepted.flatMap((s) => s.rows)).toHaveLength(61);
    expect(
      accepted
        .flatMap((s) => s.rows)
        .reduce((sum, row) => sum + row.amountCents, 0),
    ).toBe(80209806);
    expect(
      accepted
        .flatMap((s) => s.rows)
        .filter((row) => row.candidateName === "KYLER SWEELY")
        .reduce((sum, row) => sum + row.amountCents, 0),
    ).toBe(7868340);
  });
  it("requires both original October companion documents", () => {
    const accepted = acceptedKansasIEStatements({
      electionYear: 2026,
      documents: originals().filter((d) => !d.sourceUrl.endsWith("65598.pdf")),
      filingFacts: facts(),
      reviewed: reviewedFixtures,
    });
    expect(accepted.map((s) => s.sourceUrl)).not.toContain(
      KANSAS_REVIEWED_IE_STATEMENTS[4]!.sourceUrl,
    );
    expect(accepted).toHaveLength(4);
  });
  it("rejects changed bytes, wrong payer/date and damaged arithmetic", () => {
    const docs = originals();
    docs[0]!.observation.sha256 = "a".repeat(64);
    expect(
      acceptedKansasIEStatements({
        electionYear: 2026,
        documents: docs,
        filingFacts: facts(),
        reviewed: reviewedFixtures,
      }),
    ).toHaveLength(5);
    docs[0]!.observation.sha256 = fixtureHash;
    docs[0]!.body = Buffer.from("changed actual bytes");
    expect(
      acceptedKansasIEStatements({
        electionYear: 2026,
        documents: docs,
        filingFacts: facts(),
        reviewed: reviewedFixtures,
      }),
    ).toHaveLength(5);
    const altered = facts();
    altered.set(docs[1]!.sourceUrl, {
      payerName: "WRONG FUND",
      filingDate: "2026-08-20",
    });
    expect(
      acceptedKansasIEStatements({
        electionYear: 2026,
        documents: originals(),
        filingFacts: altered,
        reviewed: reviewedFixtures,
      }),
    ).toHaveLength(5);
    const reviewed = reviewedFixtures.map((s) => ({ ...s, rows: [...s.rows] }));
    reviewed[0]!.rows[0] = { ...reviewed[0]!.rows[0]!, amountCents: 1 };
    expect(
      acceptedKansasIEStatements({
        electionYear: 2026,
        documents: originals(),
        filingFacts: facts(),
        reviewed,
      }),
    ).toHaveLength(5);
  });
});

describe("Kansas saved rendered observation", () => {
  it("accepts the next-year filed-date window for a prior election cycle", () => {
    const annual = packet();
    annual.scope.endDate = "01/11/2027";
    annual.observedAt = "2027-01-11T17:00:00Z";
    annual.filings[0]!.openerObservedAt = "2027-01-11T16:59:00Z";
    expect(
      validateKansasIEBrowserObservation(
        annual,
        2026,
        new Date("2027-01-11T18:00:00Z"),
      ).scope.endDate,
    ).toBe("01/11/2027");
    expect(() =>
      validateKansasIEBrowserObservation(
        { ...annual, scope: { ...annual.scope, endDate: "01/12/2027" } },
        2026,
        new Date("2027-01-11T18:00:00Z"),
      ),
    ).toThrow("filed-date window");
  });
  it("validates genuine rendered metadata without inventing HTTP fields", () => {
    expect(validateKansasIEBrowserObservation(packet(), 2026, now).kind).toBe(
      "browser-rendered",
    );
  });
  it("rejects stale, incomplete or unsafe associations", () => {
    expect(() =>
      validateKansasIEBrowserObservation(
        { ...packet(), observedAt: "2026-10-09T17:00:00Z" },
        2026,
        now,
      ),
    ).toThrow("stale");
    expect(() =>
      validateKansasIEBrowserObservation(
        { ...packet(), recordCount: 2 },
        2026,
        now,
      ),
    ).toThrow("incomplete");
    const invalid = packet();
    invalid.filings[0]!.sourceUrl = "https://example.com/private.pdf";
    expect(() =>
      validateKansasIEBrowserObservation(invalid, 2026, now),
    ).toThrow("official");
  });
  it("downloads and caches saved-source PDFs normally, holding unreviewed bytes without DB writes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ks-ie-test-"));
    try {
      const observationFile = join(cacheDir, "saved.json");
      await writeFile(observationFile, JSON.stringify(packet()));
      const fetchImpl = vi.fn(
        async () =>
          new Response("%PDF-synthetic", {
            headers: { "Content-Type": "application/pdf" },
          }),
      );
      const writeDocumentFn = vi.fn();
      const result = await syncKansasIndependentExpenditures({
        db: { connect: vi.fn() } as never,
        electionYear: 2026,
        now,
        observationFile,
        cacheDir,
        sessionOptions: { fetchImpl, spacingMs: 0 },
        writeDocumentFn,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "observed",
        acquiredDocuments: 1,
        acceptedDocuments: 0,
        pendingDocuments: 1,
        writtenRows: 0,
      });
      expect(writeDocumentFn).not.toHaveBeenCalled();
      await expect(
        readFile(join(cacheDir, "ie-inventory", "2026.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const repeated = await syncKansasIndependentExpenditures({
        db: { connect: vi.fn() } as never,
        electionYear: 2026,
        now,
        observationFile,
        cacheDir,
        sessionOptions: { fetchImpl, spacingMs: 0 },
        writeDocumentFn,
      });
      expect(repeated.acquiredDocuments).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const nativeSearch = vi
        .spyOn(ieClient, "searchKansasIndependentExpenditures")
        .mockResolvedValue({ recordCount: 0, filings: [] });
      await syncKansasIndependentExpenditures({
        db: { connect: vi.fn() } as never,
        electionYear: 2026,
        now,
        cacheDir,
        sessionOptions: { fetchImpl, spacingMs: 0 },
        writeDocumentFn,
      });
      expect(nativeSearch).toHaveBeenCalledOnce();
      expect(nativeSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "01/01/2026",
          endDate: "10/12/2026",
        }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
  it("keeps the default inventory intact after an explicitly scoped run", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ks-ie-scope-"));
    try {
      const savedInventory = join(cacheDir, "ie-inventory", "2026.json");
      await mkdir(join(cacheDir, "ie-inventory"));
      const existing = JSON.stringify({
        priorInventory: "must remain unchanged",
      });
      await writeFile(savedInventory, existing);
      const observationFile = join(cacheDir, "scoped.json");
      await writeFile(observationFile, JSON.stringify(packet()));
      await syncKansasIndependentExpenditures({
        db: { connect: vi.fn() } as never,
        electionYear: 2026,
        now,
        cacheDir,
        observationFile,
        sessionOptions: {
          spacingMs: 0,
          fetchImpl: async () =>
            new Response("%PDF-synthetic", {
              headers: { "Content-Type": "application/pdf" },
            }),
        },
        writeDocumentFn: vi.fn(),
      });
      expect(await readFile(savedInventory, "utf8")).toBe(existing);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it.each(["saved", "native"] as const)(
    "%s acquisition isolates a failed PDF and still verifies complete controls",
    async (mode) => {
      const cacheDir = await mkdtemp(join(tmpdir(), "ks-ie-partial-"));
      try {
        const docs = originals();
        // The first singleton fails, as does the second October companion.
        // Three intervening complete singleton controls must still be written.
        const failed = new Set([docs[0]!.sourceUrl, docs[5]!.sourceUrl]);
        const source = packet();
        source.scope.filerName = reviewedFixtures[0]!.payerName;
        source.filings = reviewedFixtures.map((statement) => ({
          ...source.filings[0]!,
          name: statement.payerName,
          sourceUrl: statement.sourceUrl,
          fileDate: statement.filingDate.replace(
            /^(\d{4})-(\d{2})-(\d{2})$/,
            "$2/$3/$1",
          ),
        }));
        source.recordCount = source.filings.length;
        const observationFile = join(cacheDir, "scoped.json");
        await writeFile(observationFile, JSON.stringify(source));
        const open = vi.fn(async (url: string) => {
          if (failed.has(url)) throw new Error("synthetic PDF unavailable");
          return docs.find((doc) => doc.sourceUrl === url)!;
        });
        if (mode === "native")
          vi.spyOn(
            ieClient,
            "searchKansasIndependentExpenditures",
          ).mockResolvedValue({
            recordCount: source.recordCount,
            filings: source.filings.map((row) => ({
              row,
              openPaperDocument: () => open(row.sourceUrl),
            })) as never,
          });
        const fetchImpl = vi.fn(async (url: string | URL | Request) => {
          await open(String(url));
          return new Response(fixtureBody, {
            headers: { "Content-Type": "application/pdf" },
          });
        });
        const writeDocumentFn = vi.fn(
          async (_input: { sourceUrl: string }) => ({
            rowCount: 1,
            mappedRowCount: 1,
          }),
        );
        const result = await syncKansasIndependentExpenditures({
          db: { connect: vi.fn() } as never,
          electionYear: 2026,
          now,
          cacheDir,
          observationFile: mode === "saved" ? observationFile : undefined,
          sessionOptions: { fetchImpl, spacingMs: 0 },
          writeDocumentFn,
        });
        expect(open).toHaveBeenCalledTimes(6);
        expect(result).toMatchObject({
          status: "partial",
          recordCount: 6,
          acquiredDocuments: 4,
          acceptedDocuments: 3,
          pendingDocuments: 1,
          writtenRows: 3,
        });
        expect(
          writeDocumentFn.mock.calls.map(
            ([input]) => (input as { sourceUrl: string }).sourceUrl,
          ),
        ).toEqual(docs.slice(1, 4).map((doc) => doc.sourceUrl));
        expect(
          result.diagnostics.filter((line) =>
            line.includes("synthetic PDF unavailable"),
          ),
        ).toHaveLength(2);
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
  );

  it("reports unavailable when every saved PDF fails without writing evidence", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ks-ie-failed-"));
    try {
      const observationFile = join(cacheDir, "scoped.json");
      await writeFile(observationFile, JSON.stringify(packet()));
      const writeDocumentFn = vi.fn();
      const result = await syncKansasIndependentExpenditures({
        db: { connect: vi.fn() } as never,
        electionYear: 2026,
        now,
        cacheDir,
        observationFile,
        sessionOptions: {
          spacingMs: 0,
          fetchImpl: async () => new Response(null, { status: 202 }),
        },
        writeDocumentFn,
      });
      expect(result).toMatchObject({
        status: "unavailable",
        recordCount: 1,
        acquiredDocuments: 0,
        writtenRows: 0,
      });
      expect(result.diagnostics).not.toHaveLength(0);
      expect(writeDocumentFn).not.toHaveBeenCalled();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("records native source unavailability and preserves the canonical component", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ks-ie-test-"));
    try {
      const writeDocumentFn = vi.fn();
      const connect = vi.fn();
      const result = await syncKansasIndependentExpenditures({
        db: { connect } as never,
        electionYear: 2026,
        now,
        cacheDir,
        sessionOptions: {
          fetchImpl: async () => new Response(null, { status: 202 }),
          spacingMs: 0,
        },
        writeDocumentFn,
      });
      expect(result.status).toBe("unavailable");
      expect(connect).not.toHaveBeenCalled();
      expect(writeDocumentFn).not.toHaveBeenCalled();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
