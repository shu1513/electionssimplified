import { describe, expect, it } from "vitest";
import {
  fingerprintFloridaCommitteeDonorRegistrations,
  FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY,
  resolveFloridaCommitteeDonorIdentity,
  type FloridaCommitteeDonorRegistration,
} from "../../../src/pipeline/floridaFinance/floridaCommitteeDonorIdentity.js";

const url = (id: string) => "https://dos.elections.myflorida.com/committees/ComDetail.asp?account=" + id;
const evidence = (date: string) => ({
  effectiveDate: date,
  sourceUrl: "https://dos.elections.myflorida.com/campaign-docs/PDFHandler.ashx?AcctType=07/30/13&TrackNum=100206658",
  sha256: "a".repeat(64),
});
function row(overrides: Partial<FloridaCommitteeDonorRegistration> = {}): FloridaCommitteeDonorRegistration {
  return {
    committeeId: "60813", committeeName: "Florida Home Builders PAC", committeeType: "PAC",
    status: "Active", address: "1319 Thomaswood Drive", cityStateZip: "Tallahassee, FL 32308",
    sourceUrl: url("60813"), registration: evidence("2013-08-13"), disbandment: null,
    ...overrides,
  };
}
function input(rows: readonly FloridaCommitteeDonorRegistration[] = [row()]) {
  const fp = fingerprintFloridaCommitteeDonorRegistrations(rows);
  return {
    reportedName: "FLORIDA HOME BUILDERS PAC", reportedAddress: "1319 THOMASWOOD DR",
    reportedCityStateZip: "TALLAHASSEE, FL 32308", transactionDate: "2026-05-14",
    registrations: rows, queryProof: {
      prefixes: ["Florida Home Builders", "Florida Home Builders PAC"],
      fingerprintBefore: fp, fingerprintAfter: fp,
    },
  };
}
const old = () => row({
  committeeId: "1997", committeeType: "CCE", status: "Closed", sourceUrl: url("1997"),
  address: "201 East Park Ave", cityStateZip: "Tallahassee, FL 32301",
  registration: null, disbandment: evidence("2013-08-31"),
});
describe("Florida source-qualified committee donor identity", () => {
  it("resolves the dated Home Builders collision using effective Aug31 and exact full address", () => {
    const result = resolveFloridaCommitteeDonorIdentity(input([old(), row()]));
    expect(result.identity).toEqual({
      committeeId: "60813", committeeName: "Florida Home Builders PAC", committeeType: "PAC",
      sourceUrl: url("60813"), includedInCommitteeDonorScope: true, resolution: "dated_exact_address",
    });
  });
  it("uses reviewed closedBy/activeBy bounds for a later same-name receipt without inventing effective dates", () => {
    const historical = old();
    historical.disbandment = { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, closedBy: "2013-08-01" };
    const current = row({ registration: { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, activeBy: "2013-08-01" } });
    expect(resolveFloridaCommitteeDonorIdentity(input([historical, current])).identity?.committeeId).toBe("60813");
    expect(historical.disbandment).not.toHaveProperty("effectiveDate");
    expect(current.registration).not.toHaveProperty("effectiveDate");
    for (const transactionDate of ["2013-07-31", "2013-08-01"]) {
      expect(resolveFloridaCommitteeDonorIdentity({ ...input([historical, current]), transactionDate }).status).toBe("unresolved");
    }
  });
  it("accepts activeBy day but keeps earlier unique Active receipts uncertain", () => {
    const r = row({ registration: { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, activeBy: "2013-08-01" } });
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([r]), transactionDate: "2013-08-01" }).status).toBe("resolved");
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([r]), transactionDate: "2013-07-31" }).status).toBe("unresolved");
  });
  it("does not exclude a competing future activeBy account as if its registration began on that day", () => {
    const uncertain = row({ committeeId: "77777", sourceUrl: url("77777"),
      registration: { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, activeBy: "2027-01-01" } });
    expect(resolveFloridaCommitteeDonorIdentity(input([row(), uncertain])).status).toBe("unresolved");
  });
  it("does not establish past activity of a Closed account from closedBy alone", () => {
    const r = old(); r.registration = evidence("2010-01-01");
    r.disbandment = { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, closedBy: "2013-08-01" };
    for (const transactionDate of ["2012-05-14", "2013-08-01", "2013-08-02"]) {
      expect(resolveFloridaCommitteeDonorIdentity({ ...input([r]), transactionDate }).status).toBe("unresolved");
    }
  });
  it.each([
    { registration: { ...evidence("2013-08-01"), activeBy: "2013-08-01" } },
    { registration: { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, closedBy: "2013-08-01" } },
    { disbandment: { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, activeBy: "2013-08-01" } },
    { registration: { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, activeBy: "2013-02-30" } },
    { registration: evidence("2014-01-01"), disbandment: { sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256, closedBy: "2013-08-01" } },
  ])("preserves invalid, mixed, wrong-kind or contradictory temporal bounds %#", change => {
    const invalid = row(change as unknown as Partial<FloridaCommitteeDonorRegistration>);
    expect(resolveFloridaCommitteeDonorIdentity(input([invalid])).status).toBe("unresolved");
  });
  it("binds the observed full postdirectional street while preserving suite and source fingerprints", () => {
    const current = row({ address: "1301 Pennsylvania Avenue NW Suite 200",
      cityStateZip: "Washington, DC 20004" });
    const rows = [old(), current], fp = fingerprintFloridaCommitteeDonorRegistrations(rows);
    const result = resolveFloridaCommitteeDonorIdentity({ ...input(rows),
      reportedAddress: "1301 PENNSYLVANIA AVENUE NORTHWEST SUITE 200",
      reportedCityStateZip: "WASHINGTON, DC 20004" });
    expect(result.identity?.committeeId).toBe("60813");
    expect(fingerprintFloridaCommitteeDonorRegistrations(rows)).toBe(fp);
    expect(current.address).toBe("1301 Pennsylvania Avenue NW Suite 200");
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([old(), row({address:"1301 Pennsylvania Avenue NW"})]),
      reportedAddress:"1301 PENNSYLVANIA AVENUE NORTHWEST" }).status).toBe("resolved");
  });
  it.each([
    { reportedAddress: "1301 Pennsylvania Avenue NORTHWEST Suite 201" },
    { reportedAddress: "1302 Pennsylvania Avenue NORTHWEST Suite 200" },
    { reportedAddress: "1301 Pennsylvania Avenue NORTHWEST Suite 200." },
    { reportedAddress: "1301 Pennsylvania Avenue NORTHWEST,, Suite 200" },
    { reportedAddress: "1301 Pennsylvania Avenue NORTHWEST Apt 200" },
    { reportedAddress: "1301 Pennsylvania Avenue NORTHEAST Suite 200" },
    { reportedCityStateZip: "Washington DC 20004" },
    { reportedCityStateZip: "Washington, DC 20005" },
  ])("preserves changed full street/unit/locality or unsupported directional syntax %#", change => {
    const current = row({address:"1301 Pennsylvania Avenue NW Suite 200",cityStateZip:"Washington, DC 20004"});
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([old(),current]),
      reportedAddress:"1301 Pennsylvania Avenue NORTHWEST Suite 200",
      reportedCityStateZip:"Washington, DC 20004", ...change }).status).toBe("unresolved");
  });
  it("does not normalize directional words inside street names or different suffixes", () => {
    for (const [registered, reported] of [
      ["1301 NW Avenue Suite 200", "1301 NORTHWEST Avenue Suite 200"],
      ["1301 Pennsylvania Street NW Suite 200", "1301 Pennsylvania Street NORTHWEST Suite 200"],
    ]) {
      expect(resolveFloridaCommitteeDonorIdentity({ ...input([old(),row({address:registered})]),
        reportedAddress:reported }).status).toBe("unresolved");
    }
  });
  it("retains unknown before effective dissolution, even though the old account is Closed now", () => {
    const r = input([old(), row()]);
    r.transactionDate = "2013-08-20";
    expect(resolveFloridaCommitteeDonorIdentity(r).status).toBe("unresolved");
  });
  it("accepts effective dissolution day only when a separately registered account and address bind", () => {
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([old(), row()]), transactionDate: "2013-08-31" }).identity?.committeeId).toBe("60813");
  });
  it("does not use today's Closed status instead of explicit historical effective date", () => {
    expect(resolveFloridaCommitteeDonorIdentity(input([old(), row({ disbandment: null })].map(r =>
      r.committeeId === "1997" ? { ...r, disbandment: null } : r))).status).toBe("unresolved");
  });
  it.each([
    { reportedAddress: "1319 Thomaswood Dr." },
    { reportedAddress: "1320 Thomaswood DR" },
    { reportedAddress: "1319 Thomaswood Drive Suite 2" },
    { reportedCityStateZip: "Tallahassee FL 32308" },
    { reportedCityStateZip: "Tallahassee, FL 32301" },
  ])("does not strip punctuation, street/unit, or location differences %#", change => {
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([old(), row()]), ...change }).status).toBe("unresolved");
  });
  it("does not discard a competing account with unknown lifetime just because address differs", () => {
    expect(resolveFloridaCommitteeDonorIdentity(input([old(), row(), row({
      committeeId: "77777", sourceUrl: url("77777"), registration: null, address: "Different Address",
    })])).status).toBe("unresolved");
  });
  it("preserves unique closed or disbanded accounts rather than interpreting them as no gift", () => {
    expect(resolveFloridaCommitteeDonorIdentity(input([old()])).status).toBe("unresolved");
    expect(resolveFloridaCommitteeDonorIdentity(input([row({ disbandment: evidence("2026-01-01") })])).status).toBe("unresolved");
  });
  it("does not retroactively reject a historical Closed committee's proven active lifetime", () => {
    const r = old(); r.registration = evidence("2010-01-01");
    const result = resolveFloridaCommitteeDonorIdentity({ ...input([r]), transactionDate: "2012-05-14" });
    expect(result.identity?.committeeType).toBe("CCE");
    expect(result.identity?.includedInCommitteeDonorScope).toBe(true);
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([r]), transactionDate: "2013-08-31" }).status).toBe("unresolved");
  });
  it("does not accept a receipt before the known registration date", () => {
    expect(resolveFloridaCommitteeDonorIdentity({ ...input(), transactionDate: "2013-08-12" }).status).toBe("unresolved");
  });
  it("collapses only full identical legal rows, keeping source multiplicity in the fingerprint", () => {
    const r = row();
    expect(fingerprintFloridaCommitteeDonorRegistrations([r, r])).not.toBe(fingerprintFloridaCommitteeDonorRegistrations([r]));
    expect(resolveFloridaCommitteeDonorIdentity(input([r, { ...r }])).identity?.committeeId).toBe("60813");
  });
  it.each([
    { committeeType: "CCE" }, { status: "Closed" }, { address: "Changed Address" },
    { rawFields: { unknownFutureField: "changed" } },
  ])("preserves contradictory same-ID metadata before any class filtering %#", change => {
    expect(resolveFloridaCommitteeDonorIdentity(input([row(), row(change)])).status).toBe("unresolved");
  });
  it.each(["PAC", "CCE", "PTY", "PAP"])("retains eligible committee class %s without relabeling", committeeType => {
    const result = resolveFloridaCommitteeDonorIdentity(input([row({ committeeType })]));
    expect(result.identity?.committeeType).toBe(committeeType);
    expect(result.identity?.includedInCommitteeDonorScope).toBe(true);
  });
  it.each(["ECO", "ECI", "IXO", "CAN", "FUTURE"])("retains distinct nonpromoted class %s", committeeType => {
    const result = resolveFloridaCommitteeDonorIdentity(input([row({ committeeType })]));
    expect(result.identity?.committeeType).toBe(committeeType);
    expect(result.identity?.includedInCommitteeDonorScope).toBe(false);
  });
  it("excludes receiving-account self without guessing ownership from names", () => {
    expect(resolveFloridaCommitteeDonorIdentity({ ...input(), receivingCommitteeId: "60813" }).identity?.includedInCommitteeDonorScope).toBe(false);
  });
  it("keeps PC refund alias unresolved rather than expanding it to Political Committee", () => {
    const r = row({ committeeId: "60984", committeeName: "Florida Insurance Council (FIC) Political Committee", sourceUrl: url("60984") });
    const i = input([r]);
    i.reportedName = "Florida Insurance Council (FIC) PC";
    i.queryProof.prefixes = ["Florida Insurance Council", "Florida Insurance Council (FIC)"];
    const result = resolveFloridaCommitteeDonorIdentity(i);
    expect(result.status).toBe("not_found");
    expect(result.identity).toBeUndefined();
  });
  it("does not normalize donor punctuation, accents or token order", () => {
    for (const name of ["Florida Home-Builders PAC", "Home Builders Florida PAC", "Flórida Home Builders PAC"]) {
      const i = input(); i.reportedName = name;
      i.queryProof.prefixes = [name.slice(0, 3), name.slice(0, 5)];
      expect(resolveFloridaCommitteeDonorIdentity(i).status).toBe("not_found");
    }
  });
  it("preserves missing or changed query closure and requires fingerprints bind every source row", () => {
    const i = input();
    expect(resolveFloridaCommitteeDonorIdentity({ ...i, queryProof: undefined }).status).toBe("unresolved");
    expect(resolveFloridaCommitteeDonorIdentity({ ...i, queryProof: { ...i.queryProof, fingerprintAfter: "b".repeat(64) } }).status).toBe("unresolved");
    expect(resolveFloridaCommitteeDonorIdentity({ ...i, registrations: [...i.registrations, old()] }).status).toBe("unresolved");
  });
  it("fingerprints whole raw registry identities and permits source row reordering", () => {
    expect(fingerprintFloridaCommitteeDonorRegistrations([old(), row()])).toBe(fingerprintFloridaCommitteeDonorRegistrations([row(), old()]));
    expect(fingerprintFloridaCommitteeDonorRegistrations([row({ rawFields: { x: 1 } })])).not.toBe(fingerprintFloridaCommitteeDonorRegistrations([row({ rawFields: { x: 2 } })]));
  });
  it.each([
    { transactionDate: "2026-02-30" },
    { transactionDate: "05/14/2026" },
    { registrations: [row({ registration: evidence("2013-02-30") })] },
    { registrations: [row({ sourceUrl: url("1997") })] },
    { registrations: [row({ registration: { ...evidence("2013-08-13"), sourceUrl: "https://example.com/proof" } })] },
  ])("preserves invalid dates/source identity %#", change => {
    expect(resolveFloridaCommitteeDonorIdentity({ ...input(), ...change }).status).toBe("unresolved");
  });
});

