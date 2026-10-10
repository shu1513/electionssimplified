import { describe, expect, it } from "vitest";

import {
  normalizePennsylvaniaCandidateNameKeys,
  resolvePennsylvaniaCandidateCommittee,
} from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaCandidateCommitteeResolver.js";
import type { PennsylvaniaCampaignFinanceFilerRow } from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaCampaignFinanceReader.js";

function filerRow(overrides: Partial<PennsylvaniaCampaignFinanceFilerRow> = {}): PennsylvaniaCampaignFinanceFilerRow {
  return {
    CampaignfinanceID: "100",
    FILERID: "12345",
    EYEAR: "2026",
    SubmittedDate: "20260501",
    CYCLE: "2",
    AMMEND: "",
    TERMINATE: "",
    FILERTYPE: "1",
    FILERNAME: "JANE DOE FOR GOVERNOR",
    OFFICE: "GOV",
    DISTRICT: "",
    PARTY: "DEM",
    ADDRESS1: "",
    ADDRESS2: "",
    CITY: "",
    STATE: "PA",
    ZIPCODE: "",
    COUNTY: "",
    PHONE: "",
    BEGINNING: "",
    MONETARY: "",
    INKIND: "",
    ...overrides,
  };
}

describe("pennsylvaniaCandidateCommitteeResolver", () => {
  it("normalizes direct and comma-form candidate names without broad fuzzy matching", () => {
    expect([...normalizePennsylvaniaCandidateNameKeys("DOE, Jane E.")]).toEqual([
      "DOE JANE E",
      "JANE E DOE",
      "JANE DOE",
    ]);
    expect([...normalizePennsylvaniaCandidateNameKeys("Jane E. Doe")]).toEqual(["JANE E DOE", "JANE DOE"]);
  });

  it("rejects a same-race filer whose middle name contradicts the candidate", () => {
    // Same office and year — only the middle evidence differs. Without the
    // middle gate this filer linked as an "exact" match and attached the other
    // John Smith's finance records.
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "55555", FILERNAME: "SMITH, JOHN B." })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_filer_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "55555", FILERNAME: "SMITH, JOHN ANDREW" })],
      })
    ).toMatchObject({ status: "matched", filerId: "55555" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "John Smith",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "55555", FILERNAME: "SMITH, JOHN B." })],
      })
    ).toMatchObject({ status: "matched", filerId: "55555" });
  });

  it("treats a bare V as a middle initial, not a generational suffix", () => {
    // Bare "V" is a middle initial, not a suffix (the shared
    // GENERATIONAL_SUFFIX_RANK policy deliberately excludes it), so it must
    // stay as middle evidence on either side instead of being stripped.
    const resolve = (candidateName: string, filerName: string) =>
      resolvePennsylvaniaCandidateCommittee({
        candidateName,
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "55555", FILERNAME: filerName })],
      });
    expect(resolve("John V. Smith", "SMITH, JOHN B.")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_filer_match",
    });
    expect(resolve("John B. Smith", "SMITH, JOHN V")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_filer_match",
    });
    expect(resolve("John V. Smith", "SMITH, JOHN V")).toMatchObject({ status: "matched", filerId: "55555" });
    expect(resolve("John Smith", "SMITH, JOHN V")).toMatchObject({ status: "matched", filerId: "55555" });
  });

  it("leaves the committee-name match path untouched", () => {
    // "FRIENDS OF ..." matches on the committee key, which never aligns on
    // first+last, so the middle gate has no evidence and cannot veto it.
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "55555", FILERNAME: "FRIENDS OF JOHN SMITH" })],
      })
    ).toMatchObject({ status: "matched", filerId: "55555" });
  });

  it("matches exactly one Pennsylvania candidate filer by office and filer name", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        sourceUrl: "https://www.pa.gov/example/2026.zip",
        filerRows: [
          filerRow(),
          filerRow({
            FILERID: "99999",
            FILERNAME: "OTHER PERSON FOR GOVERNOR",
          }),
          filerRow({
            FILERID: "77777",
            FILERNAME: "PENNSYLVANIA ACTION PAC",
          }),
        ],
      })
    ).toEqual({
      status: "matched",
      filerId: "12345",
      filerName: "JANE DOE FOR GOVERNOR",
      filerType: "1",
      confidence: "exact",
      source: "pa_bulk",
      sourceUrl: "https://www.pa.gov/example/2026.zip",
      matchedFilerRowCount: 1,
    });
  });

  it("matches common PA committee wrappers conservatively", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Pat Harkins",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "1",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "22222",
            FILERNAME: "FRIENDS OF PAT HARKINS C/O SUSAN M KOWALSKI TREASURER",
            OFFICE: "STH",
            DISTRICT: "1",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "22222",
      filerName: "FRIENDS OF PAT HARKINS C/O SUSAN M KOWALSKI TREASURER",
    });
  });

  it("requires valid districts for legislative offices before matching", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Pat Harkins",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "22222",
            FILERNAME: "FRIENDS OF PAT HARKINS",
            OFFICE: "STH",
            DISTRICT: "1",
          }),
        ],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized: "PAT HARKINS",
      officeNameNormalized: "STATE LOWER CHAMBER LEGISLATOR",
    });
  });

  it("skips same-name legislative filers from other districts", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Pat Harkins",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "1",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "22222",
            FILERNAME: "FRIENDS OF PAT HARKINS",
            OFFICE: "STH",
            DISTRICT: "2",
          }),
        ],
      })
    ).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_filer_match",
    });
  });

  it("rejects unsupported offices without trying to infer from filer names", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "local",
        officeName: "Mayor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERNAME: "JANE DOE FOR MAYOR" })],
      })
    ).toEqual({
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "MAYOR",
    });
  });

  it("resolves the sole committee filer over the candidate's own registration filer", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Abigail Salisbury",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "34",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0465",
            FILERNAME: "SALISBURY, ABIGAIL MARIE",
            FILERTYPE: "1",
            OFFICE: "STH",
            DISTRICT: "34",
          }),
          filerRow({
            FILERID: "20220025",
            FILERNAME: "PEOPLE FOR ABIGAIL SALISBURY",
            FILERTYPE: "2",
            OFFICE: "STH",
            DISTRICT: "34",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "20220025",
      filerName: "PEOPLE FOR ABIGAIL SALISBURY",
      filerType: "2",
    });
  });

  it("resolves the sole committee filer even against two candidate registration filers", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0001", FILERNAME: "DOE, JANE", FILERTYPE: "1" }),
          filerRow({ FILERID: "2026C0900", FILERNAME: "DOE, JANE E", FILERTYPE: "1" }),
          filerRow({ FILERID: "20240100", FILERNAME: "FRIENDS OF JANE DOE", FILERTYPE: "2" }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "20240100",
      filerType: "2",
    });
  });

  it("recalls a blank-OFFICE committee corroborated by the registration row's ZIP", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Aaron Bernstine",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "8",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0279",
            FILERNAME: "AARON BERNSTINE",
            FILERTYPE: "1",
            OFFICE: "STH",
            DISTRICT: "8",
            ZIPCODE: "16141",
            PHONE: "4129773127",
          }),
          filerRow({
            FILERID: "20150221",
            FILERNAME: "FRIENDS OF AARON BERNSTINE",
            FILERTYPE: "2",
            OFFICE: "",
            DISTRICT: "",
            ZIPCODE: "16141",
            PHONE: "",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "20150221",
      filerType: "2",
    });
  });

  it("recalls a blank-OFFICE committee corroborated by the registration row's phone", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Marla Brown",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "9",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0832",
            FILERNAME: "MARLA BROWN",
            FILERTYPE: "1",
            OFFICE: "STH",
            DISTRICT: "9",
            ZIPCODE: "16102",
            PHONE: "7247300256",
          }),
          filerRow({
            FILERID: "20220071",
            FILERNAME: "MARLA BROWN FOR PA",
            FILERTYPE: "2",
            OFFICE: "",
            DISTRICT: "",
            ZIPCODE: "99999",
            PHONE: "724-730-0256",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "20220071",
      filerType: "2",
    });
  });

  it("recalls a same-office committee with a blank DISTRICT when the ZIP corroborates", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Rosemary Brown",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "40",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0183",
            FILERNAME: "ROSEMARY BROWN",
            FILERTYPE: "1",
            OFFICE: "STS",
            DISTRICT: "40",
            ZIPCODE: "18372",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            OFFICE: "STS",
            DISTRICT: "",
            ZIPCODE: "18372-0000",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2010237",
      filerType: "2",
    });
  });

  it("never recalls a committee naming a different office, even with a shared ZIP", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Rosemary Brown",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "40",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0183",
            FILERNAME: "ROSEMARY BROWN",
            FILERTYPE: "1",
            OFFICE: "STS",
            DISTRICT: "40",
            ZIPCODE: "18372",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            OFFICE: "STH",
            DISTRICT: "",
            ZIPCODE: "18372",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2026C0183",
      filerType: "1",
    });
  });

  it("never recalls a same-office committee that carries its own district", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Rosemary Brown",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "40",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0183",
            FILERNAME: "ROSEMARY BROWN",
            FILERTYPE: "1",
            OFFICE: "STS",
            DISTRICT: "40",
            ZIPCODE: "18372",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            OFFICE: "STS",
            DISTRICT: "12",
            ZIPCODE: "18372",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2026C0183",
      filerType: "1",
    });
  });

  it("vetoes recall when a sibling row of the same filer carries a conflicting district", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Rosemary Brown",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "40",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0183",
            FILERNAME: "ROSEMARY BROWN",
            FILERTYPE: "1",
            OFFICE: "STS",
            DISTRICT: "40",
            ZIPCODE: "18372",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            OFFICE: "STS",
            DISTRICT: "",
            ZIPCODE: "18372",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            OFFICE: "STS",
            DISTRICT: "12",
            ZIPCODE: "18372",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2026C0183",
      filerType: "1",
    });
  });

  it("does not let a corroborating sibling district veto the recall", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Aaron Bernstine",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "8",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0279",
            FILERNAME: "AARON BERNSTINE",
            FILERTYPE: "1",
            OFFICE: "STH",
            DISTRICT: "8",
            ZIPCODE: "16141",
          }),
          filerRow({
            FILERID: "20150221",
            FILERNAME: "FRIENDS OF AARON BERNSTINE",
            FILERTYPE: "2",
            OFFICE: "",
            DISTRICT: "",
            ZIPCODE: "16141",
          }),
          filerRow({
            FILERID: "20150221",
            FILERNAME: "FRIENDS OF AARON BERNSTINE",
            FILERTYPE: "2",
            OFFICE: "STH",
            DISTRICT: "08",
            ZIPCODE: "16141",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "20150221",
      filerType: "2",
    });
  });

  it("ignores a conflicting sibling district from another election year", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Rosemary Brown",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "40",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0183",
            FILERNAME: "ROSEMARY BROWN",
            FILERTYPE: "1",
            OFFICE: "STS",
            DISTRICT: "40",
            ZIPCODE: "18372",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            OFFICE: "STS",
            DISTRICT: "",
            ZIPCODE: "18372",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            EYEAR: "2022",
            OFFICE: "STH",
            DISTRICT: "189",
            ZIPCODE: "18372",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2010237",
      filerType: "2",
    });
  });

  it("recalls a same-office blank-district committee carrying the full name without corroboration", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Rosemary Brown",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "40",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0183",
            FILERNAME: "ROSEMARY BROWN",
            FILERTYPE: "1",
            OFFICE: "STS",
            DISTRICT: "40",
            ZIPCODE: "18372",
            PHONE: "5705551234",
          }),
          filerRow({
            FILERID: "2010237",
            FILERNAME: "FRIENDS OF ROSEMARY BROWN",
            FILERTYPE: "2",
            OFFICE: "STS",
            DISTRICT: "",
            ZIPCODE: "17108",
            PHONE: "7175559999",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2010237",
      filerType: "2",
    });
  });

  it("rejects a recalled committee whose DISTRICT conflicts with the registration", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Aaron Bernstine",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "8",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0279",
            FILERNAME: "AARON BERNSTINE",
            FILERTYPE: "1",
            OFFICE: "STH",
            DISTRICT: "8",
            ZIPCODE: "16141",
          }),
          filerRow({
            FILERID: "20150221",
            FILERNAME: "FRIENDS OF AARON BERNSTINE",
            FILERTYPE: "2",
            OFFICE: "",
            DISTRICT: "9",
            ZIPCODE: "16141",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2026C0279",
      filerType: "1",
    });
  });

  it("admits a recalled committee whose padded DISTRICT normalizes to the registration's", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Aaron Bernstine",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "8",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0279",
            FILERNAME: "AARON BERNSTINE",
            FILERTYPE: "1",
            OFFICE: "STH",
            DISTRICT: "8",
            ZIPCODE: "16141",
          }),
          filerRow({
            FILERID: "20150221",
            FILERNAME: "FRIENDS OF AARON BERNSTINE",
            FILERTYPE: "2",
            OFFICE: "",
            DISTRICT: "08",
            ZIPCODE: "16141",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "20150221",
      filerType: "2",
    });
  });

  it("rejects a district-bearing recalled committee for a statewide race", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0001",
            FILERNAME: "DOE, JANE",
            FILERTYPE: "1",
            OFFICE: "GOV",
            ZIPCODE: "15001",
          }),
          filerRow({
            FILERID: "20240500",
            FILERNAME: "FRIENDS OF JANE DOE",
            FILERTYPE: "2",
            OFFICE: "",
            DISTRICT: "12",
            ZIPCODE: "15001",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2026C0001",
      filerType: "1",
    });
  });

  it("recalls a blank-OFFICE committee carrying the full name when no same-name stranger registered", () => {
    // Live: "FRIENDS OF CAMERA BARTOLOTTA" files from Harrisburg (17108)
    // while the senator's registration carries her home ZIP; neither ZIP
    // nor phone corroborates, and the link sat on the $0 registration.
    const rows = [
      filerRow({
        FILERID: "2026C0001",
        FILERNAME: "DOE, JANE",
        FILERTYPE: "1",
        OFFICE: "GOV",
        ZIPCODE: "15001",
        PHONE: "4125550001",
      }),
      filerRow({
        FILERID: "20240500",
        FILERNAME: "FRIENDS OF JANE DOE",
        FILERTYPE: "2",
        OFFICE: "",
        ZIPCODE: "19999",
        PHONE: "2155559999",
      }),
    ];
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: rows,
      })
    ).toMatchObject({ status: "matched", filerId: "20240500", filerType: "2" });
  });

  it("keeps the registration filer when a same-name stranger registered for another race", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0001", FILERNAME: "DOE, JANE", FILERTYPE: "1", OFFICE: "GOV", ZIPCODE: "15001" }),
          filerRow({ FILERID: "2026C0777", FILERNAME: "DOE, JANE", FILERTYPE: "1", OFFICE: "STH", DISTRICT: "12", ZIPCODE: "16001" }),
          filerRow({ FILERID: "20240500", FILERNAME: "FRIENDS OF JANE DOE", FILERTYPE: "2", OFFICE: "", ZIPCODE: "19999" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "2026C0001", filerType: "1" });
  });

  it("recalls a surname-only blank-OFFICE committee only with ZIP or phone corroboration", () => {
    // Live: "GAYDOS FOR PA" shares the registration ZIP 15143.
    const registration = filerRow({
      FILERID: "2026C0690",
      FILERNAME: "VALERIE GAYDOS",
      FILERTYPE: "1",
      OFFICE: "STH",
      DISTRICT: "44",
      ZIPCODE: "15143",
    });
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Valerie Gaydos",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "44",
        electionYear: 2026,
        filerRows: [registration, filerRow({ FILERID: "20180071", FILERNAME: "GAYDOS FOR PA", FILERTYPE: "2", OFFICE: "", ZIPCODE: "15143" })],
      })
    ).toMatchObject({ status: "matched", filerId: "20180071", filerType: "2" });
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Valerie Gaydos",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "44",
        electionYear: 2026,
        filerRows: [registration, filerRow({ FILERID: "20180071", FILERNAME: "GAYDOS FOR PA", FILERTYPE: "2", OFFICE: "", ZIPCODE: "17108" })],
      })
    ).toMatchObject({ status: "matched", filerId: "2026C0690", filerType: "1" });
  });

  it("matches a registration row filed under a surname committee name", () => {
    // Live: Kerry Benninghoff's registration row is named
    // "BENNINGHOFF FOR REPRESENTATIVE" (STH 171); the committee of the same
    // name has a blank OFFICE and shares the ZIP.
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Kerry Benninghoff",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "171",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0463", FILERNAME: "BENNINGHOFF FOR REPRESENTATIVE", FILERTYPE: "1", OFFICE: "STH", DISTRICT: "171", ZIPCODE: "16823" }),
          filerRow({ FILERID: "9600102", FILERNAME: "BENNINGHOFF FOR REPRESENTATIVE", FILERTYPE: "2", OFFICE: "", ZIPCODE: "16823" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "9600102", filerType: "2" });
    // A plain person name on a registration row never matches by surname alone.
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Kerry Benninghoff",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "171",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "2026C0464", FILERNAME: "BENNINGHOFF, DANA", FILERTYPE: "1", OFFICE: "STH", DISTRICT: "171" })],
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("keys apostrophes and parenthesized surnames the way PA files them", () => {
    expect([...normalizePennsylvaniaCandidateNameKeys("La'Tasha Mayes")]).toEqual(["LATASHA MAYES"]);
    expect([...normalizePennsylvaniaCandidateNameKeys("NATALIE NICOLE STUCK (MIHALEK)")]).toContain("NATALIE MIHALEK");
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Timothy O'Neal",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "48",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "2026C0324", FILERNAME: "ONEAL, TIMOTHY JON", FILERTYPE: "1", OFFICE: "STH", DISTRICT: "48" })],
      })
    ).toMatchObject({ status: "matched", filerId: "2026C0324" });
  });

  it("never admits a committee whose OFFICE names a different race, even with a shared ZIP", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "2026C0001",
            FILERNAME: "DOE, JANE",
            FILERTYPE: "1",
            OFFICE: "GOV",
            ZIPCODE: "15001",
          }),
          filerRow({
            FILERID: "20240500",
            FILERNAME: "FRIENDS OF JANE DOE",
            FILERTYPE: "2",
            OFFICE: "STH",
            DISTRICT: "5",
            ZIPCODE: "15001",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      filerId: "2026C0001",
      filerType: "1",
    });
  });

  it("does not recall committees without an office-matched registration row", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({
            FILERID: "20240500",
            FILERNAME: "FRIENDS OF JANE DOE",
            FILERTYPE: "2",
            OFFICE: "",
            ZIPCODE: "15001",
            PHONE: "4125550001",
          }),
        ],
      })
    ).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_filer_match",
    });
  });

  it("stays ambiguous when two committee filers match", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "20240100", FILERNAME: "FRIENDS OF JANE DOE", FILERTYPE: "2" }),
          filerRow({ FILERID: "20260200", FILERNAME: "JANE DOE FOR PA", FILERTYPE: "2" }),
        ],
      })
    ).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_filers",
    });
  });

  it("does not guess when multiple candidate filers match", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow(),
          filerRow({
            FILERID: "12346",
            FILERNAME: "FRIENDS OF JANE DOE",
          }),
        ],
      })
    ).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_filers",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "GOV",
      matches: [
        {
          filerId: "12345",
          filerName: "JANE DOE FOR GOVERNOR",
          filerType: "1",
          confidence: "exact",
          source: "pa_bulk",
          sourceUrl: null,
          matchedFilerRowCount: 1,
        },
        {
          filerId: "12346",
          filerName: "FRIENDS OF JANE DOE",
          filerType: "1",
          confidence: "exact",
          source: "pa_bulk",
          sourceUrl: null,
          matchedFilerRowCount: 1,
        },
      ],
    });
  });

  it("matches a formal-name registration row through a nickname on the VoteApp side", () => {
    // Live: Josh Shapiro files as "SHAPIRO, JOSHUA D"; before nickname
    // expansion the governor stayed unlinked.
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Josh Shapiro",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "2026C0403", FILERNAME: "SHAPIRO, JOSHUA D", FILERTYPE: "1" })],
      })
    ).toMatchObject({ status: "matched", filerId: "2026C0403", filerType: "1" });
  });

  it("does not stretch a nickname to an unrelated first name", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Josh Shapiro",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "2026C0403", FILERNAME: "SHAPIRO, JOHN D", FILERTYPE: "1" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_filer_match" });
  });

  it("keeps nickname expansion off the storage key", () => {
    expect([...normalizePennsylvaniaCandidateNameKeys("Josh Shapiro", { expandNicknames: true })]).toEqual([
      "JOSH SHAPIRO",
      "JOSHUA SHAPIRO",
    ]);
    expect([...normalizePennsylvaniaCandidateNameKeys("Josh Shapiro")]).toEqual(["JOSH SHAPIRO"]);
  });

  it("admits a surname-only committee whose own row names the race, beside the registration", () => {
    // Live: "Shapiro for Pennsylvania" (OFFICE GOV) carries the money; the
    // registration row 2026C0403 reports $0. Shares no ZIP or phone.
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Josh Shapiro",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0403", FILERNAME: "SHAPIRO, JOSHUA D", FILERTYPE: "1", ZIPCODE: "19046", PHONE: "6306966485" }),
          filerRow({ FILERID: "20160016", FILERNAME: "Shapiro for Pennsylvania", FILERTYPE: "2", ZIPCODE: "19110", PHONE: "2025520221" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "20160016", filerType: "2" });
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Stacy Garrity",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0735", FILERNAME: "GARRITY, STACY LORRAINE", FILERTYPE: "1" }),
          filerRow({ FILERID: "20200025", FILERNAME: "Garrity for PA", FILERTYPE: "2", ZIPCODE: "17112" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "20200025", filerType: "2" });
  });

  it("admits no surname-only filer when a same-surname rival registered for the race", () => {
    const rows = [
      filerRow({ FILERID: "2026C0001", FILERNAME: "SMITH, JOHN", FILERTYPE: "1", PARTY: "DEM" }),
      filerRow({ FILERID: "2026C0002", FILERNAME: "SMITH, JANE", FILERTYPE: "1", PARTY: "REP" }),
      filerRow({ FILERID: "20260300", FILERNAME: "Smith for Pennsylvania", FILERTYPE: "2" }),
    ];
    for (const candidateName of ["John Smith", "Jane Smith"]) {
      const resolution = resolvePennsylvaniaCandidateCommittee({
        candidateName,
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: rows,
      });
      expect(resolution).toMatchObject({ status: "matched", filerType: "1" });
    }
    // The rival also blocks a surname-only registration row.
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Kerry Benninghoff",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "171",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0463", FILERNAME: "BENNINGHOFF FOR REPRESENTATIVE", FILERTYPE: "1", OFFICE: "STH", DISTRICT: "171" }),
          filerRow({ FILERID: "2026C0464", FILERNAME: "BENNINGHOFF, DANA", FILERTYPE: "1", OFFICE: "STH", DISTRICT: "171" }),
        ],
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("collapses one committee filed under two ids with the same name", () => {
    // Live: FRIENDS OF PAT HARKINS as 2005299 (four 2026 rows) and 8300058 (one).
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Patrick Harkins",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "1",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0772", FILERNAME: "PATRICK J. HARKINS", FILERTYPE: "1", OFFICE: "STH", DISTRICT: "1", ZIPCODE: "16588" }),
          filerRow({ FILERID: "2005299", FILERNAME: "FRIENDS OF PAT HARKINS C/O TREASURER SUSAN M. KOWALSKI", FILERTYPE: "2", OFFICE: "", ZIPCODE: "16506", SubmittedDate: "2026-05-08" }),
          filerRow({ FILERID: "2005299", FILERNAME: "FRIENDS OF PAT HARKINS % TREASURER SUSAN M. KOWALSKI", FILERTYPE: "2", OFFICE: "", ZIPCODE: "16506", SubmittedDate: "2026-09-22" }),
          filerRow({ FILERID: "8300058", FILERNAME: "FRIENDS OF PAT HARKINS % TREASURER SUSAN M. KOWALSKI", FILERTYPE: "2", OFFICE: "", ZIPCODE: "16506", SubmittedDate: "2026-04-07" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "2005299", filerType: "2" });
  });

  it("never admits a surname-only committee without the candidate's registration row", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Josh Shapiro",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [filerRow({ FILERID: "20160016", FILERNAME: "Shapiro for Pennsylvania", FILERTYPE: "2" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_filer_match" });
  });

  it("never admits a surname-only committee from a blank-OFFICE row", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Josh Shapiro",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0403", FILERNAME: "SHAPIRO, JOSHUA D", FILERTYPE: "1", ZIPCODE: "19046" }),
          filerRow({ FILERID: "20160016", FILERNAME: "Shapiro for Pennsylvania", FILERTYPE: "2", OFFICE: "", ZIPCODE: "19110" }),
        ],
      })
    ).toMatchObject({ status: "matched", filerId: "2026C0403", filerType: "1" });
  });

  it("stays ambiguous when two surname-only committees name the race", () => {
    expect(
      resolvePennsylvaniaCandidateCommittee({
        candidateName: "Josh Shapiro",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        filerRows: [
          filerRow({ FILERID: "2026C0403", FILERNAME: "SHAPIRO, JOSHUA D", FILERTYPE: "1" }),
          filerRow({ FILERID: "20160016", FILERNAME: "Shapiro for Pennsylvania", FILERTYPE: "2" }),
          filerRow({ FILERID: "20160017", FILERNAME: "Friends of Shapiro", FILERTYPE: "2" }),
        ],
      })
    ).toMatchObject({ status: "ambiguous", reason: "multiple_matching_filers" });
  });
});
