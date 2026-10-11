import { describe, expect, it } from "vitest";
import {
  decodeIllinoisSbeLegalCommitteeRegistry,
  decodeIllinoisSbeWindows1252,
  createIllinoisSbeLegalCommitteeDonorMatcher,
  ILLINOIS_SBE_COMMITTEE_REGISTRY_HEADER,
  matchIllinoisSbeLegalCommitteeDonor,
  type IllinoisSbeLegalCommitteeRegistryRow,
} from "../../../src/pipeline/illinoisFinance/illinoisSbeLegalCommitteeDonorMatcher.js";

// Actual public legal identities, with address and unused source fields omitted.
const BANC = { committeeId: "1028", legalName: "Community BANCPAC", committeeType: "Political Action", status: "A" };
const POLICY = { committeeId: "35268", legalName: "Illinois Policy PAC", committeeType: "Political Action", status: "A" };
const RECIPIENT = { committeeId: "39503", legalName: "Balkema for State Senate", committeeType: "Candidate", status: "A" };
const DGA = { committeeId: "32515", legalName: "Democratic Governors Association-Illinois", committeeType: "Political Action", status: "F" };
const PARTY = { committeeId: "615", legalName: "Kane County Republican Central Cmte", committeeType: "Political Party", status: "A" };
const REGISTRY = [BANC, POLICY, RECIPIENT, DGA, PARTY];
function sourceRow(row: IllinoisSbeLegalCommitteeRegistryRow, referName = ""): string[] {
  const fields = ILLINOIS_SBE_COMMITTEE_REGISTRY_HEADER.map(() => "");
  fields[0] = row.committeeId; fields[1] = row.committeeType; fields[6] = referName;
  fields[7] = row.legalName; fields[14] = row.status;
  return fields;
}
const HEADER = ILLINOIS_SBE_COMMITTEE_REGISTRY_HEADER.join("\t") + "\r\n";
function raw(rows = REGISTRY): Uint8Array {
  return Buffer.from(HEADER + rows.map((row) => sourceRow(row).join("\t")).join("\r\n") + "\r\n", "latin1");
}
function match(donorName = BANC.legalName, registryRows = REGISTRY, recipientCommitteeIds?: readonly string[]) {
  return matchIllinoisSbeLegalCommitteeDonor({ donorName, registryRows, recipientCommitteeIds });
}

