import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { DelawareCfrsResponseCapture } from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readDelawareCfrsCommitteeArtifacts,
  storeDelawareCfrsCommitteeArtifacts,
  type DelawareCfrsSourcePacketIndex,
} from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactCache.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const CF_ID = "01009999";

const RECEIPTS_CSV = [
  "Contribution Date,Contributor Name,Contributor Address Line 1,Contributor Address Line 2,Contributor City,Contributor State,Contributor Zip,Contributor Type,Employer Name,Employer Occupation,Contribution Type,Contribution Amount,CF_ID,Receiving Committee,Filing Period,Office,Fixed Asset,",
  `6/30/2026,Jane Donor,1 Example St,,Wilmington,DE,19801,Individual,,,Check,500.0000,${CF_ID},Example for Delaware,2026 2026  General Election 11/03/2026 30 Day,(Attorney General),No`,
].join("\r\n");

const EXPENSES_CSV = [
  "Expenditure Date,Payee Name,Payee Address Line 1,Payee Address Line 2,Payee City,Payee State,Payee Zip,Payee Type,Amount($),CF ID,Committee Name,Expense Category,Expense Purpose,Expense Method,Filing Period,Fixed Asset,",
  `7/1/2026,Vendor,2 Example Rd,,Dover,DE,19901,Individual,300.0000,${CF_ID},Example for Delaware,Media,Ads,Check,2026 30 Day General,No,`,
].join("\r\n");

const FILED_REPORTS_HTML = `<script>jQuery('#Grid').tGrid({columns:[], pageSize:15, total:1});</script>
<div class="t-widget t-grid" id="Grid"><table><thead><tr><th>Filing Period</th></tr></thead><tbody>
<tr><td>2026 30 Day 2026 General Election 11/03/2026</td><td> <a onclick=downloadReport(&#39;report1.pdf&#39;,&#39;600001&#39;,&#39;900&#39;) > Original Financial Statement </a> </td><td>${CF_ID}</td><td>Example for Delaware</td><td>Candidate Committee</td><td>10/06/2026</td><td>2026</td><td>(Attorney General)</td><td>Active</td></tr>
</tbody></table></div>`;

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "de-cfrs-cache-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(cacheDir, { recursive: true, force: true });
});

function storeInput() {
  return {
    cacheDir,
    cfId: CF_ID,
    memberId: 600001,
    sourceUrl: "https://cfrs.elections.delaware.gov/",
    receiptsCsv: RECEIPTS_CSV,
    receiptsSearchTotal: 1,
    expensesCsv: EXPENSES_CSV,
    expensesSearchTotal: 1,
    filedReportsHtml: FILED_REPORTS_HTML,
    reportPdfs: [
      {
        publicReportFileName: "report1.pdf",
        filingCalendarId: 900,
        body: Buffer.from("%PDF-fake"),
      },
    ],
    retrievedAt: new Date("2026-08-28T00:00:00.000Z"),
  };
}

