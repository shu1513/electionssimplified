import { describe, expect, it } from "vitest";
import { produceMaineMapLightFinancialFacts as produce } from "../../../src/pipeline/maineFinance/maineMapLightFinancialFacts.js";
import type { MaineMapLightAllFilerTransaction as Transaction } from "../../../src/pipeline/maineFinance/maineMapLightAllFilerCsv.js";
import type { MaineMapLightIndependentExpenditureAllocation as Allocation } from "../../../src/pipeline/maineFinance/maineMapLightIndependentExpenditureCsv.js";

const id = (letter: string) => `a_${letter.repeat(26)}`;
const filer = (letter: string) => `f_${letter.repeat(26)}`;
const context = {
  filerId: filer("c"),
  filerName: "Alex Example",
  office: "Senator",
  district: "14",
  electionYear: 2026,
  publishedAsOfDate: "2026-10-11",
};
function transaction(
  letter = "a",
  overrides: Partial<Transaction> = {},
): Transaction {
  return {
    occurrence: 1,
    transactionId: id(letter),
    filerId: context.filerId,
    filerName: context.filerName,
    filerFirstName: "Alex",
    filerLastName: "Example",
    filerOffice: "Senator",
    filerDistrict: "14",
    filerCounty: "",
    sourceRole: "contribution - monetary",
    transactionDate: "2026-09-18",
    amount: "$100.00",
    amountCents: 10000,
    election: "2026 General Election",
    description: "Source receipt",
    counterpartyClass: "political_action_committee",
    counterpartyName: "Example PAC",
    purpose: "",
    expenditureTargets: "",
    ...overrides,
  };
}
function independent(
  letter = "i",
  overrides: Partial<Transaction> = {},
): Transaction {
  return transaction(letter, {
    filerId: filer("p"),
    filerName: "EXAMPLE PAYER",
    filerFirstName: "",
    filerLastName: "",
    filerOffice: "",
    filerDistrict: "",
    sourceRole: "independent_expenditure - independent_expenditure",
    election: "",
    ...overrides,
  });
}
function allocation(
  letter = "i",
  overrides: Partial<Allocation> = {},
): Allocation {
  return {
    occurrence: 1,
    transactionId: id(letter),
    filerId: filer("p"),
    filerName: "EXAMPLE PAYER",
    transactionType: "independent_expenditure",
    transactionDate: "2026-09-18",
    totalTransactionAmount: "$100.00",
    totalTransactionAmountCents: 10000,
    description: "Source expense",
    purpose: "Mail",
    candidateName: context.filerName,
    candidateId: context.filerId,
    supportOppose: "support",
    amountSpentOnCandidate: "$100.00",
    amountSpentOnCandidateCents: 10000,
    ...overrides,
  };
}
function run(
  transactions: Transaction[],
  allocations: Allocation[] = [],
  reports: { html: string; sourceUrl: string }[] = [],
) {
  return produce({
    sourceContext: context,
    allFilerTransactions: transactions,
    ieAllocations: allocations,
    ordinaryReturnReports: reports,
  });
}