describe("distinct source-fixed CCE certification revocation", () => {
  const authority = FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY;
  const historical = () => oldWithAuthority();
  function oldWithAuthority(): FloridaCommitteeDonorRegistration {
    return { ...old(), registration: null, disbandment: null, certificationRevocation: authority };
  }
  const current = () => row({ registration: { activeBy: "2010-01-01",
    sourceUrl: evidence("").sourceUrl, sha256: evidence("").sha256 } });
  it("excludes only the Closed CCE certification after the bound without inventing closure dates", () => {
    const h = historical(), rows = [h, current()], fp = fingerprintFloridaCommitteeDonorRegistrations(rows);
    const resolved = resolveFloridaCommitteeDonorIdentity(input(rows));
    expect(resolved.identity).toMatchObject({ committeeId: "60813", resolution: "dated_exact_address" });
    expect(h.registration).toBeNull(); expect(h.disbandment).toBeNull();
    expect(h.certificationRevocation).not.toHaveProperty("closedBy");
    expect(fingerprintFloridaCommitteeDonorRegistrations(rows)).toBe(fp);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Reflect.set(authority, "revokedOn", "2013-08-01")).toBe(false);
  });
  it.each(["2013-09-29", "2013-09-30"])("does not resolve the transition/historical collision on %s", transactionDate => {
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([historical(), current()]), transactionDate }).status)
      .toBe("unresolved");
  });
  it("uses the strictly-after boundary, not inclusive closure-date semantics", () => {
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([historical(), current()]), transactionDate: "2013-10-01" })
      .identity?.committeeId).toBe("60813");
  });
  it.each(["PAC", "PTY", "PAP", "ECO", "ECI", "IXO", "FUTURE"])("never applies revocation to %s", committeeType => {
    expect(resolveFloridaCommitteeDonorIdentity(input([{ ...historical(), committeeType }, current()])).status)
      .toBe("unresolved");
  });
  it.each(["Active", "Unknown", ""])("never applies revocation to CCE status %s", status => {
    expect(resolveFloridaCommitteeDonorIdentity(input([{ ...historical(), status }, current()])).status)
      .toBe("unresolved");
  });
  it.each([
    { revokedOn: "2013-09-29" }, { section: "2(4)" }, { sha256: "a".repeat(64) },
    { sourceUrl: authority.sourceUrl + "?version=old" },
    { sourceUrl: "https://www.flsenate.gov/Session/Bill/2013/569/BillText/e2/PDF" },
    { sourceUrl: "https://example.com/law.pdf" }, { closedBy: "2013-09-30" },
  ])("preserves changed or mixed law authority %#", change => {
    const h = { ...historical(), certificationRevocation: { ...authority, ...change } };
    expect(resolveFloridaCommitteeDonorIdentity(input([h as FloridaCommitteeDonorRegistration, current()])).status)
      .toBe("unresolved");
  });
  it("still requires competing PAC registration, full address, locality and uniqueness", () => {
    for (const r of [row({ registration: null }), current()]) {
      const i = input([historical(), r]);
      if (r.registration) i.reportedAddress = "Changed Street";
      expect(resolveFloridaCommitteeDonorIdentity(i).status).toBe("unresolved");
    }
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([historical(), current()]), reportedCityStateZip: "Wrong Town, FL 32308" }).status)
      .toBe("unresolved");
    const third = row({ committeeId: "77777", sourceUrl: url("77777"), registration: current().registration });
    expect(resolveFloridaCommitteeDonorIdentity(input([historical(), current(), third])).status).toBe("unresolved");
    expect(resolveFloridaCommitteeDonorIdentity(input([{ ...historical(), certificationRevocation: undefined }, current()])).status)
      .toBe("unresolved");
  });
});

