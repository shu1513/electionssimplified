import { describe, expect, it } from "vitest";
import {
  matchesAlaskaReportedPac,
  parseAlaskaHouseRoster,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedSource.js";
const registration = {
  Name: "Synthetic Committee",
  Type: "PAC",
  Address: "100 Example Way",
  City: "Example City",
  State: "AK",
  Zip: "99999",
  Submitted: "1/1/2026 10:00:00 AM",
};
const input = {
  name: registration.Name,
  address: "Synthetic Committee 100 Example Way Example City AK 99999",
  date: "2026-02-01",
  payment: "Check",
  registry: [registration],
  entities: [],
};
describe("Alaska source-backed PAC-name evidence", () => {
  it("requires exact name, full postal evidence and a registration before gift day", () => {
    expect(matchesAlaskaReportedPac(input)).toBe(true);
    for (const patch of [
      { name: "Synthetic Committee PAC" },
      { address: "100 Example Way" },
      { date: "2026-01-01" },
      { date: "2025-12-31" },
    ])
      expect(matchesAlaskaReportedPac({ ...input, ...patch })).toBe(false);
  });
  it("excludes parties, non-group entities, ambiguous classes and name-only heuristics", () => {
    expect(matchesAlaskaReportedPac({ ...input, registry: [] })).toBe(false);
    expect(
      matchesAlaskaReportedPac({
        ...input,
        registry: [{ ...registration, Type: "Political Party" }],
      }),
    ).toBe(false);
    expect(
      matchesAlaskaReportedPac({
        ...input,
        registry: [registration, { ...registration, Type: "IE" }],
      }),
    ).toBe(false);
    expect(
      matchesAlaskaReportedPac({
        ...input,
        entities: [{ Name: registration.Name }],
      }),
    ).toBe(false);
  });
  it("holds a matched PAC loan, without treating ordinary check details as donor class", () => {
    expect(() =>
      matchesAlaskaReportedPac({ ...input, payment: "Check loan repayment" }),
    ).toThrow(/ambiguous_pac_loan/);
    expect(
      matchesAlaskaReportedPac({
        ...input,
        payment: "Check 12345 Example gift",
      }),
    ).toBe(true);
    expect(() =>
      matchesAlaskaReportedPac({
        ...input,
        registry: [{ ...registration, Submitted: "2/30/2026" }],
      }),
    ).toThrow(/date_value/);
  });
  it("never treats missing roster originals as an empty election", () => {
    expect(() => parseAlaskaHouseRoster([], 2026)).toThrow(
      /official_roster_unavailable/,
    );
  });
});