describe("strict Illinois full legal committee registry decoder", () => {
  it("maps the complete CP1252 C1 byte range explicitly, preserving undefined controls", () => {
    expect(decodeIllinoisSbeWindows1252(Uint8Array.from({ length: 32 }, (_, index) => 0x80 + index)))
      .toBe("€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ");
  });

  it("decodes all five actual identities including Candidate and final PAC rows without retaining ReferName", () => {
    const bytes = Buffer.from(HEADER + REGISTRY.map((row) => sourceRow(row, "unverified alias").join("\t")).join("\r\n") + "\r\n");
    expect(decodeIllinoisSbeLegalCommitteeRegistry(bytes)).toEqual(REGISTRY);
    expect(match("unverified alias", decodeIllinoisSbeLegalCommitteeRegistry(bytes))).toEqual({ status: "unmatched", reason: "donor_legal_name_unresolved" });
  });

  it("preserves actual Windows-1252 Peñaranda and REALTORS® names", () => {
    const rows = [{ ...RECIPIENT, committeeId: "36130", legalName: "Friends of Nicolette Peñaranda" },
      { ...BANC, committeeId: "1126", legalName: "REALTORS® Political Action Committee" }];
    expect(decodeIllinoisSbeLegalCommitteeRegistry(raw(rows))).toEqual(rows);
    expect(match("REALTORS® Political Action Committee", decodeIllinoisSbeLegalCommitteeRegistry(raw(rows))))
      .toMatchObject({ status: "matched", committeeId: "1126" });
  });

  it("uses Windows-1252 curly quotes rather than UTF8 replacement or Latin1 controls", () => {
    const fields = sourceRow({ ...BANC, legalName: "Friends of \"Name\"" });
    const bytes = Buffer.from(HEADER + fields.join("\t") + "\n");
    const quotes = [...bytes.entries()].filter(([, value]) => value === 34).map(([index]) => index);
    bytes[quotes[0]!] = 0x93; bytes[quotes[1]!] = 0x94;
    expect(decodeIllinoisSbeLegalCommitteeRegistry(bytes)[0]!.legalName).toBe("Friends of “Name”");
  });

  it.each(["Unknown Future Type", "", "Independent Expenditure", "Ballot Initiative", "Limited Activity Committee"])(
    "retains non-allowlisted source type %s for global identity checks", (committeeType) => {
      const row = { ...BANC, committeeType };
      expect(decodeIllinoisSbeLegalCommitteeRegistry(raw([row]))).toEqual([row]);
    });

  it.each(["ID", "Name", "TypeOfCommittee"])("requires the exact published header including %s", (column) => {
    const header = ILLINOIS_SBE_COMMITTEE_REGISTRY_HEADER.map((field) => field === column ? field + "Changed" : field);
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(Buffer.from(header.join("\t") + "\n"))).toThrow(/header does not match/);
  });

  it.each([-1, 1])("rejects wrong-width rows across all types: delta %s", (delta) => {
    const fields = sourceRow({ ...BANC, committeeType: "Unknown Future Type" });
    if (delta === -1) fields.pop(); else fields.push("extra");
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(Buffer.from(HEADER + fields.join("\t") + "\n"))).toThrow(/columns; expected 27/);
  });

  it.each(["0", "-1", "1028x", "001028", "9007199254740992"])("rejects invalid IDs even on unallowed rows: %s", (committeeId) => {
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(raw([{ ...BANC, committeeId, committeeType: "" }]))).toThrow(/invalid committee identity/);
  });

  it.each(["", "   ", "bad\u0000name"])("rejects blank or corrupt legal identity: %j", (legalName) => {
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(raw([{ ...BANC, legalName }]))).toThrow(/invalid committee identity/);
  });

  it("rejects corrupt committee type and status fields rather than normalizing them into identity", () => {
    for (const row of [{ ...BANC, committeeType: "Political\u0000Action" }, { ...BANC, status: "A\u0000" }]) {
      expect(() => decodeIllinoisSbeLegalCommitteeRegistry(raw([row]))).toThrow(/invalid committee identity/);
      expect(match(BANC.legalName, [row])).toMatchObject({ status: "ambiguous", reason: "invalid_registry_identity" });
    }
  });

  it("rejects incomplete source, even if earlier rows are valid", () => {
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(raw().subarray(0, raw().length - 2))).toThrow(/final newline is missing/);
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(Buffer.from(HEADER + '1028\t"unterminated\n'))).toThrow(/unterminated quoted field/);
  });

  it("rejects header-only and empty raw registry rather than implying no committee donors", () => {
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(Buffer.from(HEADER))).toThrow(/no committee rows/);
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry(new Uint8Array())).toThrow(/nonempty raw bytes/);
    expect(() => decodeIllinoisSbeLegalCommitteeRegistry("text" as unknown as Uint8Array)).toThrow(/nonempty raw bytes/);
  });

  it("allows exact duplicate identity but rejects conflicting same-ID names or types", () => {
    expect(decodeIllinoisSbeLegalCommitteeRegistry(raw([BANC, { ...BANC }]))).toHaveLength(2);
    for (const conflicting of [{ ...BANC, legalName: "Different PAC" }, { ...BANC, committeeType: "Candidate" }]) {
      expect(() => decodeIllinoisSbeLegalCommitteeRegistry(raw([BANC, conflicting]))).toThrow(/conflicting identities/);
    }
  });
});

describe("Illinois typed exact legal committee donor matcher", () => {
  it.each([BANC, POLICY, DGA, PARTY])("allows exact source-backed class for $legalName", (row) => {
    expect(match(row.legalName)).toEqual({ status: "matched", committeeId: row.committeeId, legalName: row.legalName, committeeType: row.committeeType });
  });

  it("allows DGA as donor while retaining its final status and rejecting the Candidate recipient", () => {
    expect(match(DGA.legalName, REGISTRY, [RECIPIENT.committeeId])).toMatchObject({ status: "matched", committeeId: "32515" });
    expect(match(RECIPIENT.legalName)).toEqual({ status: "unmatched", reason: "donor_committee_type_not_allowed" });
  });

  it("normalizes formatting and case without inventing source aliases", () => {
    expect(match("  COMMUNITY-BANCPAC  ")).toMatchObject({ status: "matched", committeeId: "1028" });
    expect(match("BANCPAC")).toEqual({ status: "unmatched", reason: "donor_legal_name_unresolved" });
    expect(match("Community Bank PAC")).toEqual({ status: "unmatched", reason: "donor_legal_name_unresolved" });
  });

  it("does not remove accents, expand ampersands, or guess FEC identities", () => {
    expect(match("Penaranda PAC", [{ ...BANC, legalName: "Peñaranda PAC" }])).toMatchObject({ status: "unmatched" });
    expect(match("A and B PAC", [{ ...BANC, legalName: "A & B PAC" }])).toMatchObject({ status: "unmatched" });
    expect(match("C00032979")).toMatchObject({ status: "unmatched" });
  });

  it.each(["Candidate", "Independent Expenditure", "Ballot Initiative", "Limited Activity Committee", "", "Unknown Future Type", "Political-Action", "Political/Party"])(
    "rejects class %s after unique legal identity resolution", (committeeType) => {
      expect(match(BANC.legalName, [{ ...BANC, committeeType }])).toEqual({ status: "unmatched", reason: "donor_committee_type_not_allowed" });
    });

  it.each(["Candidate", "Independent Expenditure", "", "Political Action"])(
    "checks all-type/all-status name ambiguity before filtering type %s", (committeeType) => {
      expect(match(BANC.legalName, [BANC, { ...BANC, committeeId: "888", legalName: "COMMUNITY-BANCPAC", committeeType, status: "F" }]))
        .toEqual({ status: "ambiguous", reason: "registry_legal_name_ambiguous_across_all_types" });
    });

  it("does not resolve global name ambiguity by choosing the non-self ID", () => {
    expect(match(BANC.legalName, [BANC, { ...BANC, committeeId: "888" }], [BANC.committeeId]))
      .toMatchObject({ status: "ambiguous" });
  });

  it("rejects self by exact source identity", () => {
    expect(match(BANC.legalName, REGISTRY, ["1028"]))
      .toEqual({ status: "unmatched", reason: "donor_is_recipient_committee" });
  });

  it("collapses identity-equivalent duplicates without filtering final rows", () => {
    expect(match(BANC.legalName, [BANC, { ...BANC, status: "F" }])).toMatchObject({ status: "matched", committeeId: "1028" });
  });

  it("rejects conflicting same-ID identities even when a partial subset would match uniquely", () => {
    expect(match(BANC.legalName, [BANC, { ...BANC, legalName: "Different Committee", committeeType: "Candidate" }]))
      .toEqual({ status: "ambiguous", reason: "registry_committee_identity_conflict" });
  });

  it("rejects invalid typed input or an empty registry instead of dropping rows", () => {
    expect(match(BANC.legalName, [BANC, { ...POLICY, committeeId: "bad" }])).toMatchObject({ status: "ambiguous", reason: "invalid_registry_identity" });
    expect(match(BANC.legalName, REGISTRY, ["bad"])).toMatchObject({ status: "ambiguous", reason: "invalid_recipient_committee_identity" });
    expect(match(BANC.legalName, [])).toEqual({ status: "unmatched", reason: "registry_empty" });
    expect(match(" ")).toEqual({ status: "unmatched", reason: "invalid_donor_name" });
  });
});


