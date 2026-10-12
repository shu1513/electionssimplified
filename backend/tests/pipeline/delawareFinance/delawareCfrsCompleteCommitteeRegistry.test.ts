import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  fetchDelawareCfrsCompleteCommitteeRegistry,
  decodeDelawareCompleteCommitteeRegistryPage,
} from "../../../src/pipeline/delawareFinance/delawareCfrsCompleteCommitteeRegistry.js";
import type { DelawareCfrsResponseCapture } from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    MemberID: id,
    MemberVersID: 7,
    Committee_Id: `02${String(id).padStart(6, "0")}`,
    CommitteeName: `Example Committee ${id}`,
    CommitteeTypeCode: "02",
    CommitteeType: "Political Action Committee",
    CommitteeStatus: "Closed",
    Formtype: "SO",
    sourceLiteral: "retained",
    ...overrides,
  };
}
function fake(
  total: number,
  pages: unknown[][],
  options: {
    rendered?: number;
    totals?: number[];
    badJson?: boolean;
    retry?: boolean;
  } = {},
) {
  const requests: { path: string; fields: URLSearchParams }[] = [];
  let pageIndex = 0,
    gridAttempt = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const fields = new URLSearchParams(String(init?.body ?? ""));
    requests.push({ path, fields });
    if (path === "/Public/ViewCommittees")
      return new Response("form", { headers: { "content-type": "text/html" } });
    if (path === "/Public/Search")
      return new Response(
        `<script>jQuery('#Grid').tGrid({total:${options.rendered ?? total}});</script>`,
        { headers: { "content-type": "text/html" } },
      );
    if (path !== "/Public/_ViewCommittees")
      throw new Error("Unexpected test route");
    if (options.retry && gridAttempt++ === 0)
      return new Response("unavailable", { status: 503 });
    const i = pageIndex++;
    return new Response(
      options.badJson
        ? "{}"
        : JSON.stringify({
            data: pages[i] ?? [],
            total: options.totals?.[i] ?? total,
          }),
      { headers: { "content-type": "application/json" } },
    );
  };
  return {
    requests,
    sessionOptions: {
      fetchImpl,
      spacingMs: 0,
      retryBackoffMs: 0,
      sleep: async () => {},
      maxAttempts: options.retry ? 2 : 1,
    },
  };
}
describe("complete broad Delaware committee registry transport", () => {
  it("retains every physical FF/SO row, class/status and raw field under blank selectors", async () => {
    const rows = [
      row(1),
      row(1, { Formtype: "FF" }),
      row(2, { CommitteeTypeCode: "01" }),
      row(3, { CommitteeTypeCode: "99", CommitteeStatus: "Unknown" }),
    ];
    const f = fake(4, [rows]);
    const r = await fetchDelawareCfrsCompleteCommitteeRegistry(f);
    expect(r.rows).toEqual(rows);
    expect(r.declaredCount).toBe(4);
    expect(r.diagnostics).toEqual([]);
    const search = f.requests.find((q) => q.path === "/Public/Search")!;
    for (const [key, value] of search.fields)
      expect(value).toBe(key === "btnSearch" ? "Search" : "");
    expect(r).not.toHaveProperty("current");
    expect(r).not.toHaveProperty("verified");
  });
  it("retains the published blank-name type-05 rows and continues to the terminal page", async () => {
    const unnamed = row(2837, {
      Committee_Id: "05002837",
      CommitteeName: "",
      CommitteeTypeCode: "05",
      CommitteeType: "Certification of Intention",
      CommitteeStatus: "Active",
      MemberVersID: 1,
    });
    const full = Array.from({ length: 500 }, (_, i) => row(i + 1));
    full[244] = unnamed;
    full[245] = { ...unnamed, MemberID: 2836, Committee_Id: "05002836" };
    const f = fake(501, [full, [row(501)]]);
    const result = await fetchDelawareCfrsCompleteCommitteeRegistry(f);
    expect(result.rows).toHaveLength(501);
    expect(result.declaredCount).toBe(501);
    expect(result.rows!.slice(244, 246)).toEqual(full.slice(244, 246));
    expect(result.diagnostics).toEqual([]);
    expect(
      f.requests
        .filter((r) => r.path === "/Public/_ViewCommittees")
        .map((r) => r.fields.get("page")),
    ).toEqual(["1", "2"]);
  });

  it.each([
    {
      CommitteeTypeCode: "02",
      CommitteeType: "Political Action Committee",
      Committee_Id: "02002837",
    },
    { CommitteeName: null },
    { CommitteeName: " " },
    { MemberID: 0 },
    { CommitteeType: "Unknown" },
    { Committee_Id: "02002837" },
  ])(
    "does not turn unsupported blank identity %j into registry authority",
    async (change) => {
      const unnamed = row(2837, {
        Committee_Id: "05002837",
        CommitteeName: "",
        CommitteeTypeCode: "05",
        CommitteeType: "Certification of Intention",
        ...change,
      });
      const result = await fetchDelawareCfrsCompleteCommitteeRegistry(
        fake(1, [[unnamed]]),
      );
      expect(result.rows).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
    },
  );

  it("retains physical multiplicity and raw fields in the broad page decoder", () => {
    const unnamed = row(2837, {
      Committee_Id: "05002837",
      CommitteeName: "",
      CommitteeTypeCode: "05",
      CommitteeType: "Certification of Intention",
      rawSourceMarker: null,
    });
    const result = decodeDelawareCompleteCommitteeRegistryPage(
      JSON.stringify({ data: [unnamed, unnamed, row(1)], total: 3 }),
    );
    expect(result).toEqual({ rows: [unnamed, unnamed, row(1)], total: 3 });
    expect(result.rows[0]).not.toHaveProperty("resolvedName");
  });

  it("exhausts exact 500-row multiples with a genuine extra empty page", async () => {
    const f = fake(500, [
      Array.from({ length: 500 }, (_, i) => row(i + 1)),
      [],
    ]);
    const r = await fetchDelawareCfrsCompleteCommitteeRegistry(f);
    expect(r.rows).toHaveLength(500);
    expect(
      f.requests
        .filter((q) => q.path === "/Public/_ViewCommittees")
        .map((q) => [q.fields.get("page"), q.fields.get("size")]),
    ).toEqual([
      ["1", "500"],
      ["2", "500"],
    ]);
  });
  it("closes a short final page against both declared counts", async () => {
    const f = fake(501, [
      Array.from({ length: 500 }, (_, i) => row(i + 1)),
      [row(501)],
    ]);
    expect(
      (await fetchDelawareCfrsCompleteCommitteeRegistry(f)).rows,
    ).toHaveLength(501);
  });
  it("returns genuine empty registry observations without financial zero authority", async () => {
    const r = await fetchDelawareCfrsCompleteCommitteeRegistry(fake(0, [[]]));
    expect(r.rows).toEqual([]);
    expect(r.declaredCount).toBe(0);
    expect(r).not.toHaveProperty("pacDonors");
  });
  it.each([
    "short",
    "changed",
    "rendered",
    "repeat",
    "schema",
    "invalid",
    "excess",
    "cap",
  ])("omits rows on %s failure retaining attempts", async (kind) => {
    const full = Array.from({ length: 500 }, (_, i) => row(i + 1));
    const f =
      kind === "short"
        ? fake(2, [[row(1)]])
        : kind === "changed"
          ? fake(501, [full, [row(501)]], { totals: [501, 502] })
          : kind === "rendered"
            ? fake(1, [[row(1)]], { rendered: 2 })
            : kind === "repeat"
              ? fake(1000, [full, full])
              : kind === "schema"
                ? fake(1, [[]], { badJson: true })
                : kind === "invalid"
                  ? fake(1, [[row(0)]])
                  : kind === "excess"
                    ? fake(1, [[row(1), row(2)]])
                    : fake(500, [full]);
    const r = await fetchDelawareCfrsCompleteCommitteeRegistry({
      ...f,
      maxPages: kind === "cap" ? 1 : 40,
    });
    expect(r.rows).toBeUndefined();
    expect(r.declaredCount).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
    expect(r.sourceCaptures.length).toBeGreaterThanOrEqual(3);
  });
  it("retains failed retry bytes, original times and safe detached observer captures", async () => {
    const f = fake(1, [[row(1)]], { retry: true });
    const observed: DelawareCfrsResponseCapture[] = [];
    const r = await fetchDelawareCfrsCompleteCommitteeRegistry({
      sessionOptions: {
        ...f.sessionOptions,
        onResponseCapture: (c) => {
          observed.push(c);
          c.body.fill(0);
          if (c.financeFields)
            (c.financeFields as Record<string, string>).page = "999";
        },
      },
    });
    expect(r.rows).toHaveLength(1);
    expect(r.sourceCaptures.map((c) => c.status)).toEqual([200, 200, 503, 200]);
    expect(
      r.sourceCaptures.every(
        (c) => createHash("sha256").update(c.body).digest("hex") === c.sha256,
      ),
    ).toBe(true);
    expect(
      r.sourceCaptures.every(
        (c) => Date.parse(c.startedAt) <= Date.parse(c.completedAt),
      ),
    ).toBe(true);
    expect(r.sourceCaptures[3]!.financeFields?.page).toBe("1");
    expect(observed).toHaveLength(4);
  });
  it("propagates callback failures without retry or fabricated success", async () => {
    const f = fake(1, [[row(1)]], { retry: true });
    await expect(
      fetchDelawareCfrsCompleteCommitteeRegistry({
        sessionOptions: {
          ...f.sessionOptions,
          onResponseCapture: () => {
            throw new Error("observer failed");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "capture_error" });
    expect(f.requests).toHaveLength(1);
  });
  it.each([0, 41, 1.5])(
    "rejects invalid page budget %s before any network",
    async (maxPages) => {
      const f = fake(1, [[row(1)]]);
      await expect(
        fetchDelawareCfrsCompleteCommitteeRegistry({ ...f, maxPages }),
      ).rejects.toThrow(/page budget/);
      expect(f.requests).toHaveLength(0);
    },
  );
});