describe("observed terminal suite delimiter", () => {
  const current = () => row({ address: "100 Full Street SUITE 200" });
  it("binds exact comma/no-comma suite forms and retains full source fingerprints", () => {
    const rows = [old(), current()], fp = fingerprintFloridaCommitteeDonorRegistrations(rows);
    expect(resolveFloridaCommitteeDonorIdentity({ ...input(rows), reportedAddress: "100 FULL STREET, SUITE 200" })
      .identity?.committeeId).toBe("60813");
    expect(resolveFloridaCommitteeDonorIdentity({ ...input([old(), row({ address: "100 Full Street, SUITE 200" })]),
      reportedAddress: "100 FULL STREET SUITE 200" }).identity?.committeeId).toBe("60813");
    expect(fingerprintFloridaCommitteeDonorRegistrations(rows)).toBe(fp);
    expect(rows[1]!.address).toBe("100 Full Street SUITE 200");
  });
  it.each(["100 FULL STREET, SUITE 201", "100 FULL STREET, SUITE", "100 FULL STREET",
    "100 FULL STREET, UNIT 200", "100 FULL STREET, SUITE 200 EXTRA", "100 FULL, STREET SUITE 200",
    "100 FULL STREET; SUITE 200", "100 FULL STREET,, SUITE 200", "100 FULL STREET SUITE 20-0"])(
    "preserves changed or unsupported full street/unit %s", reportedAddress => {
      expect(resolveFloridaCommitteeDonorIdentity({ ...input([old(), current()]), reportedAddress }).status)
        .toBe("unresolved");
    });
  it("does not change locality or legal-name punctuation to pass suite binding", () => {
    const i = { ...input([old(), current()]), reportedAddress: "100 FULL STREET, SUITE 200" };
    expect(resolveFloridaCommitteeDonorIdentity({ ...i, reportedCityStateZip: "Wrong City, FL 32308" }).status)
      .toBe("unresolved");
    expect(resolveFloridaCommitteeDonorIdentity({ ...i, reportedName: "Florida Home-Builders PAC" }).status)
      .toBe("unresolved");
  });
});
