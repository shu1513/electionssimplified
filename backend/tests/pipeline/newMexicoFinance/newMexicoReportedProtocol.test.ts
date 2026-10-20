import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NewMexicoOriginalSequence,
  type NewMexicoReportedScope,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedOriginals.js";
import { NM_REPORTED_PATHS } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedNative.js";
import { runNewMexicoNativeProtocol } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedProtocol.js";

const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T18:00:00.000Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const grid = () => ({
  TransactionId: 10,
  TransactionVersionId: 1,
  Amount: 12.34,
  TransactionDate: "2026-10-01T00:00:00",
  FiledDate: "2026-10-05T00:00:00" as string | null,
  Name: "Avery Quinn Sample",
  CommitteeId: "synthetic-receiving-id",
  RegistrationID: "synthetic-registration",
  CommitteeTypeCode: "01",
  CommitteeVersionId: 1,
  OfficeId: 1,
  DistrictId: 0,
  ElectionId: 2,
  ElectionCycleId: 3,
  ElectionYear: 2026,
  EntityTypeDescription: "Political Committee",
  ContributorPayeeName: "Synthetic Committee",
  Type: "Monetary",
  TotalRows: 1,
  Stance: "Support",
  Reason: "Synthetic memo, never target authority",
});
const detail = () => ({
  TransactionId: 10,
  TransactionVersid: 1,
  TransactionAmount: 12.34,
  TransactionDate: "2026-10-01T00:00:00",
  FiledDate: "2026-10-05T00:00:00" as string | null,
  TransactionCategoryDesc: "Monetary",
  TransactionCategoryCode: "MOI",
  TransactionTypeCode: "CON",
  EntityTypeCode: "COM",
  EntityTypeCodeDesc: "Political Committee",
  MemberId: "synthetic-donor-id",
  CommitteeName: "Synthetic Committee",
  Amended: 0,
  DeleteFlag: null,
  StatusFlag: null,
  TransactionHistory: 0,
  CommitteeVersid: 1,
  ElectionId: 3,
});
const ieBody = () => ({
  Transaction: {
    ...detail(),
    TransactionTypeCode: "IE",
    TransactionCategoryCode: "IIE",
    TransactionCategoryDesc: "Independent Expenditure",
  },
  MemberCandidate: {
    CandidateType: "CAN",
    CandidateName: "Avery Quinn Sample" as string | null,
    CandidateDescription: "Avery Quinn Sample" as string | null,
    CandidateId: 42,
    SupportFlag: 1,
    BallotQuestion: null as string | null,
    TransactionAmount: null as number | null,
    Amount: null,
  },
  AssociatedCandidateDetails: null,
  Expenseslist: null,
  IndependentContractorList: null,
});
type Options = {
  kind?: "committee" | "ie";
  rows?: Record<string, unknown>[];
  transaction?: Record<string, unknown>;
  expenditure?: Record<string, unknown>;
  profiles?: Record<string, unknown>[];
  closing?: Record<string, unknown>[];
};
async function run(options: Options = {}) {
  const kind = options.kind ?? "committee",
    root = await fs.mkdtemp(
      join(await fs.realpath(tmpdir()), "nm-protocol-synthetic-"),
    );
  roots.push(root);
  await fs.chmod(root, 0o700);
  let searches = 0;
  const rows = options.rows ?? [
    kind === "ie"
      ? {
          ...grid(),
          CommitteeTypeCode: "04",
          Type: "Independent Expenditure",
          Name: "Synthetic Political Party",
          ContributorPayeeName: "Synthetic Vendor",
          OfficeId: 0,
        }
      : grid(),
  ];
  const transport = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      let value: unknown;
      if (url.pathname === NM_REPORTED_PATHS.transactions) {
        searches++;
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ElectionYear: "2026",
          TransactionType: kind === "ie" ? "IE" : "CON",
          pageSize: 1000,
        });
        value = searches === 1 ? rows : (options.closing ?? rows);
      } else if (url.pathname === NM_REPORTED_PATHS.contribution)
        value = [options.transaction ?? detail()];
      else if (url.pathname === NM_REPORTED_PATHS.expenditure)
        value = options.expenditure ?? ieBody();
      else if (url.pathname === NM_REPORTED_PATHS.donor) {
        expect(url.searchParams.get("memberId")).toBe("synthetic-donor-id");
        value = options.profiles ?? [];
      } else if (url.pathname === NM_REPORTED_PATHS.cycle) {
        expect(url.searchParams.get("memberID")).toBe(
          "synthetic-receiving-member",
        );
        value = { "2": "2022 election", "3": "2026 election" };
      } else throw new Error("Unexpected synthetic source request");
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    },
  );
  const scope: NewMexicoReportedScope = {
      kind,
      year: 2026,
      selector: kind === "committee" ? "Avery Quinn Sample" : null,
      ...(kind === "committee"
        ? { memberId: "synthetic-receiving-member" }
        : {}),
    },
    sequence = await NewMexicoOriginalSequence.capture(scope, root, transport);
  return { promise: runNewMexicoNativeProtocol(sequence), sequence, transport };
}
describe("New Mexico complete native financial protocol", () => {
  it("uses the full published election-year population, including earlier calendar years", async () => {
    const date = "2024-10-01T00:00:00",
      runResult = await run({
        rows: [{ ...grid(), TransactionDate: date }],
        transaction: { ...detail(), TransactionDate: date },
      });
    const data = await runResult.promise;
    expect(data.receipts).toMatchObject([
      {
        amountCents: 1234,
        category: "MOI",
        date: "2024-10-01",
        nameProof: "transaction",
      },
    ]);
    expect(data).toMatchObject({
      receivingRows: 1,
      receivingAmountCents: 1234,
      excludedRows: 0,
      excludedAmountCents: 0,
    });
    expect(runResult.sequence.records.map((x) => x.role)).toEqual([
      "committee_cycle_opening",
      "committee_opening_1",
      "committee_detail_1",
      "committee_closing_1",
      "committee_cycle_closing",
    ]);
  });
  it("retains in-kind political-committee gifts", async () => {
    const r = await run({
      rows: [{ ...grid(), Type: "In-Kind" }],
      transaction: {
        ...detail(),
        TransactionCategoryDesc: "In-Kind",
        TransactionCategoryCode: "IKD",
      },
    });
    expect((await r.promise).receipts).toMatchObject([
      { category: "IKD", amountCents: 1234 },
    ]);
  });
  it("corroborates the ledger donor name using the actual financial donor's public political registration", async () => {
    const r = await run({
      transaction: {
        ...detail(),
        CommitteeName: "Synthetic historical member name",
      },
      profiles: [
        {
          CommitteeName: "Synthetic Committee",
          CommitteeType:
            "Political Committee - Political Party/Central Committee",
          MemberID: 0,
        },
      ],
    });
    expect((await r.promise).receipts).toMatchObject([
      { reportedName: "Synthetic Committee", nameProof: "registered_member" },
    ]);
    expect(
      r.sequence.records.some((x) =>
        x.url.includes("memberId=synthetic-donor-id"),
      ),
    ).toBe(true);
  });
  it("holds unresolved donor names instead of choosing a convenient source label", async () => {
    const r = await run({
      transaction: { ...detail(), CommitteeName: "Conflicting synthetic name" },
      profiles: [
        {
          CommitteeName: "Another synthetic entity",
          CommitteeType: "Political Committee - Other",
        },
      ],
    });
    await expect(r.promise).rejects.toThrow("unresolved_political_donor_name");
  });
  it("does not use a business profile as political-committee name proof", async () => {
    const r = await run({
      transaction: { ...detail(), CommitteeName: "Conflicting synthetic name" },
      profiles: [
        { CommitteeName: "Synthetic Committee", CommitteeType: "Corporation" },
      ],
    });
    await expect(r.promise).rejects.toThrow("unresolved_political_donor_name");
  });
  it.each(["individual", "candidate", "anonymous", "transfer"])(
    "keeps excluded %s occurrences in the complete financial controls",
    async (kind) => {
      const row = {
        ...grid(),
        EntityTypeDescription:
          kind === "individual"
            ? "Individual"
            : kind === "candidate"
              ? "Candidate/Officeholder"
              : kind === "anonymous"
                ? null
                : "Political Committee",
        Type:
          kind === "anonymous"
            ? "Anonymous"
            : kind === "transfer"
              ? "Intra-Candidate Transfer"
              : "Monetary",
      };
      const r = await run({ rows: [row] }),
        value = await r.promise;
      expect(value).toMatchObject({
        receipts: [],
        receivingRows: 1,
        receivingAmountCents: 1234,
        excludedRows: 1,
        excludedAmountCents: 1234,
      });
      expect(r.transport).toHaveBeenCalledTimes(4);
    },
  );
  it.each([
    "negative",
    "missingFiledDate",
    "wrongYear",
    "wrongPerson",
    "unknownClass",
    "partial",
    "changedClosing",
    "changedDetail",
  ])("holds %s without admitting a partial total", async (fault) => {
    const row = grid(),
      transaction = detail(),
      options: Options = { rows: [row], transaction };
    if (fault === "negative") {
      row.Amount = -12.34;
      transaction.TransactionAmount = -12.34;
    }
    if (fault === "missingFiledDate") {
      row.FiledDate = null;
      transaction.FiledDate = null;
    }
    if (fault === "wrongYear") row.ElectionYear = 2024;
    if (fault === "wrongPerson") row.Name = "Different Synthetic Person";
    if (fault === "unknownClass")
      row.EntityTypeDescription = "New unknown political category";
    if (fault === "partial") row.TotalRows = 2;
    if (fault === "changedClosing") options.closing = [{ ...row, Amount: 99 }];
    if (fault === "changedDetail") transaction.TransactionAmount = 13.34;
    const r = await run(options);
    await expect(r.promise).rejects.toThrow();
  });
  it("holds duplicate current transaction IDs rather than silently deduplicating versions", async () => {
    const r = await run({
      rows: [
        { ...grid(), TotalRows: 2 },
        { ...grid(), TotalRows: 2, TransactionVersionId: 2 },
      ],
    });
    await expect(r.promise).rejects.toThrow("duplicate_current_transaction_id");
  });
  it("reads all IE reporting types and uses explicit targets instead of vendor or memo text", async () => {
    const r = await run({ kind: "ie" }),
      data = await r.promise;
    expect(data.allocations).toMatchObject([
      {
        reportingName: "Synthetic Political Party",
        targetName: "Avery Quinn Sample",
        support: "support",
        amountCents: 1234,
      },
    ]);
    expect(r.sequence.records.map((x) => x.role)).toEqual([
      "ie_opening_1",
      "ie_detail_1",
      "ie_closing_1",
    ]);
  });
  it("retains missing IE filing dates as unavailable evidence for candidate-level gating", async () => {
    const body = ieBody();
    body.Transaction.FiledDate = null;
    const row = {
      ...grid(),
      Type: "Independent Expenditure",
      CommitteeTypeCode: "07",
      FiledDate: null,
    };
    const r = await run({ kind: "ie", rows: [row], expenditure: body });
    expect((await r.promise).allocations?.[0]?.filedDate).toBeNull();
  });
  it("keeps ballot questions distinct from candidate targets", async () => {
    const body = ieBody();
    Object.assign(body.MemberCandidate, {
      CandidateType: "BQC",
      CandidateName: null,
      CandidateDescription: null,
      CandidateId: 0,
      BallotQuestion: "Synthetic ballot question",
    });
    const r = await run({ kind: "ie", expenditure: body });
    expect((await r.promise).allocations?.[0]).toMatchObject({
      targetKind: "BQC",
      targetName: null,
      targetId: null,
    });
  });
  it.each([
    "stance",
    "multipleTargets",
    "splitAmount",
    "unknownTarget",
    "deleted",
  ])("holds unsupported IE %s", async (fault) => {
    const body = ieBody();
    if (fault === "stance") body.MemberCandidate.SupportFlag = 0;
    if (fault === "multipleTargets")
      Object.assign(body, {
        AssociatedCandidatesList: [
          { CandidateName: "Another synthetic target" },
        ],
      });
    if (fault === "splitAmount") body.MemberCandidate.TransactionAmount = 5;
    if (fault === "unknownTarget")
      body.MemberCandidate.CandidateType = "UNKNOWN";
    if (fault === "deleted") Object.assign(body.Transaction, { DeleteFlag: 1 });
    const r = await run({ kind: "ie", expenditure: body });
    await expect(r.promise).rejects.toThrow();
  });
});
