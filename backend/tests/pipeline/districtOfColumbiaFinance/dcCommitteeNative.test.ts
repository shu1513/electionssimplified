import { describe, expect, it } from "vitest";
import {
  dcCents,
  dcDay,
  dcCsv,
  dcCsvGridClosure,
  dcParentClosure,
  dcReceipt,
  dcPoliticalReceipt,
  dcRegistration,
} from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeNative.js";
import {
  dcCanonicalSeat,
  dcPersonMatches,
  qualifyDcCommitteeReceiver,
} from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeReceiver.js";
import {
  receiver,
  syntheticCsv,
  syntheticNative,
} from "./dcCommitteeSynthetic.js";
describe("DC complete native receipt semantics", () => {
  it.each([
    ["$.45", 45],
    ["$1,234.50", 123450],
    ["-12.3400", -1234],
    ["0", 0],
    ["12.0000", 1200],
  ])("parses exact cents %s", (v, n) => expect(dcCents(v)).toBe(n));
  it.each([
    "1.001",
    "1e5",
    "1,23",
    "$-2",
    "12.",
    ".",
    "90071992547410",
    "(12.00)",
  ])("rejects noncanonical or fractional money %s", (v) =>
    expect(() => dcCents(v)).toThrow(),
  );
  it.each(["2026-02-30", "2/29/2025", "2026-10-01 junk", "/Date(0)/", "2026-10-01T99:99:99"])(
    "rejects malformed dates %s",
    (v) => expect(() => dcDay(v)).toThrow(),
  );
  it("closes every CSV context and full political names while preserving individual middle text", () => {
    const n = syntheticNative(),
      csv = dcCsv(syntheticCsv(n.receipts));
    expect(csv.rows[3]!["Contributor Middle Name"]).toBe("A");
    expect(() => dcCsvGridClosure(csv.rows, n.receipts)).not.toThrow();
    const damaged = structuredClone(csv.rows);
    damaged[0]!["Contributor Organization Name"] = "Different Political Name";
    expect(() => dcCsvGridClosure(damaged, n.receipts)).toThrow(/closure/);
  });
  it("rejects malformed CSV without dropping or repairing a financial row", () => {
    const csv = syntheticCsv(syntheticNative().receipts).toString("utf16le");
    for (const s of [
      csv + '"unterminated',
      csv.replace('"12.34"', '"12.34"x'),
      csv.replace('"12.34"', '"12.34",extra'),
    ])
      expect(() => dcCsv(Buffer.from(s, "utf16le"))).toThrow();
  });
  it.each([
    ["A1", "Republican"],
    ["A1", "Democratic"],
    ["A2", "PAC"],
    ["A2", "Other PAC or Committee"],
    ["A2", "Labor Sponsored PAC"],
    ["A2", "Corporate Sponsored PAC"],
    ["A4", "Committee"],
  ])("includes native %s / %s", (schedule, contributorClass) =>
    expect(dcPoliticalReceipt({ schedule, contributorClass })).toBe(true),
  );
  it.each([
    ["A", "Corporation"],
    ["A", "Labor"],
    ["A3", "Candidate"],
    ["A5", ""],
    ["A6", "Other"],
  ])("excludes %s / %s", (schedule, contributorClass) =>
    expect(dcPoliticalReceipt({ schedule, contributorClass })).toBe(false),
  );
  it.each([
    ["A", "PAC"],
    ["A2", "Corporation"],
    ["A4", "Candidate"],
    ["A2", "Unknown New Class"],
  ])("holds contradicting %s / %s", (schedule, contributorClass) =>
    expect(() => dcPoliticalReceipt({ schedule, contributorClass })).toThrow(
      /conflict/,
    ),
  );
  it("requires each receipt's unique current parent and highest family amendment", () => {
    const n = syntheticNative(),
      rows = n.receipts.map((r) => dcReceipt(r, 2026));
    expect(() => dcParentClosure(rows, n.parents)).not.toThrow();
    expect(() =>
      dcParentClosure(rows, [
        ...n.parents,
        { ...n.parents[1]!, ScheduleMasterId: 3, ReportStatus: " Amendment2" },
      ]),
    ).toThrow(/current_financial/);
    expect(() => dcParentClosure(rows, [...n.parents, n.parents[1]!])).toThrow(
      /ambiguous_financial_parent/,
    );
    const changed = structuredClone(n.parents);
    changed[1]!.CommitteeKey = "OTHER";
    expect(() => dcParentClosure(rows, changed)).toThrow(/binding/);
  });
  it("does not confuse zero default transaction IDs with the actual row ID", () => {
    const row = { ...syntheticNative().receipts[0]!, ScheduleTransactionId: 0 };
    expect(dcReceipt(row, 2026).id).toBe("1");
    expect(() => dcReceipt({ ...row, Id: 0 }, 2026)).toThrow(/native_id/);
  });
});
describe("DC receiving identity and office evidence", () => {
  it("binds approved primary receipts to the same canonical general-election receiver", () =>
    expect(
      qualifyDcCommitteeReceiver(
        receiver,
        syntheticNative().registry.map(dcRegistration),
      ).committeeKey,
    ).toBe("PUBLIC-COMMITTEE-1"));
  it.each([
    { activeCandidateOwnerCount: 2 },
    { electionYear: 2028 },
    { canonicalDistrictName: "Different City" },
    { candidateAliases: ["Jordan B Example", "Jordan Example"] },
    {
      candidateAliases: ["Jordan A Example Jr", "Jordan Example"],
      legacyCommitteeName: "Different Committee",
    },
  ])("holds changed receiving context %j", (change) =>
    expect(() =>
      qualifyDcCommitteeReceiver(
        { ...receiver, ...change },
        syntheticNative().registry.map(dcRegistration),
      ),
    ).toThrow(),
  );
  it("retains contradictory middle/generation evidence across every alias", () => {
    expect(
      dcPersonMatches(
        ["Jordan A Example", "Jordan Example"],
        "Example, Jordan B",
      ),
    ).toBe(false);
    expect(
      dcPersonMatches(
        ["Jordan Example Jr", "Jordan Example"],
        "Jordan Example Sr",
      ),
    ).toBe(false);
    expect(dcPersonMatches(["Jordan A Example"], "Example, Jordan Alice")).toBe(
      true,
    );
  });
  it("requires canonical ward, chair and at-large evidence to agree", () => {
    const council = {
      ...receiver,
      officeName: "City Council Member",
      linkOfficeName: "City Council Member",
    };
    expect(
      dcCanonicalSeat({
        ...council,
        district: "AT-LARGE",
        ballotTitle: "Councilmember At-Large",
      }),
    ).toBe("AT-LARGE");
    expect(
      dcCanonicalSeat({
        ...council,
        district: "CHAIR",
        ballotTitle: "Chairman of the Council",
      }),
    ).toBe("CHAIR");
    expect(
      dcCanonicalSeat({
        ...council,
        officeScope: "state_upper",
        canonicalDistrictType: "state_upper",
        canonicalDistrictName: "Ward 5 (2024); District of Columbia",
        district: "WARD 5",
        ballotTitle: "Ward 5 Member of the Council",
      }),
    ).toBe("WARD 5");
    expect(() =>
      dcCanonicalSeat({
        ...council,
        district: "AT-LARGE",
        ballotTitle: "Chairman of the Council",
      }),
    ).toThrow(/chair/);
  });
  it("holds two principal registrations for the same person and scope", () => {
    const n = syntheticNative().registry.map(dcRegistration);
    expect(() =>
      qualifyDcCommitteeReceiver(receiver, [
        ...n,
        {
          ...n[0]!,
          committeeId: "2",
          committeeKey: "OTHER",
          committeeName: "Other Receiver",
        },
      ]),
    ).toThrow(/ambiguous_native/);
  });
});
