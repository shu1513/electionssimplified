import { describe, expect, it, vi } from "vitest";
import {
  canonicalPhoenixRegistration,
  canonicalPhoenixReportRefs,
  discoverPhoenixCanonicalReportRefs,
  discoverPhoenixReportObservation,
  fetchPhoenixCanonicalRegistrations,
  fetchPhoenixReportPdf,
  parsePhoenixGridEnvelope,
  phoenixCandidateCycleForDate,
  phoenixFilesystemPdfCache,
  phoenixGridAll,
  phoenixSubmittedDateMs,
  toPhoenixRegistrationRow,
} from "../../../src/pipeline/phoenixFinance/phoenixEfilingClient.js";

function jsonResponse(body: unknown) {
  return { status: 200, text: () => Promise.resolve(JSON.stringify(body)) };
}

describe("parsePhoenixGridEnvelope", () => {
  it("rejects the WAF maintenance page (HTTP 200 HTML)", () => {
    expect(() =>
      parsePhoenixGridEnvelope(
        "<!DOCTYPE html><html><body><h2>Sorry! The requested service is currently undergoing maintenance.</h2></body></html>",
        "self-test",
      ),
    ).toThrow(/maintenance page/);
  });

  it("rejects a JSON body missing the Data/Total envelope", () => {
    expect(() => parsePhoenixGridEnvelope('{"Data": []}', "self-test")).toThrow(
      /missing Data\/Total/,
    );
  });
});

describe("phoenixGridAll", () => {
  it("pages until Total rows are collected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ Data: [{ n: 1 }, { n: 2 }], Total: 3 }),
      )
      .mockResolvedValueOnce(jsonResponse({ Data: [{ n: 3 }], Total: 3 }));
    const rows = await phoenixGridAll({
      path: "/CampaignFinance/Search/_SearchCommittees",
      filters: { COPID: "CAN-25-4" },
      fetchImpl,
    });
    expect(rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // The wire format: form body with sort/page/pageSize/group/filter + the
    // caller's filters, XHR marker header, browser User-Agent.
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://apps-secure.phoenix.gov/CampaignFinance/Search/_SearchCommittees",
    );
    expect(String(init?.body)).toContain("COPID=CAN-25-4");
    expect(String(init?.body)).toContain("page=1");
    expect((init?.headers as Record<string, string>)["X-Requested-With"]).toBe(
      "XMLHttpRequest",
    );
  });

  it("refuses a changing declared Total instead of ending a partial observation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Data: [{ n: 1 }], Total: 3 }))
      .mockResolvedValueOnce(jsonResponse({ Data: [{ n: 2 }], Total: 2 }));
    await expect(
      phoenixGridAll({
        path: "/CampaignFinance/Search/_SearchContributors",
        filters: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/total changed/);
  });
  it("refuses extra physical rows beyond the declared Total", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ Data: [{ n: 1 }, { n: 2 }], Total: 1 }),
      );
    await expect(
      phoenixGridAll({
        path: "/CampaignFinance/Search/_SearchContributors",
        filters: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/more physical rows/);
  });

  it("rejects a non-2xx status before parsing the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      text: () => Promise.resolve('{"Data": [], "Total": 0}'),
    });
    await expect(
      phoenixGridAll({
        path: "/CampaignFinance/Search/_SearchCommittees",
        filters: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("aborts a stalled request via the timeout", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      phoenixGridAll({
        path: "/CampaignFinance/Search/_SearchCommittees",
        filters: {},
        timeoutMs: 10,
        fetchImpl,
      }),
    ).rejects.toThrow(/timed out after 10ms/);
  });

  it("throws on premature pagination exhaustion instead of truncating", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Data: [{ n: 1 }], Total: 5 }))
      .mockResolvedValueOnce(jsonResponse({ Data: [], Total: 5 }));
    await expect(
      phoenixGridAll({
        path: "/CampaignFinance/Search/_SearchCommittees",
        filters: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/exhausted at 1\/5 rows/);
  });
});