const reportUrl = `https://www.mainecampaignfinancedisclosure.com/public/filers/${filer("p")}/filings/d_${"d".repeat(26)}`;
function reportFixture(): string {
  const dt = (label: string, value: string) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const time = (value: string) => {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    return `<time datetime="${value}">${months[month - 1]} ${String(day).padStart(2, "0")}, ${year}</time>`;
  };
  const section = (label: string, body: string) =>
    `<section><h2>${label}</h2><div>${body}</div></section>`;
  const labels = [
    "Balance at the Beginning of the Period",
    "Total Contributions",
    "Total Monetary Contributions",
    "Total In-Kind Contributions",
    "Unitemized Total - Contributions of $200 or Less",
    "Total General Treasury Transfers",
    "Total Bank Interest",
    "Total Expenditures",
    "Total Independent Expenditures",
    "Total Loans Received",
    "Total Debts Owed",
    "Balance at the End of the Period",
    "Loan Balance",
    "Debt Balance",
  ];
  const headers = [
    "Date",
    "Name",
    "Address",
    "Occupation",
    "Employer",
    "Amount",
  ];
  const schedule = (label: string, letter: string, amount: string) =>
    section(
      label,
      `<table><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody><tr>${[
        `<a href="/public/activities/${id(letter)}">09/18/2026</a>`,
        "Source vendor",
        "",
        "",
        "",
        amount,
      ]
        .map(
          (value, index) => `<td data-label="${headers[index]}">${value}</td>`,
        )
        .join(
          "",
        )}</tr></tbody><tfoot><tr><th colspan="5">Total</th><td>${amount}</td></tr></tfoot></table>`,
    );
  const info =
    dt("Report Name", "End Of Third Quarter 2026") +
    dt("Report Type", "Campaign Finance") +
    dt(
      "Reporting Period",
      time("2026-07-15T00:01:00-04:00") +
        " - " +
        time("2026-09-30T23:59:00-04:00"),
    ) +
    dt("Filer Name", "EXAMPLE PAYER") +
    dt("Filing Status", "Filed") +
    dt("Date Submitted", time("2026-10-05T16:32:15-04:00")) +
    dt("Version of Report", "Amendment 1") +
    dt("Report ID", `d_${"d".repeat(26)}`);
  return `<html><body><h1>End Of Third Quarter 2026 - EXAMPLE PAYER</h1>${section("Filing Information", `<dl>${info}</dl>`)}${section("Filing Summary", `<dl>${labels.map((label) => dt(label, label === "Total Expenditures" ? "$800.00" : label === "Total Independent Expenditures" ? "$100.00" : "$0.00")).join("")}</dl>`)}${schedule("Expenditures", "e", "$1,000.00")}${schedule("Returned Expenditures", "r", "$200.00")}${schedule("Independent Expenditures", "i", "$100.00")}${section("Returned Independent Expenditures", '<em class="NoProvidedData">No returned independent expenditures to report</em>')}</body></html>`;
}
function withReturn(): Transaction[] {
  return [
    independent(),
    independent("e", {
      sourceRole: "expenditure - expenditure",
      amount: "$1,000.00",
      amountCents: 100000,
    }),
    independent("r", {
      sourceRole: "returned - returned_expenditure",
      amount: "$200.00",
      amountCents: 20000,
    }),
  ];
}

