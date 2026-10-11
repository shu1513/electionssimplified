import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFloridaFinanceRawSourceClient,
  type FloridaFinanceRawRequest,
} from "../../../src/pipeline/floridaFinance/floridaFinanceRawSourceClient.js";
import {
  createFloridaIndependentExpenditureDiscovery,
  decodeFloridaExpenditureDiscoveryTsv,
  FLORIDA_EXPENDITURE_DISCOVERY_HEADERS,
  type FloridaExpenditureDiscoveryRequest,
} from "../../../src/pipeline/floridaFinance/floridaIndependentExpenditureDiscovery.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

const header = FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t");
const cells = [
  "Example registered payer (PAC)",
  "10/06/2026",
  "1,000.00",
  "Example vendor",
  "Published street",
  "Published city, FL 32399",
  "TEXT MESSAGES; PRO-EXACT PERSON, HD-80",
  "IEC",
];
const tsv = (...rows: string[][]) =>
  [header, ...rows.map((row) => row.join("\t"))].join("\r\n") + "\r\n";
const scope = {
  electionSelector: "20261103-GEN",
  purposePrefix: "TEXT",
  rowLimit: 10,
};
function evidence(
  request: FloridaFinanceRawRequest,
  text = tsv(cells),
): FloridaProcessedRawEvidence {
  const bytesRaw = new TextEncoder().encode(text);
  return {
    ...structuredClone(request),
    bytesRaw,
    sha256: createHash("sha256").update(bytesRaw).digest("hex"),
    status: 200,
    contentType: "text/tab-separated-values; name='Expend.txt'",
    startedAt: "2026-10-11T21:31:00.000Z",
    completedAt: "2026-10-11T21:31:01.000Z",
  };
}
const dirs: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "florida-ie-discovery-"));
  dirs.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const response = (text = tsv(cells)) =>
  new Response(text, {
    headers: { "content-type": "text/tab-separated-values; name='Expend.txt'" },
  });