describe("toPhoenixRegistrationRow / canonicalPhoenixRegistration", () => {
  // Live field shapes, 2026-08-12 (CAN-25-4).
  const rawHermes = {
    COPID: "can-25-4",
    CommitteeName: " Ed Hermes for Phoenix ",
    CommitteeType: "Candidate Committee",
    CandidateName: "Ed Hermes",
    ElectionCycle: "2025 Election Cycle",
    OfficeSoughtElectionCycle: "2026",
    Approved: true,
    AppovedTimestamp: "/Date(1748632357450)/",
    Terminated: false,
    IsStandingCommittee: false,
  };

  it("maps and normalizes a live registration row", () => {
    expect(toPhoenixRegistrationRow(rawHermes)).toEqual({
      copId: "CAN-25-4",
      committeeName: "Ed Hermes for Phoenix",
      committeeType: "Candidate Committee",
      candidateName: "Ed Hermes",
      electionCycle: "2025 Election Cycle",
      officeSoughtElectionCycle: "2026",
      terminated: false,
      approved: true,
      approvedTimestamp: 1_748_632_357_450,
      isStandingCommittee: false,
    });
  });

  it("maps blank optional fields to null/defaults", () => {
    const row = toPhoenixRegistrationRow({ COPID: "PAC-21-15" });
    expect(row.candidateName).toBeNull();
    expect(row.officeSoughtElectionCycle).toBeNull();
    expect(row.approved).toBe(false);
    expect(row.approvedTimestamp).toBe(0);
  });

  it("keeps the latest approved document version and drops unapproved-only groups", () => {
    const versions = [
      toPhoenixRegistrationRow({
        ...rawHermes,
        ElectionCycle: "2021 Election Cycle",
        OfficeSoughtElectionCycle: "2022",
        AppovedTimestamp: "/Date(1633553307983)/",
      }),
      toPhoenixRegistrationRow(rawHermes),
    ];
    expect(canonicalPhoenixRegistration(versions)?.electionCycle).toBe(
      "2025 Election Cycle",
    );
    expect(
      canonicalPhoenixRegistration([
        toPhoenixRegistrationRow({ ...rawHermes, Approved: false }),
      ]),
    ).toBeNull();
  });

  it("fetchPhoenixCanonicalRegistrations collapses versions per COP ID", async () => {
    // Robinson's live pattern: one COP ID re-registered for a new cycle via
    // an amended Statement of Organization.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        Total: 3,
        Data: [
          {
            ...rawHermes,
            COPID: "CAN-21-16",
            ElectionCycle: "2021 Election Cycle",
            OfficeSoughtElectionCycle: "2022",
            AppovedTimestamp: "/Date(1633553307983)/",
          },
          {
            ...rawHermes,
            COPID: "CAN-21-16",
            ElectionCycle: "2025 Election Cycle",
            OfficeSoughtElectionCycle: "2026",
            AppovedTimestamp: "/Date(1753746294360)/",
          },
          rawHermes,
        ],
      }),
    );
    const canonical = await fetchPhoenixCanonicalRegistrations({ fetchImpl });
    expect(canonical).toHaveLength(2);
    expect(
      canonical.map((row) => [row.copId, row.officeSoughtElectionCycle]),
    ).toEqual([
      ["CAN-21-16", "2026"],
      ["CAN-25-4", "2026"],
    ]);
  });
});

describe("phoenixSubmittedDateMs", () => {
  it("parses the pinned live form and the signed-offset form", () => {
    expect(phoenixSubmittedDateMs("/Date(1755000000000)/", "t")).toBe(
      1_755_000_000_000,
    );
    expect(phoenixSubmittedDateMs("/Date(1755000000000-0700)/", "t")).toBe(
      1_755_000_000_000,
    );
    expect(phoenixSubmittedDateMs("/Date(1755000000000+0100)/", "t")).toBe(
      1_755_000_000_000,
    );
  });

  it("keeps the empty fallback but throws on garbage — 0 would let an older amendment win", () => {
    expect(phoenixSubmittedDateMs("", "t")).toBe(0);
    expect(phoenixSubmittedDateMs(null, "t")).toBe(0);
    expect(() => phoenixSubmittedDateMs("08/12/2026", "package x")).toThrow(
      /Unparseable Phoenix SubmittedDate "08\/12\/2026" for package x/,
    );
  });
});