describe("delawareCfrsArtifactCache", () => {
  it("stores a bundle with restricted permissions and reads it back verified", async () => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    const bundle = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(bundle.manifest.memberId).toBe(600001);
    expect(bundle.receiptRows).toHaveLength(1);
    expect(bundle.expenseRows).toHaveLength(1);
    expect(bundle.filedReportRows[0]?.document?.filingCalendarId).toBe(900);
    expect(bundle.reportPdfs[0]?.body.toString()).toBe("%PDF-fake");

    const mode =
      (await stat(join(cacheDir, CF_ID, "receipts.csv"))).mode & 0o777;
    expect(mode).toBe(0o600);
    const dirMode = (await stat(join(cacheDir, CF_ID))).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("rejects tampered artifacts and unparseable bodies", async () => {
    const manifest = await storeDelawareCfrsCommitteeArtifacts(storeInput());
    await writeFile(
      join(cacheDir, CF_ID, manifest.files.receiptsCsv.path),
      `${RECEIPTS_CSV}\r\nextra`,
      {
        mode: 0o600,
      },
    );
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(
      /Stale or corrupted Delaware CFRS artifact: receipts CSV/,
    );

    await expect(
      storeDelawareCfrsCommitteeArtifacts({
        ...storeInput(),
        receiptsCsv: "<html>Session expired</html>",
      }),
    ).rejects.toThrow();
  });

  it("replaces an existing bundle cleanly, leaving no staging or previous directories", async () => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      reportPdfs: [
        {
          publicReportFileName: "report1.pdf",
          filingCalendarId: 900,
          body: Buffer.from("%PDF-v2"),
        },
      ],
    });
    const bundle = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(bundle.reportPdfs[0]?.body.toString()).toBe("%PDF-v2");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(cacheDir)).toEqual([CF_ID]);
  });

  it("leaves the previous bundle byte-identical when a re-store fails mid-write", async () => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    const before = await readFile(
      join(cacheDir, CF_ID, "receipts.csv"),
      "utf8",
    );

    // Duplicate PDF file names throw AFTER the first PDF is staged — the
    // staging directory must be discarded and the live bundle untouched.
    const duplicate = {
      publicReportFileName: "report1.pdf",
      filingCalendarId: 900,
      body: Buffer.from("%PDF-v2"),
    };
    await expect(
      storeDelawareCfrsCommitteeArtifacts({
        ...storeInput(),
        receiptsCsv: `${RECEIPTS_CSV}\r\n${RECEIPTS_CSV.split("\r\n")[1]}`,
        receiptsSearchTotal: 2,
        reportPdfs: [duplicate, duplicate],
      }),
    ).rejects.toThrow(/duplicate report PDF/);

    const bundle = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(bundle.receiptRows).toHaveLength(1);
    expect(await readFile(join(cacheDir, CF_ID, "receipts.csv"), "utf8")).toBe(
      before,
    );
    const { readdir } = await import("node:fs/promises");
    expect(
      (await readdir(cacheDir)).filter((name) => name.includes("staging")),
    ).toEqual([]);
  });

  it("fails on missing bundles and parser-version drift", async () => {
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/No Delaware CFRS artifact bundle cached/);
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    const manifestPath = join(cacheDir, CF_ID, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.parserVersion = 999;
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/re-acquire/);
  });
});

function capture(
  overrides: Partial<DelawareCfrsResponseCapture> = {},
): DelawareCfrsResponseCapture {
  const body = Buffer.from([0, 255, 128, 65]);
  return {
    body,
    url: "https://cfrs.elections.delaware.gov/Public/_ViewReceiptsCustom?Grid-size=500&theme=vista",
    method: "POST",
    financeFields: {
      txtReceivingRegistrant: "Example for Delaware",
      CommitteeType: "",
      page: "1",
      size: "500",
    },
    requestScopeRedacted: false,
    attempt: 1,
    startedAt: "2026-10-11T23:10:00.000Z",
    completedAt: "2026-10-11T23:10:00.150Z",
    status: 200,
    contentType: "application/octet-stream",
    byteCount: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    ...overrides,
  };
}
async function mutateManifest(mutate: (m: any) => void) {
  const path = join(cacheDir, CF_ID, "manifest.json");
  const m = JSON.parse(await readFile(path, "utf8"));
  mutate(m);
  await writeFile(path, JSON.stringify(m), { mode: 0o600 });
}