describe("Illinois generation-level legal donor matcher", () => {
  it("keeps all-type name ambiguity even if callers remove or alter the other identity", () => {
    const rows = [{ ...BANC }, { ...BANC, committeeId: "888", committeeType: "Candidate", status: "F" }];
    const lookup = createIllinoisSbeLegalCommitteeDonorMatcher(rows);
    rows[1]!.legalName = "Different name"; rows.splice(1, 1);
    expect(lookup({ donorName: BANC.legalName })).toEqual({ status: "ambiguous", reason: "registry_legal_name_ambiguous_across_all_types" });
  });

  it("copies legal ID/name/type fields instead of retaining caller objects or arrays", () => {
    const row = { ...BANC }; const rows = [row];
    const lookup = createIllinoisSbeLegalCommitteeDonorMatcher(rows);
    row.committeeId = "888"; row.legalName = "Different PAC"; row.committeeType = "Candidate";
    rows.push({ ...BANC, committeeId: "777" });
    expect(lookup({ donorName: BANC.legalName })).toEqual({ status: "matched", committeeId: "1028", legalName: BANC.legalName, committeeType: "Political Action" });
    expect(lookup({ donorName: "Different PAC" })).toMatchObject({ status: "unmatched" });
    expect(lookup({ donorName: BANC.legalName, recipientCommitteeIds: ["1028"] })).toMatchObject({ status: "unmatched", reason: "donor_is_recipient_committee" });
  });

  it("retains invalid-registry diagnostics after callers remove conflicting same-ID rows", () => {
    const rows = [{ ...BANC }, { ...BANC, legalName: "Different Committee", committeeType: "Candidate" }];
    const lookup = createIllinoisSbeLegalCommitteeDonorMatcher(rows); rows.pop();
    const result = lookup({ donorName: BANC.legalName });
    expect(result).toEqual({ status: "ambiguous", reason: "registry_committee_identity_conflict" });
    if (result.status !== "matched") result.reason = "changed by caller";
    expect(lookup({ donorName: BANC.legalName })).toEqual({ status: "ambiguous", reason: "registry_committee_identity_conflict" });
  });

  it("does not reread external registry accessors during subsequent gift lookups", () => {
    let reads = 0;
    const row = { get committeeId() { reads += 1; return BANC.committeeId; },
      get legalName() { reads += 1; return BANC.legalName; },
      get committeeType() { reads += 1; return BANC.committeeType; },
      get status() { reads += 1; return BANC.status; } };
    const lookup = createIllinoisSbeLegalCommitteeDonorMatcher([row]); const initializationReads = reads;
    for (let index = 0; index < 1000; index += 1) {
      expect(lookup({ donorName: "COMMUNITY-BANCPAC" })).toMatchObject({ status: "matched", committeeId: "1028" });
    }
    expect(reads).toBe(initializationReads); expect(initializationReads).toBeGreaterThan(0);
  });
});