// Synthetic financial rows test discovery policy; no test claims source money.
describe("Florida bounded expenditure discovery", () => {
  it("uses actual full-purpose fields and exact election query, with no date filter guessed", async () => {
    const request = vi.fn(async (q: FloridaFinanceRawRequest) => evidence(q));
    const result = await createFloridaIndependentExpenditureDiscovery({
      request,
    }).load(scope);
    expect(result.status).toBe("discovered");
    if (result.status !== "discovered") throw new Error("expected discovery");
    expect(result).toMatchObject({
      authority: "discovery_only",
      scope,
      rows: [
        {
          occurrence: 0,
          amountCents: 100000,
          purpose: cells[6],
          payerLabel: cells[0],
          sourceType: "IEC",
        },
      ],
    });
    expect(result.rows[0]!.rawFields.Purpose).toBe(cells[6]);
    expect(result.sourceMetadata).not.toHaveProperty("bytesRaw");
    expect(request.mock.calls[0]![0]).toMatchObject({
      url: "https://dos.elections.myflorida.com/cgi-bin/expend.exe",
      method: "POST",
      financeFields: {
        election: "20261103-GEN",
        search_on: "1",
        cpurpose: "TEXT",
        cdatefrom: "",
        cdateto: "",
        queryformat: "2",
        rowlimit: "10",
      },
    });
  });
  it("retains identical occurrences, signed/zero amounts and unknown codes for later proof", async () => {
    const negative = [...cells];
    negative[2] = "-100.00";
    negative[7] = "UNREVIEWED TYPE";
    const zero = [...cells];
    zero[2] = "0.00";
    zero[6] = "TEXT UNKNOWN PURPOSE";
    const result = await createFloridaIndependentExpenditureDiscovery({
      request: async (q) => evidence(q, tsv(cells, cells, negative, zero)),
    }).load(scope);
    if (result.status !== "discovered") throw new Error("expected discovery");
    expect(
      result.rows.map((row) => [
        row.occurrence,
        row.amountCents,
        row.sourceType,
      ]),
    ).toEqual([
      [0, 100000, "IEC"],
      [1, 100000, "IEC"],
      [2, -10000, "UNREVIEWED TYPE"],
      [3, 0, "IEC"],
    ]);
    expect(result.rows[0]!.rawFields).toEqual(result.rows[1]!.rawFields);
  });
  it("header-only is empty discovery, never financial zero/current coverage", async () => {
    const result = await createFloridaIndependentExpenditureDiscovery({
      request: async (q) => evidence(q, tsv()),
    }).load(scope);
    expect(result).toMatchObject({
      status: "discovered",
      authority: "discovery_only",
      rows: [],
    });
    expect(result).not.toHaveProperty("outsideGroups");
    expect(result).not.toHaveProperty("supportTotal");
  });
  it("preserves source-shaped special and noneligible-office leads without assigning a candidate", async () => {
    const special = [...cells];
    special[0] = "RSLC-Florida (IXO)";
    special[1] = "03/23/2026";
    special[2] = "525.00";
    special[6] = "TEXT MESSAGES; PRO-JON MAPLES, HD-87";
    const county = [...cells];
    county[0] = "New Southern Majority IE PAC (IXO)";
    county[1] = "08/11/2026";
    county[2] = "9750.00";
    county[6] =
      "DIGITAL ADVERTISING TO SUPPORT GREG FALIK OSCEOLA COUNTY SCHOOL BOARD DISTRICT 1";
    for (const [row, purposePrefix] of [
      [special, "TEXT"],
      [county, "DIGITAL ADVERTISING"],
    ] as const) {
      const result = await createFloridaIndependentExpenditureDiscovery({
        request: async (q) => evidence(q, tsv(row)),
      }).load({ ...scope, purposePrefix });
      if (result.status !== "discovered") throw new Error("expected discovery");
      expect(result.rows[0]!.purpose).toBe(row[6]);
      expect(result.rows[0]).not.toHaveProperty("candidateId");
      expect(result.authority).toBe("discovery_only");
    }
  });
  it("saved first uses genuine raw cache; absent cache acquires live exactly once", async () => {
    const cacheDir = await directory(),
      fetchFn = vi.fn(async () => response());
    const first = createFloridaIndependentExpenditureDiscovery({
      request: createFloridaFinanceRawSourceClient({
        cacheDir,
        fetchFn,
        minIntervalMs: 0,
      }).request,
    });
    const a = await first.load(scope);
    const second = createFloridaIndependentExpenditureDiscovery({
      request: createFloridaFinanceRawSourceClient({
        cacheDir,
        fetchFn,
        minIntervalMs: 0,
      }).request,
    });
    const b = await second.load(scope);
    expect(a).toEqual(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("refresh bypasses a saved opening and captures new rows without changing original metadata", async () => {
    const cacheDir = await directory(),
      fetchFn = vi.fn(async () => response());
    const first = await createFloridaIndependentExpenditureDiscovery({
      request: createFloridaFinanceRawSourceClient({
        cacheDir,
        fetchFn,
        minIntervalMs: 0,
      }).request,
    }).load(scope);
    fetchFn.mockImplementationOnce(async () => response(tsv()));
    const result = await createFloridaIndependentExpenditureDiscovery({
      refresh: true,
      request: createFloridaFinanceRawSourceClient({
        cacheDir,
        fetchFn,
        minIntervalMs: 0,
      }).request,
    }).load(scope);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "discovered",
      rows: [],
      authority: "discovery_only",
    });
    expect(first).toMatchObject({ rows: [{ amountCents: 100000 }] });
  });
  it("does not reuse a saved query of another purpose or election", async () => {
    const cacheDir = await directory(),
      fetchFn = vi.fn(async () => response());
    const load = createFloridaIndependentExpenditureDiscovery({
      request: createFloridaFinanceRawSourceClient({
        cacheDir,
        fetchFn,
        minIntervalMs: 0,
      }).request,
    });
    await load.load(scope);
    fetchFn.mockImplementationOnce(async () =>
      response(
        tsv(cells.map((c, i) => (i === 6 ? "SUPPORT EXACT PERSON" : c))),
      ),
    );
    await load.load({ ...scope, purposePrefix: "SUPPORT" });
    await load.load({ ...scope, electionSelector: "20260324-S03" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it("rejects a query-bound body that ignores the requested purpose prefix", async () => {
    const wrong = [...cells];
    wrong[6] = "DIGITAL ADVERTISING TO SUPPORT EXACT PERSON";
    const result = await createFloridaIndependentExpenditureDiscovery({
      request: async (q) => evidence(q, tsv(wrong)),
    }).load(scope);
    expect(result).toMatchObject({
      status: "preserve",
      diagnostics: [expect.stringContaining("Purpose")],
    });
    const lower = [...cells];
    lower[6] = "text messages; pro-exact person, HD-80";
    expect(
      (
        await createFloridaIndependentExpenditureDiscovery({
          request: async (q) => evidence(q, tsv(lower)),
        }).load(scope)
      ).status,
    ).toBe("discovered");
  });
  it("caps preserve rather than exposing a partial discovery as accepted", async () => {
    const result = await createFloridaIndependentExpenditureDiscovery({
      request: async (q) => evidence(q, tsv(cells, cells)),
    }).load({ ...scope, rowLimit: 2 });
    expect(result).toMatchObject({
      status: "preserve",
      diagnostics: [expect.stringContaining("cap reached")],
    });
    expect(result).not.toHaveProperty("rows");
  });
  it.each(["20261103-S99", "20281107-GEN", "All", "20261103-GEN "])(
    "rejects unsupported exact election %s before fetching",
    async (electionSelector) => {
      const request = vi.fn();
      expect(
        (
          await createFloridaIndependentExpenditureDiscovery({ request }).load({
            ...scope,
            electionSelector,
          })
        ).status,
      ).toBe("preserve");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each(["", " TEXT", "TEXT\n", "A".repeat(121)])(
    "rejects unbounded/changed purpose scope %s",
    async (purposePrefix) => {
      const request = vi.fn();
      expect(
        (
          await createFloridaIndependentExpenditureDiscovery({ request }).load({
            ...scope,
            purposePrefix,
          })
        ).status,
      ).toBe("preserve");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("rejects mismatched raw query scope/hash/status/time/URL and byte cap", async () => {
    const changes: ((e: FloridaProcessedRawEvidence) => void)[] = [
      (e) => {
        e.financeFields = { ...e.financeFields, election: "20260324-S03" };
      },
      (e) => {
        e.financeFields = { ...e.financeFields, cpurpose: "SUPPORT" };
      },
      (e) => {
        e.financeFields = { ...e.financeFields, unexpected: "field" };
      },
      (e) => {
        e.url = "https://dos.elections.myflorida.com/cgi-bin/contrib.exe";
      },
      (e) => {
        e.method = "GET";
      },
      (e) => {
        e.sha256 = "a".repeat(64);
      },
      (e) => {
        e.status = 500;
      },
      (e) => {
        e.completedAt = "2026-10-10T00:00:00Z";
      },
      (e) => {
        e.startedAt = "invalid";
      },
      (e) => {
        e.contentType = "text/html";
      },
    ];
    for (const change of changes) {
      const result = await createFloridaIndependentExpenditureDiscovery({
        request: async (q) => {
          const e = evidence(q);
          change(e);
          return e;
        },
      }).load(scope);
      expect(result.status).toBe("preserve");
    }
    expect(
      (
        await createFloridaIndependentExpenditureDiscovery({
          maxResponseBytes: 5,
          request: async (q) => evidence(q),
        }).load(scope)
      ).status,
    ).toBe("preserve");
  });
  it("retains caller/transport scope generation across awaits", async () => {
    const input = { ...scope };
    const request: FloridaExpenditureDiscoveryRequest = async (q) => {
      const result = evidence(q);
      input.electionSelector = "20260324-S03";
      input.purposePrefix = "SUPPORT";
      (q.financeFields as Record<string, string>).election = "All";
      return result;
    };
    const result = await createFloridaIndependentExpenditureDiscovery({
      request,
    }).load(input);
    expect(result).toMatchObject({ status: "discovered", scope });
  });
  it("fetch failure and HTTP200 error HTML are diagnostic preservation", async () => {
    expect(
      await createFloridaIndependentExpenditureDiscovery({
        request: async () => {
          throw new Error("source unavailable");
        },
      }).load(scope),
    ).toEqual({ status: "preserve", diagnostics: ["source unavailable"] });
    expect(
      (
        await createFloridaIndependentExpenditureDiscovery({
          request: async (q) =>
            evidence(q, "<html>Invalid Date Range Entered</html>"),
        }).load(scope)
      ).status,
    ).toBe("preserve");
  });
  it("invalid UTF8 remains unsupported, never a replacement-character identity", async () => {
    const result = await createFloridaIndependentExpenditureDiscovery({
      request: async (q) => {
        const e = evidence(q);
        e.bytesRaw = new Uint8Array([0xff]);
        e.sha256 = createHash("sha256").update(e.bytesRaw).digest("hex");
        return e;
      },
    }).load(scope);
    expect(result.status).toBe("preserve");
  });
  it.each([
    "<html>query error</html>",
    header.replace("Purpose", "Target") + "\n",
    header + "\n" + cells.slice(0, 7).join("\t"),
    tsv(cells.map((c, i) => (i === 2 ? "1.001" : c))),
    tsv(cells.map((c, i) => (i === 2 ? "9007199254740992.00" : c))),
    tsv(cells.map((c, i) => (i === 1 ? "02/30/2026" : c))),
    tsv(cells.map((c, i) => (i === 0 ? "" : c))),
  ])("rejects malformed source schema/identity/cents/date", (raw) => {
    expect(() => decodeFloridaExpenditureDiscoveryTsv(raw)).toThrow();
  });
});