describe("Delaware immutable source-capture journal", () => {
  it("roundtrips exact bytes, source times, HTTP failures and redacted scope without completeness claims", async () => {
    const captures = [
      capture({ status: 503 }),
      capture({ attempt: 2, status: 200, requestScopeRedacted: true }),
    ];
    const manifest = await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: captures,
    });
    expect(manifest.sourceJournal).toMatchObject({
      version: 1,
      captureCount: 2,
    });
    expect(manifest.sourceJournal!.captures.map((c) => c.path)).toEqual([
      "source-captures/000000.bin",
      "source-captures/000001.bin",
    ]);
    const result = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(result.sourceCaptures).toEqual(captures);
    expect(result.manifest.retrievedAt).toBe("2026-08-28T00:00:00.000Z");
    expect(result.sourceCaptures![0]!.startedAt).toBe(
      "2026-10-11T23:10:00.000Z",
    );
    expect(result.sourceCaptures![0]).not.toHaveProperty("complete");
    expect(result.sourceCaptures![0]).not.toHaveProperty("phase");
    for (const c of manifest.sourceJournal!.captures)
      expect((await stat(join(cacheDir, CF_ID, c.path))).mode & 0o777).toBe(
        0o600,
      );
    expect(
      (await stat(join(cacheDir, CF_ID, "source-captures"))).mode & 0o777,
    ).toBe(0o700);
  });
  it("roundtrips the actual current-report checkbox without redacting authority scope", async () => {
    const cap = capture({
      url: "https://cfrs.elections.delaware.gov/Public/ViewFiledReports",
      financeFields: {
        MemberId: "458984",
        hdnViewCurrent: "true",
        chkViewCurrReport: "on",
      },
    });
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [cap],
    });
    const result = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(result.sourceCaptures).toEqual([cap]);
  });

  it("roundtrips the observed native expense route with its full paging scope", async () => {
    const cap = capture({
      url: "https://cfrs.elections.delaware.gov/Public/_ViewExpensesCustom?theme=vista",
      financeFields: {
        page: "1",
        size: "500",
        orderBy: "",
        groupBy: "",
        filter: "",
      },
    });
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [cap],
    });
    expect(
      (await readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }))
        .sourceCaptures,
    ).toEqual([cap]);
  });

  it("roundtrips a published legacy financial filename without fabricating scope metadata", async () => {
    const cap = capture({
      method: "GET",
      financeFields: null,
      url: "https://cfrs.elections.delaware.gov/Public/FiledReports?FileName=CampaignFinance_458984_623_b7770710-ecc1-43c4-848d-b846bbc4cb3d.pdf&CommitteeID=458984&FilingCalendarID=623",
    });
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [cap],
    });
    expect(
      (await readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }))
        .sourceCaptures,
    ).toEqual([cap]);
  });

  it("keeps absence distinct from an explicitly empty observation journal", async () => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    expect(
      (await readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }))
        .sourceCaptures,
    ).toBeUndefined();
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [],
    });
    const result = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(result.sourceCaptures).toEqual([]);
    expect(result.manifest.sourceJournal?.captureCount).toBe(0);
  });
  it("snapshots all caller bytes/fields/date/arrays before the first await and detaches read metadata", async () => {
    const cap = capture();
    const sourceCaptures = [cap];
    const input = { ...storeInput(), sourceCaptures };
    const pending = storeDelawareCfrsCommitteeArtifacts(input);
    cap.body.fill(4);
    (cap.financeFields as Record<string, string>).page = "99";
    cap.startedAt = "1900-01-01T00:00:00.000Z";
    input.reportPdfs[0]!.body.fill(0);
    input.receiptsCsv = "changed";
    input.retrievedAt.setFullYear(1900);
    sourceCaptures.length = 0;
    await pending;
    const result = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(result.sourceCaptures![0]).toEqual(capture());
    expect(result.reportPdfs[0]!.body.toString()).toBe("%PDF-fake");
    expect(result.manifest.retrievedAt).toBe("2026-08-28T00:00:00.000Z");
    result.sourceCaptures![0]!.body.fill(0);
    (result.sourceCaptures![0]!.financeFields as Record<string, string>).page =
      "80";
    expect(
      result.manifest.sourceJournal!.captures[0]!.financeFields!.page,
    ).toBe("1");
    expect(
      (await readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }))
        .sourceCaptures![0],
    ).toEqual(capture());
  });
  it("discards partial journal writes while keeping the entire old bundle byte-identical", async () => {
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [capture()],
    });
    const oldManifest = await readFile(join(cacheDir, CF_ID, "manifest.json"));
    const oldCapture = await readFile(
      join(cacheDir, CF_ID, "source-captures/000000.bin"),
    );
    const originalWriteFile = (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).writeFile;
    vi.mocked(fs.writeFile).mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]).includes("source-captures/000001.bin"))
          throw new Error("simulated journal disk failure");
        return originalWriteFile(...args);
      },
    );
    await expect(
      storeDelawareCfrsCommitteeArtifacts({
        ...storeInput(),
        sourceCaptures: [capture(), capture({ attempt: 2 })],
      }),
    ).rejects.toThrow(/journal disk failure/);
    vi.mocked(fs.writeFile).mockImplementation(originalWriteFile);
    expect(await readFile(join(cacheDir, CF_ID, "manifest.json"))).toEqual(
      oldManifest,
    );
    expect(
      await readFile(join(cacheDir, CF_ID, "source-captures/000000.bin")),
    ).toEqual(oldCapture);
    expect(await readdir(cacheDir)).toEqual([CF_ID]);
  });
  it.each([
    "count",
    "version",
    "null",
    "missing_field",
    "extra_header",
    "phase",
    "path",
    "duplicate_path",
    "hash",
    "byte_count",
    "byte_limit",
    "status",
    "attempt",
    "interval",
    "invalid_date",
    "url",
    "credentials",
    "query_secret",
    "finance_secret",
    "get_fields",
    "content_type",
    "unknown_flag",
  ])("rejects corrupt source metadata %s", async (kind) => {
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [capture(), capture({ attempt: 2 })],
    });
    await mutateManifest((m) => {
      const c = m.sourceJournal.captures[0];
      if (kind === "count") m.sourceJournal.captureCount = 1;
      if (kind === "version") m.sourceJournal.version = 2;
      if (kind === "null") m.sourceJournal = null;
      if (kind === "missing_field") delete c.completedAt;
      if (kind === "extra_header") c.headers = { Cookie: "secret" };
      if (kind === "phase") c.phase = "after";
      if (kind === "path") c.path = "../stolen.bin";
      if (kind === "duplicate_path") m.sourceJournal.captures[1].path = c.path;
      if (kind === "hash") c.sha256 = "a".repeat(64);
      if (kind === "byte_count") c.byteCount += 1;
      if (kind === "byte_limit") c.byteCount = 64 * 1024 * 1024 + 1;
      if (kind === "status") c.status = 0;
      if (kind === "attempt") c.attempt = 0;
      if (kind === "interval") c.completedAt = "2026-10-10T23:10:00.000Z";
      if (kind === "invalid_date") c.startedAt = "2026-02-30T23:10:00.000Z";
      if (kind === "url")
        c.url = "https://example.org/Public/_ViewReceiptsCustom";
      if (kind === "credentials")
        c.url =
          "https://user:secret@cfrs.elections.delaware.gov/Public/_ViewReceiptsCustom";
      if (kind === "query_secret") c.url += "&token=secret";
      if (kind === "finance_secret") c.financeFields.Authorization = "secret";
      if (kind === "get_fields") c.method = "GET";
      if (kind === "content_type")
        c.contentType = "text/plain\r\nCookie:secret";
      if (kind === "unknown_flag") c.requestScopeRedacted = "false";
    });
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow();
  });
  it("rejects capture byte corruption and missing capture files", async () => {
    const m = await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [capture()],
    });
    const path = join(cacheDir, CF_ID, m.sourceJournal!.captures[0]!.path);
    await writeFile(path, Buffer.from("bad!"));
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/corrupted.*source capture/);
    await rm(path);
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/Missing.*source capture/);
  });
  it("refuses a generated journal path symlink escaping the physical committee directory", async () => {
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      sourceCaptures: [capture()],
    });
    const outside = join(cacheDir, "outside.bin");
    await writeFile(outside, capture().body);
    const path = join(cacheDir, CF_ID, "source-captures/000000.bin");
    await rm(path);
    await symlink(outside, path);
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/Unconfined/);
  });
  it("rejects legacy artifact path traversal without reading outside bytes", async () => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    await mutateManifest((m) => {
      m.files.receiptsCsv.path = "../outside.csv";
    });
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/Invalid.*artifact entry/);
  });
  it.each(["hash", "field", "extra", "oversized_count"])(
    "rejects invalid capture input before staging %s",
    async (kind) => {
      const sourceCaptures = [capture()];
      if (kind === "hash") sourceCaptures[0]!.sha256 = "a".repeat(64);
      if (kind === "field") (sourceCaptures[0] as any).financeFields = 1;
      if (kind === "extra")
        (sourceCaptures[0] as any).headers = { Cookie: "secret" };
      if (kind === "oversized_count") sourceCaptures.length = 10001;
      await expect(
        storeDelawareCfrsCommitteeArtifacts({
          ...storeInput(),
          sourceCaptures,
        }),
      ).rejects.toThrow(/source journal/);
      expect(await readdir(cacheDir)).toEqual([]);
    },
  );
});