describe("report discovery + PDF fetch", () => {
  const guid = (prefix: string) =>
    `${prefix}${"0".repeat(8 - prefix.length)}-0000-0000-0000-000000000000`;
  const reportRow = (id = guid("aa"), name = "Q1") => ({
    COPID: "CAN-25-4",
    ReportPackageId: id,
    RecentReport: "00000000-0000-0000-0000-000000000000",
    ReportName: name,
    SubmittedDate: "/Date(1000)/",
    Amount: 100,
  });

  it("retains every edition with equal report names instead of choosing a row timestamp", () => {
    const input = [
      { reportPackageId: guid("aa"), reportName: "Q1", submittedDateMs: 200 },
      { reportPackageId: guid("bb"), reportName: "Q1", submittedDateMs: 100 },
      {
        reportPackageId: guid("cc"),
        reportName: "Annual",
        submittedDateMs: 50,
      },
    ];
    const result = canonicalPhoenixReportRefs(input);
    expect(result.refs.map((ref) => ref.reportPackageId)).toEqual(
      input.map((r) => r.reportPackageId),
    );
    expect(result.supersededDropped).toBe(0);
    expect(canonicalPhoenixReportRefs([...input].reverse())).toEqual(result);
  });

  it("collapses repeated package references only and retains all row timestamp metadata", () => {
    const result = canonicalPhoenixReportRefs([
      { reportPackageId: guid("aa"), reportName: "Q1", submittedDateMs: 300 },
      { reportPackageId: guid("aa"), reportName: "Q1", submittedDateMs: 100 },
    ]);
    expect(result.refs).toEqual([
      {
        reportPackageId: guid("aa"),
        reportName: "Q1",
        submittedDateMs: 100,
        submittedDateValuesMs: [100, 300],
      },
    ]);
    expect(result.supersededDropped).toBe(0);
  });

  it("refuses conflicting names for the same exact package", () => {
    expect(() =>
      canonicalPhoenixReportRefs([
        { reportPackageId: guid("aa"), reportName: "Q1", submittedDateMs: 100 },
        { reportPackageId: guid("aa"), reportName: "Q2", submittedDateMs: 200 },
      ]),
    ).toThrow(/conflicting report names/);
  });

  it("discovers all three financial grids and two explicit no-activity scopes", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        const fields = new URLSearchParams(String(init?.body));
        const noActivity = fields.get("ISNOACTIVITY") === "true";
        const data = noActivity
          ? /Contributors/.test(url)
            ? [reportRow(guid("dd"), "No Activity")]
            : []
          : /Contributors/.test(url)
            ? [reportRow(guid("aa"), "Q1")]
            : /Expenditures/.test(url)
              ? [reportRow(guid("bb"), "Q2")]
              : [reportRow(guid("cc"), "Q3")];
        return Promise.resolve(
          jsonResponse({ Data: data, Total: data.length }),
        );
      });
    const observation = await discoverPhoenixReportObservation({
      copId: "CAN-25-4",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(observation.refs.map((r) => r.reportName)).toEqual([
      "Q1",
      "Q2",
      "Q3",
      "No Activity",
    ]);
    expect(observation.grids.noActivityContributors).toEqual([
      reportRow(guid("dd"), "No Activity"),
    ]);
    expect(observation.grids.noActivityExpenditures).toEqual([]);
    expect(observation.supersededDropped).toBe(0);
    for (const call of fetchImpl.mock.calls)
      expect(new URLSearchParams(String(call[1]?.body)).get("COPID")).toBe(
        "CAN-25-4",
      );
    expect(
      fetchImpl.mock.calls.filter(
        (c) =>
          new URLSearchParams(String(c[1]?.body)).get("ISNOACTIVITY") ===
          "true",
      ),
    ).toHaveLength(2);
    const legacy = await discoverPhoenixCanonicalReportRefs({
      copId: "CAN-25-4",
      fetchImpl,
    });
    expect(legacy).toEqual({ refs: observation.refs, supersededDropped: 0 });
  });

  it.each(["CAN-07-01", "PAC-04-01"])("preserves source-published padded committee identity %s", async (copId) => {
    const own = { ...reportRow(), COPID: copId };
    const foreign = { ...reportRow(guid("bb")), COPID: copId + "0" };
    const fetchImpl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const fields = new URLSearchParams(String(init?.body));
      const data = /Contributors/.test(url) && !fields.has("ISNOACTIVITY")
        ? [own, foreign] : [];
      return Promise.resolve(jsonResponse({ Data: data, Total: data.length }));
    });
    const result = await discoverPhoenixReportObservation({ copId, fetchImpl });
    expect(result.refs.map((ref) => ref.reportPackageId)).toEqual([guid("aa")]);
    expect(result.grids.contributors).toEqual([own, foreign]);
    expect(new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body)).get("COPID")).toBe(copId);
  });

  it.each(["CAN-25-0", "CAN-25-00", "CAN-25--01", "CAN-25-01x"])("refuses invalid receiving committee identity %s", async (copId) => {
    const fetchImpl = vi.fn();
    await expect(discoverPhoenixReportObservation({ copId, fetchImpl })).rejects.toThrow(/valid receiving COPID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains distinct equal-valued physical rows while collapsing only their package ref", async () => {
    const rows = [
      reportRow(),
      { ...reportRow(), SubmittedDate: "/Date(2000)/" },
    ];
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        const fields = new URLSearchParams(String(init?.body));
        const data =
          /Contributors/.test(url) && !fields.has("ISNOACTIVITY") ? rows : [];
        return Promise.resolve(
          jsonResponse({ Data: data, Total: data.length }),
        );
      });
    const observation = await discoverPhoenixReportObservation({
      copId: "CAN-25-4",
      fetchImpl,
    });
    expect(observation.grids.contributors).toEqual(rows);
    expect(observation.refs).toHaveLength(1);
    expect(observation.refs[0]!.submittedDateValuesMs).toEqual([1000, 2000]);
  });

  it("retains valid prefix-matched foreign raw rows but discovers only exact receiving packages", async () => {
    const own = reportRow();
    const foreign = {
      ...reportRow(guid("bb")),
      COPID: " CAN-25-40 ",
      RecentReport: "unresolved-foreign-pointer",
      ReportPackageId: null,
    };
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        const fields = new URLSearchParams(String(init?.body));
        const rows =
          /Contributors/.test(url) && !fields.has("ISNOACTIVITY")
            ? [own, foreign]
            : [];
        return Promise.resolve(
          jsonResponse({ Data: rows, Total: rows.length }),
        );
      });
    const result = await discoverPhoenixReportObservation({
      copId: "CAN-25-4",
      fetchImpl,
    });
    expect(result.grids.contributors).toEqual([own, foreign]);
    expect(result.refs.map((ref) => ref.reportPackageId)).toEqual([guid("aa")]);
  });

  it.each([
    { COPID: "CAN-25-5" },
    { COPID: "CAN-25-04" },
    { COPID: null },
    { ReportPackageId: "not-a-package" },
    { ReportPackageId: "" },
    { ReportPackageId: "00000000-0000-0000-0000-000000000000" },
    { RecentReport: guid("bb") },
    { RecentReport: "unknown" },
    { ReportName: "" },
  ])("refuses invalid physical report authority: %j", async (invalid) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ Data: [{ ...reportRow(), ...invalid }], Total: 1 }),
      );
    await expect(
      discoverPhoenixReportObservation({ copId: "CAN-25-4", fetchImpl }),
    ).rejects.toThrow(/Phoenix report discovery/);
  });

  it("refuses conflicting physical names across the grids", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse({
          Data: [reportRow(guid("aa"), /Contributors/.test(url) ? "Q1" : "Q2")],
          Total: 1,
        }),
      ),
    );
    await expect(
      discoverPhoenixReportObservation({ copId: "CAN-25-4", fetchImpl }),
    ).rejects.toThrow(/conflicting report names/);
  });

  it("fetchPhoenixReportPdf validates the %PDF signature and uses the cache", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 fake");
    const guid = "12345678-1234-1234-1234-123456789abc";
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      arrayBuffer: () => Promise.resolve(pdfBytes.buffer.slice(0)),
    });
    const store = new Map<string, Uint8Array>();
    const cache = {
      read: async (id: string) => store.get(id) ?? null,
      write: async (id: string, bytes: Uint8Array) => void store.set(id, bytes),
    };
    const first = await fetchPhoenixReportPdf({
      reportPackageId: guid,
      cache,
      fetchImpl,
    });
    expect(new TextDecoder().decode(first)).toContain("%PDF");
    await fetchPhoenixReportPdf({ reportPackageId: guid, cache, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second call served from cache

    const htmlImpl = vi.fn().mockResolvedValue({
      status: 200,
      arrayBuffer: () =>
        Promise.resolve(
          new TextEncoder().encode("<html>maintenance</html>").buffer.slice(0),
        ),
    });
    await expect(
      fetchPhoenixReportPdf({
        reportPackageId: guid.replace("1", "2"),
        fetchImpl: htmlImpl,
      }),
    ).rejects.toThrow(/not a PDF/);
    await expect(
      fetchPhoenixReportPdf({ reportPackageId: "not-a-guid", fetchImpl }),
    ).rejects.toThrow(/Not a report package GUID/);
    const failImpl = vi.fn().mockResolvedValue({
      status: 500,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    await expect(
      fetchPhoenixReportPdf({
        reportPackageId: guid.replace("1", "3"),
        fetchImpl: failImpl,
      }),
    ).rejects.toThrow(/HTTP 500/);
    // Strict 8-4-4-4-12: the loose 36-char class accepted a run of dashes.
    await expect(
      fetchPhoenixReportPdf({ reportPackageId: "-".repeat(36), fetchImpl }),
    ).rejects.toThrow(/Not a report package GUID/);
  });

  it("refresh bypasses cached PDFs and replaces only successful source bytes", async () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    const oldBytes = new TextEncoder().encode("%PDF-1.7 prior");
    const freshBytes = new TextEncoder().encode("%PDF-1.7 fresh");
    let stored = oldBytes;
    const cache = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (_id: string, bytes: Uint8Array) => {
        stored = bytes;
      }),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      arrayBuffer: async () => freshBytes.buffer.slice(0),
    });
    expect(
      await fetchPhoenixReportPdf({
        reportPackageId: id,
        cache,
        refresh: true,
        fetchImpl,
      }),
    ).toEqual(freshBytes);
    expect(cache.read).not.toHaveBeenCalled();
    expect(cache.write).toHaveBeenCalledWith(id, freshBytes);
    expect(stored).toEqual(freshBytes);

    fetchImpl.mockResolvedValue({
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      fetchPhoenixReportPdf({
        reportPackageId: id,
        cache,
        refresh: true,
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(cache.read).not.toHaveBeenCalled();
    expect(cache.write).toHaveBeenCalledTimes(1);
    expect(stored).toEqual(freshBytes);

    fetchImpl.mockResolvedValue({
      status: 200,
      arrayBuffer: async () =>
        new TextEncoder().encode("<html>maintenance</html>").buffer.slice(0),
    });
    await expect(
      fetchPhoenixReportPdf({
        reportPackageId: id,
        cache,
        refresh: true,
        fetchImpl,
      }),
    ).rejects.toThrow(/not a PDF/);
    expect(cache.write).toHaveBeenCalledTimes(1);
    expect(stored).toEqual(freshBytes);
  });

  it("phoenixFilesystemPdfCache survives a truncated file and writes atomically", async () => {
    const { chmod, mkdtemp, readdir, stat, writeFile } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "phx-pdf-cache-"));
    await chmod(dir, 0o755);
    const cache = phoenixFilesystemPdfCache(dir);
    const id = "12345678-1234-1234-1234-123456789abc";

    // A file without the %PDF signature (interrupted write) is a MISS, not a
    // permanently poisoned hit.
    await writeFile(join(dir, `${id}.pdf`), "%PD");
    expect(await cache.read(id)).toBeNull();

    await cache.write(id, new TextEncoder().encode("%PDF-1.7 fake"));
    expect(new TextDecoder().decode((await cache.read(id))!)).toContain("%PDF");
    // The temp file never survives a completed write.
    expect(await readdir(dir)).toEqual([`${id}.pdf`]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, `${id}.pdf`))).mode & 0o777).toBe(0o600);
  });
});

describe("phoenixCandidateCycleForDate", () => {
  it("derives the Apr-1-odd-year cycle from a date inside it", () => {
    expect(phoenixCandidateCycleForDate("2026-11-03")).toEqual({
      startYear: 2025,
      cycleStart: "2025-04-01",
      cycleEnd: "2027-03-31",
    });
    // A March runoff belongs to the SAME cycle as its November election.
    expect(phoenixCandidateCycleForDate("2027-03-09").startYear).toBe(2025);
    // Cycle boundary: Mar 31 closes the old cycle, Apr 1 opens the new one.
    expect(phoenixCandidateCycleForDate("2025-03-31").startYear).toBe(2023);
    expect(phoenixCandidateCycleForDate("2025-04-01").startYear).toBe(2025);
  });

  it("rejects non-ISO input", () => {
    expect(() => phoenixCandidateCycleForDate("11/03/2026")).toThrow(
      /Not an ISO date/,
    );
  });
});