describe("Maine MapLight published financial facts", () => {
  it("uses explicit PAC/party types and reported full-name keys without generic recognition", () => {
    const facts = run([
      transaction(),
      transaction("b", {
        counterpartyClass: "political_party_committee",
        counterpartyName: "Example Party",
        amountCents: 5000,
      }),
      transaction("d", {
        counterpartyClass: "business",
        counterpartyName: "Business PAC",
      }),
      transaction("e", {
        counterpartyClass: "candidate_committee",
        counterpartyName: "Other Candidate",
      }),
      transaction("f", {
        counterpartyClass: "individual",
        counterpartyName: "Source Individual",
      }),
    ]);
    expect(
      facts.committeeDonorPositions?.map((row) => [
        row.committeeId,
        row.amountCents,
        row.sourceReportedClass,
      ]),
    ).toEqual([
      ["reported:EXAMPLE PAC", 10000, "political_action_committee"],
      ["reported:EXAMPLE PARTY", 5000, "political_party_committee"],
    ]);
  });
  it("preserves full punctuation and NFKC whitespace normalization only", () => {
    const facts = run([
      transaction("a", { counterpartyName: "  Ｅxample, P.A.C.  " }),
    ]);
    expect(facts.committeeDonorPositions?.[0].committeeId).toBe(
      "reported:EXAMPLE, P.A.C.",
    );
    expect(facts.committeeDonorPositions?.[0].committeeName).toBe(
      "  Ｅxample, P.A.C.  ",
    );
  });
  it("nets explicit same-owner monetary returns without choosing an original gift", () => {
    const facts = run([
      transaction(),
      transaction("b", {
        sourceRole: "returned - returned_monetary",
        amountCents: 15000,
      }),
    ]);
    expect(facts.committeeDonorPositions?.[0]).toMatchObject({
      amountCents: -5000,
      contributionCount: 1,
      giftTransactionIds: [id("a")],
      returnedTransactionIds: [id("b")],
    });
  });
  it("retains zero positions and positive gift counts after a full return", () => {
    expect(
      run([
        transaction(),
        transaction("b", { sourceRole: "returned - returned_monetary" }),
      ]).committeeDonorPositions?.[0],
    ).toMatchObject({ amountCents: 0, contributionCount: 1 });
  });
  it("retains equal source gifts with distinct IDs", () => {
    expect(
      run([transaction(), transaction("b")]).committeeDonorPositions?.[0],
    ).toMatchObject({ amountCents: 20000, contributionCount: 2 });
  });
  it("keeps in-kind, loans and interest separate from monetary donor positions", () => {
    const rows = [
      transaction(),
      transaction("b", { sourceRole: "contribution - in_kind" }),
      transaction("d", { sourceRole: "loan - loan" }),
      transaction("e", { sourceRole: "contribution - bank_interest" }),
    ];
    const facts = run(rows);
    expect(facts.candidateTransactions).toHaveLength(4);
    expect(facts.committeeDonorPositions?.[0].amountCents).toBe(10000);
  });
  it("accepts requested-year Primary and General, excluding explicit other elections but retaining facts", () => {
    const facts = run([
      transaction(),
      transaction("b", { election: "2026 Primary Election" }),
      transaction("d", { election: "2028 General Election" }),
    ]);
    expect(facts.candidateTransactions).toHaveLength(3);
    expect(facts.committeeDonorPositions?.[0]).toMatchObject({
      amountCents: 20000,
      contributionCount: 2,
    });
  });
  it.each(["", "2026 Special Election", "2028 Unknown Election"])(
    "preserves cash with unreviewed election context %s",
    (election) => {
      expect(
        run([transaction("a", { election })]).committeeDonorPositions,
      ).toBeUndefined();
    },
  );
  it.each(["contribution - monetary", "returned - returned_monetary"] as const)(
    "preserves unreviewed signed cash role %s",
    (sourceRole) => {
      expect(
        run([transaction("a", { sourceRole, amountCents: -100 })])
          .committeeDonorPositions,
      ).toBeUndefined();
    },
  );
  it("preserves missing return class/name/context and full-name class drift", () => {
    for (const field of [
      "counterpartyClass",
      "counterpartyName",
      "election",
    ] as const) {
      expect(
        run([
          transaction(),
          transaction("b", {
            sourceRole: "returned - returned_monetary",
            [field]: "",
          }),
        ]).committeeDonorPositions,
      ).toBeUndefined();
    }
    expect(
      run([transaction(), transaction("b", { counterpartyClass: "business" })])
        .committeeDonorPositions,
    ).toBeUndefined();
    expect(
      run([transaction("a", { counterpartyName: context.filerName })])
        .committeeDonorPositions,
    ).toBeUndefined();
  });
  it("preserves an unreviewed nonempty return owner class rather than treating it as non-PAC", () => {
    for (const counterpartyClass of ["unknown_source_class", "legacy_payee"]) {
      expect(
        run([
          transaction(),
          transaction("b", {
            sourceRole: "returned - returned_monetary",
            counterpartyClass,
            counterpartyName: "Unresolved Return Owner",
          }),
        ]).committeeDonorPositions,
      ).toBeUndefined();
    }
  });

  it("requires exact source receiving name/office/seat and date bounds", () => {
    for (const field of ["filerName", "filerOffice", "filerDistrict"] as const)
      expect(
        run([transaction("a", { [field]: "wrong" })]).committeeDonorPositions,
      ).toBeUndefined();
    expect(
      run([
        transaction("a", { transactionDate: "2025-12-31" }),
        transaction("b", { transactionDate: "2026-10-12" }),
      ]).candidateTransactions,
    ).toEqual([]);
  });
  it("never uses blank target IDs or names as candidate identity", () => {
    const facts = run(
      [independent()],
      [allocation("i", { candidateId: null })],
    );
    expect(facts.targetedAllocationFacts).toEqual([]);
    expect(facts.outsideAllocations).toBeUndefined();
  });
  it("requires exact reported target name alongside source candidate ID", () => {
    expect(
      run(
        [independent()],
        [allocation("i", { candidateName: "Different Example" })],
      ).outsideAllocations,
    ).toBeUndefined();
  });
  it("retains allocated money and does not repeat a multi-target whole payment", () => {
    const facts = run(
      [independent("i", { amountCents: 10000 })],
      [
        allocation("i", { amountSpentOnCandidateCents: 6000 }),
        allocation("i", {
          occurrence: 2,
          candidateId: filer("d"),
          candidateName: "Other Example",
          amountSpentOnCandidateCents: 4000,
        }),
      ],
    );
    expect(
      facts.outsideAllocations?.map((row) => row.amountSpentOnCandidateCents),
    ).toEqual([6000]);
  });
  it("requires whole global export sets, not a convenient target subset", () => {
    expect(() => run([independent()], [])).toThrow("transaction set mismatch");
    expect(() => run([], [allocation()])).toThrow(
      "transaction identity/control mismatch",
    );
  });
  it.each([
    "filerId",
    "filerName",
    "transactionDate",
    "totalTransactionAmountCents",
  ] as const)("rejects mismatched global %s", (field) => {
    const bad = {
      ...allocation(),
      [field]: field === "totalTransactionAmountCents" ? 9999 : "different",
    } as Allocation;
    expect(() => run([independent()], [bad])).toThrow(
      "transaction identity/control mismatch",
    );
  });
  it("rejects duplicate IDs/allocations and inconsistent allocation controls", () => {
    expect(() => run([transaction(), transaction()])).toThrow(
      "duplicate all-filer transaction ID",
    );
    expect(() => run([independent()], [allocation(), allocation()])).toThrow(
      "duplicate independent allocation key",
    );
    expect(() =>
      run(
        [independent()],
        [allocation("i", { amountSpentOnCandidateCents: 9999 })],
      ),
    ).toThrow("allocation sum mismatch");
  });
  it("preserves an affected payer while retaining another known payer and direct source facts", () => {
    const facts = run(
      [
        transaction(),
        ...withReturn(),
        independent("j", { filerId: filer("q"), filerName: "OTHER PAYER" }),
      ],
      [
        allocation(),
        allocation("j", { filerId: filer("q"), filerName: "OTHER PAYER" }),
      ],
    );
    expect(facts.committeeDonorPositions?.[0].amountCents).toBe(10000);
    expect(facts.targetedAllocationFacts).toHaveLength(2);
    expect(facts.outsideAllocations?.[0].filerName).toBe("OTHER PAYER");
    expect(facts.outsideOmittedPayers).toEqual([
      {
        filerId: filer("p"),
        filerName: "EXAMPLE PAYER",
        reason: "outside_return_role_unknown",
      },
    ]);
  });
  it("classifies an ordinary return only from raw report sections and complete controls", () => {
    const facts = run(
      withReturn(),
      [allocation()],
      [{ html: reportFixture(), sourceUrl: reportUrl }],
    );
    expect(facts.outsideOmittedPayers).toEqual([]);
    expect(facts.outsideAllocations?.[0].amountSpentOnCandidateCents).toBe(
      10000,
    );
  });
  it("does not impose an Original-only report policy", () => {
    for (const version of ["Amendment 1", "Original 0"]) {
      expect(
        run(
          withReturn(),
          [allocation()],
          [
            {
              html: reportFixture().replace("Amendment 1", version),
              sourceUrl: reportUrl,
            },
          ],
        ).outsideAllocations,
      ).toHaveLength(1);
    }
  });
  it.each([
    [
      "wrong source owner",
      (html: string) => html.replaceAll("EXAMPLE PAYER", "OTHER PAYER"),
    ],
    [
      "wrong returned cents",
      (html: string) => html.replaceAll("$200.00", "$201.00"),
    ],
    ["wrong returned ID", (html: string) => html.replaceAll(id("r"), id("s"))],
    [
      "wrong source whole IE",
      (html: string) => html.replaceAll("$100.00", "$101.00"),
    ],
    [
      "wrong expense cover",
      (html: string) => html.replaceAll("$800.00", "$801.00"),
    ],
    [
      "unknown return section",
      (html: string) =>
        html.replace("Returned Independent Expenditures", "Unknown Returns"),
    ],
    [
      "future submission",
      (html: string) =>
        html.replace("2026-10-05T16:32:15", "2026-10-12T16:32:15"),
    ],
  ])("preserves outside on %s", (_reason, mutate) => {
    expect(
      run(
        withReturn(),
        [allocation()],
        [{ html: mutate(reportFixture()), sourceUrl: reportUrl }],
      ).outsideAllocations,
    ).toBeUndefined();
  });
  it("preserves contradictory return classification across source reports", () => {
    const ordinary = reportFixture();
    const returnedIE = ordinary.replace(
      '<em class="NoProvidedData">No returned independent expenditures to report</em>',
      `<table><thead><tr>${["Date", "Name", "Address", "Occupation", "Employer", "Amount"].map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody><tr>${[`<a href="/public/activities/${id("r")}">09/18/2026</a>`, "Source vendor", "", "", "", "$200.00"].map((value, index) => `<td data-label="${["Date", "Name", "Address", "Occupation", "Employer", "Amount"][index]}">${value}</td>`).join("")}</tr></tbody><tfoot><tr><th colspan="5">Total</th><td>$200.00</td></tr></tfoot></table>`,
    );
    expect(
      run(
        withReturn(),
        [allocation()],
        [
          { html: ordinary, sourceUrl: reportUrl },
          { html: returnedIE, sourceUrl: reportUrl },
        ],
      ).outsideAllocations,
    ).toBeUndefined();
  });

  it("does not infer ordinary returns from arbitrary ID whitelist input", () => {
    const facts = produce({
      sourceContext: context,
      allFilerTransactions: withReturn(),
      ieAllocations: [allocation()],
      ordinaryReturnIds: [id("r")],
    } as Parameters<typeof produce>[0]);
    expect(facts.outsideAllocations).toBeUndefined();
  });
  it("does not claim a full zero from empty source sets", () => {
    const facts = run([]);
    expect(facts.committeeDonorPositions).toBeUndefined();
    expect(facts.outsideAllocations).toBeUndefined();
    expect(facts).not.toHaveProperty("outsideSupportTotal");
  });
  it("returns detached facts and excludes unknown contact properties", () => {
    const source = transaction();
    const target = allocation();
    const extra = { ...source, contactAddress: "PRIVATE_SOURCE" };
    const facts = run([extra, independent()], [target]);
    source.counterpartyName = "changed";
    target.candidateName = "changed";
    expect(facts.committeeDonorPositions?.[0].committeeName).toBe(
      "Example PAC",
    );
    expect(facts.targetedAllocationFacts[0].candidateName).toBe(
      context.filerName,
    );
    expect(JSON.stringify(facts)).not.toContain("PRIVATE_SOURCE");
  });
});