function indexedInput() {
  const sourceCaptures = [
    capture({
      url: "https://cfrs.elections.delaware.gov/Public/Search?theme=vista",
      financeFields: {
        CommitteeType: "",
        CommitteeStatus: "",
        txtCommitteeID: "",
        txtCommitteeName: "",
      },
      startedAt: "2026-10-11T23:00:00.000Z",
      completedAt: "2026-10-11T23:00:00.150Z",
    }),
    capture({
      url: "https://cfrs.elections.delaware.gov/Public/ViewReceipts?theme=vista",
      financeFields: {
        MemberId: "600001",
        txtReceivingRegistrant: "Example for Delaware",
        dtStartDate: "",
        dtEndDate: "",
      },
      startedAt: "2026-10-11T23:01:00.000Z",
      completedAt: "2026-10-11T23:01:00.150Z",
    }),
    capture({
      url: "https://cfrs.elections.delaware.gov/Public/Search?theme=vista",
      financeFields: {
        CommitteeType: "",
        CommitteeStatus: "",
        txtCommitteeID: "",
        txtCommitteeName: "",
      },
      startedAt: "2026-10-11T23:02:00.000Z",
      completedAt: "2026-10-11T23:02:00.150Z",
    }),
  ];
  const sourcePacketIndex: DelawareCfrsSourcePacketIndex = {
    version: 1,
    cfId: CF_ID,
    memberId: 600001,
    committeeName: "Example for Delaware",
    requestWindow: null,
    candidateCaptureIndices: [1],
    registryOpeningCaptureIndices: [0],
    registryClosingCaptureIndices: [2],
    payers: [],
  };
  return { ...storeInput(), sourceCaptures, sourcePacketIndex };
}
function officialCapture(
  overrides: Partial<DelawareCfrsResponseCapture> = {},
): DelawareCfrsResponseCapture {
  const body = Buffer.from("<html>Official election source fixture</html>");
  return capture({
    body,
    url: "https://elections.delaware.gov/reports/GE2022.html",
    method: "GET",
    financeFields: null,
    contentType: "text/html",
    byteCount: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    ...overrides,
  });
}

describe("Delaware optional packet index and official source files", () => {
  it("roundtrips original times and detached packet references without financial flags", async () => {
    const input = indexedInput();
    input.sourceCaptures.push(capture({ status: 503, attempt: 2 }));
    const expected = structuredClone(input.sourcePacketIndex);
    const pending = storeDelawareCfrsCommitteeArtifacts(input);
    (input.sourcePacketIndex.candidateCaptureIndices as number[])[0] = 99;
    input.sourcePacketIndex.committeeName = "changed after store started";
    await pending;
    const result = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(result.sourcePacketIndex).toEqual(expected);
    expect(result.sourceCaptures).toHaveLength(4);
    expect(result.sourceCaptures![3]!.status).toBe(503);
    expect(result.sourceCaptures![1]!.startedAt).toBe(
      "2026-10-11T23:01:00.000Z",
    );
    (result.sourcePacketIndex!.candidateCaptureIndices as number[])[0] = 55;
    expect(result.manifest.sourcePacketIndex).toEqual(expected);
    expect(
      (await readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }))
        .sourcePacketIndex,
    ).toEqual(expected);
    expect(result.manifest.sourcePacketIndex).not.toHaveProperty("complete");
  });

  it.each([
    "missing_journal",
    "negative",
    "out_of_range",
    "fraction",
    "duplicate",
    "overlap",
    "wrong_cf",
    "wrong_member",
    "wrong_name",
    "member_scope",
    "filtered_registry",
    "late_opening",
    "early_closing",
    "bad_window",
    "window_scope",
    "money_flag",
  ])("rejects packet index %s and preserves the prior bundle", async (kind) => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    const before = await readFile(join(cacheDir, CF_ID, "manifest.json"));
    const input = indexedInput() as any;
    const index = input.sourcePacketIndex;
    if (kind === "missing_journal") delete input.sourceCaptures;
    if (kind === "negative") index.candidateCaptureIndices = [-1];
    if (kind === "out_of_range") index.candidateCaptureIndices = [3];
    if (kind === "fraction") index.candidateCaptureIndices = [1.5];
    if (kind === "duplicate") index.candidateCaptureIndices = [1, 1];
    if (kind === "overlap") index.registryOpeningCaptureIndices = [1];
    if (kind === "wrong_cf") index.cfId = "01008888";
    if (kind === "wrong_member") index.memberId = 12;
    if (kind === "wrong_name") index.committeeName = "Different owner";
    if (kind === "member_scope")
      input.sourceCaptures[1].financeFields.MemberId = "12";
    if (kind === "filtered_registry")
      input.sourceCaptures[0].financeFields.CommitteeStatus = "Active";
    if (kind === "late_opening")
      input.sourceCaptures[0].completedAt = "2026-10-11T23:01:00.100Z";
    if (kind === "early_closing")
      input.sourceCaptures[2].startedAt = "2026-10-11T23:01:00.100Z";
    if (kind === "bad_window")
      index.requestWindow = { start: "2026-02-30", end: "2026-12-31" };
    if (kind === "window_scope")
      index.requestWindow = { start: "2023-01-01", end: "2026-12-31" };
    if (kind === "money_flag") index.current = true;
    await expect(storeDelawareCfrsCommitteeArtifacts(input)).rejects.toThrow(
      /source packet index/,
    );
    expect(await readFile(join(cacheDir, CF_ID, "manifest.json"))).toEqual(
      before,
    );
    expect(await readdir(cacheDir)).toEqual([CF_ID]);
  });

  it("validates payer facet bounds and receiving/payer request scopes", async () => {
    const input = indexedInput();
    input.sourceCaptures.push(
      capture({
        url: "https://cfrs.elections.delaware.gov/Public/ViewFiledReports?theme=vista",
        financeFields: {
          MemberId: "900001",
          txtCommitteeName: "Example Third Party",
        },
      }),
    );
    input.sourcePacketIndex.payers = [
      {
        cfId: "04009999",
        memberId: 900001,
        committeeName: "Example Third Party",
        committeeType: "04",
        facets: {
          registry: [3],
          payerOrganization: [3],
          receiverIdentity: [1],
          candidateCycleAuthority: [1],
          allVersionReports: [3],
          latestAccountReport: [3],
          genericMemberReceipts: [3],
          thirdPartyReceiptExport: [3],
          expenses: [3],
          reportPdfs: [3],
          unsupportedFacets: [],
        },
      },
    ];
    await storeDelawareCfrsCommitteeArtifacts(input);
    await mutateManifest((m) => {
      m.sourcePacketIndex.payers[0].facets.expenses = [400];
    });
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/capture references/);
    const wrongScope = structuredClone(input.sourcePacketIndex);
    (wrongScope.payers[0]!.facets.expenses as number[])[0] = 1;
    await expect(
      storeDelawareCfrsCommitteeArtifacts({
        ...input,
        sourcePacketIndex: wrongScope,
      }),
    ).rejects.toThrow(/payer facet Member scope/);
  });

  it("revalidates manifest index identity and chronology at read", async () => {
    await storeDelawareCfrsCommitteeArtifacts(indexedInput());
    await mutateManifest((m) => {
      m.sourcePacketIndex.cfId = "01008888";
    });
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/receiver identity/);
  });

  it("stores official raw bytes separately, retains both phase times, and restricts files", async () => {
    const opening = officialCapture();
    const closing = officialCapture({
      url: "https://elections.delaware.gov/elections/general/sampleballots/GE2026/15-10.html",
      startedAt: "2026-10-12T00:00:00.000Z",
      completedAt: "2026-10-12T00:00:00.150Z",
    });
    const expectedOpening = { ...opening, body: Buffer.from(opening.body) };
    const pending = storeDelawareCfrsCommitteeArtifacts({
      ...indexedInput(),
      officialElectionSources: [opening, closing],
    });
    opening.body.fill(0);
    opening.startedAt = "2030-01-01T00:00:00.000Z";
    await pending;
    const result = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(result.officialElectionSources).toEqual([expectedOpening, closing]);
    expect(result.sourceCaptures).toHaveLength(3);
    expect(result.manifest.retrievedAt).toBe("2026-08-28T00:00:00.000Z");
    for (const source of result.manifest.officialElectionSources!) {
      expect(
        (await stat(join(cacheDir, CF_ID, source.path))).mode & 0o777,
      ).toBe(0o600);
      expect(source).not.toHaveProperty("phase");
    }
    expect(
      (await stat(join(cacheDir, CF_ID, "official-election-sources"))).mode &
        0o777,
    ).toBe(0o700);
    result.officialElectionSources![0]!.body.fill(0);
    expect(
      (await readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }))
        .officialElectionSources![0],
    ).toEqual(expectedOpening);
  });

  it.each([
    "route",
    "origin",
    "query",
    "credentials",
    "method",
    "fields",
    "redacted",
    "status",
    "attempt",
    "time",
    "hash",
    "size",
    "headers",
  ])("rejects official source %s without replacing old bytes", async (kind) => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    const before = await readFile(join(cacheDir, CF_ID, "manifest.json"));
    const source = officialCapture() as any;
    if (kind === "route")
      source.url = "https://elections.delaware.gov/reports/GE2024.html";
    if (kind === "origin")
      source.url = "https://example.org/reports/GE2022.html";
    if (kind === "query") source.url += "?token=secret";
    if (kind === "credentials")
      source.url =
        "https://user:secret@elections.delaware.gov/reports/GE2022.html";
    if (kind === "method") source.method = "POST";
    if (kind === "fields") source.financeFields = {};
    if (kind === "redacted") source.requestScopeRedacted = true;
    if (kind === "status") source.status = 503;
    if (kind === "attempt") source.attempt = 0;
    if (kind === "time") source.completedAt = "2026-10-11T23:00:00.000Z";
    if (kind === "hash") source.sha256 = "a".repeat(64);
    if (kind === "size") source.byteCount = 12 * 1024 * 1024 + 1;
    if (kind === "headers") source.headers = { Cookie: "secret" };
    await expect(
      storeDelawareCfrsCommitteeArtifacts({
        ...storeInput(),
        officialElectionSources: [source],
      }),
    ).rejects.toThrow(/official election sources/);
    expect(await readFile(join(cacheDir, CF_ID, "manifest.json"))).toEqual(
      before,
    );
  });

  it("revalidates official route metadata at read", async () => {
    await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      officialElectionSources: [officialCapture()],
    });
    await mutateManifest((m) => {
      m.officialElectionSources[0].url =
        "https://elections.delaware.gov/reports/GE2024.html";
    });
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/official election sources: route/);
  });

  it("supports the large official results page and detects byte tampering at read", async () => {
    const body = Buffer.alloc(10 * 1024 * 1024, 32);
    const source = officialCapture({
      body,
      byteCount: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    const manifest = await storeDelawareCfrsCommitteeArtifacts({
      ...storeInput(),
      officialElectionSources: [source],
    });
    const path = join(
      cacheDir,
      CF_ID,
      manifest.officialElectionSources![0]!.path,
    );
    await writeFile(path, Buffer.alloc(body.length, 33));
    await expect(
      readDelawareCfrsCommitteeArtifacts({ cacheDir, cfId: CF_ID }),
    ).rejects.toThrow(/corrupted.*official election source/);
  });

  it("keeps the CFRS journal origin strict and legacy optional fields absent", async () => {
    await expect(
      storeDelawareCfrsCommitteeArtifacts({
        ...storeInput(),
        sourceCaptures: [officialCapture()],
      }),
    ).rejects.toThrow(/unsafe URL scope/);
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    const result = await readDelawareCfrsCommitteeArtifacts({
      cacheDir,
      cfId: CF_ID,
    });
    expect(result.sourcePacketIndex).toBeUndefined();
    expect(result.officialElectionSources).toBeUndefined();
  });

  it("rolls back staging when official-file writes fail", async () => {
    await storeDelawareCfrsCommitteeArtifacts(storeInput());
    const before = await readFile(join(cacheDir, CF_ID, "manifest.json"));
    const original = (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).writeFile;
    vi.mocked(fs.writeFile).mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]).includes("official-election-sources/"))
          throw new Error("official disk failure");
        return original(...args);
      },
    );
    await expect(
      storeDelawareCfrsCommitteeArtifacts({
        ...indexedInput(),
        officialElectionSources: [officialCapture()],
      }),
    ).rejects.toThrow(/official disk failure/);
    expect(await readFile(join(cacheDir, CF_ID, "manifest.json"))).toEqual(
      before,
    );
    expect(await readdir(cacheDir)).toEqual([CF_ID]);
  });
});
