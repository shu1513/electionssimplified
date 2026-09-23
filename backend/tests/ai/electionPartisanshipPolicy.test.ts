import { describe, expect, it } from "vitest";

import {
  isJudicialOfficeTitle,
  isJudicialRetentionTitle,
  resolveCandidateContestPartisanshipByPolicy,
  resolveElectionIsPartisan,
  shouldIncludeCandidatePartyByPolicy,
  shouldAskIsPartisanInPrompt,
} from "../../src/ai/electionPartisanshipPolicy.js";

describe("electionPartisanshipPolicy", () => {
  it("never asks AI for ballot_measure family", () => {
    expect(
      shouldAskIsPartisanInPrompt({
        draft: {
          district_id: "d-1",
          district_name: "Los Angeles County, California",
          district_type: "county",
          state: "CA",
        },
        contestFamily: "ballot_measure",
      })
    ).toBe(false);
  });

  it("asks AI for mixed school states and not for fixed school states", () => {
    expect(
      shouldAskIsPartisanInPrompt({
        draft: {
          district_id: "d-1",
          district_name: "Demo Unified School District",
          district_type: "school_unified",
          state: "NC",
        },
        contestFamily: "all",
      })
    ).toBe(true);

    expect(
      shouldAskIsPartisanInPrompt({
        draft: {
          district_id: "d-1",
          district_name: "Demo Unified School District",
          district_type: "school_unified",
          state: "CA",
        },
        contestFamily: "all",
      })
    ).toBe(false);
  });

  it("never asks AI for judicial_office family", () => {
    expect(
      shouldAskIsPartisanInPrompt({
        draft: {
          district_id: "d-1",
          district_name: "Los Angeles County, California",
          district_type: "county",
          state: "CA",
        },
        contestFamily: "judicial_office",
      })
    ).toBe(false);
  });

  it("never asks AI for us_senate family and forces partisan true", () => {
    expect(
      shouldAskIsPartisanInPrompt({
        draft: {
          district_id: "d-1",
          district_name: "California",
          district_type: "statewide",
          state: "CA",
        },
        contestFamily: "us_senate",
      })
    ).toBe(false);

    const resolved = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "California",
        district_type: "statewide",
        state: "CA",
      },
      contestFamily: "us_senate",
      raceType: "office",
      officialBallotTitle: "United States Senator",
      aiValue: undefined,
    });
    expect(resolved).toBe(true);
  });

  it("forces ballot_measure to nonpartisan", () => {
    const resolved = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "California",
        district_type: "statewide",
        state: "CA",
      },
      contestFamily: "ballot_measure",
      raceType: "ballot_measure",
      officialBallotTitle: "Proposition 1",
      aiValue: true,
    });
    expect(resolved).toBe(false);
  });

  it("forces judicial contests by state policy", () => {
    const tx = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "Texas",
        district_type: "statewide",
        state: "TX",
      },
      contestFamily: "judicial_office",
      raceType: "office",
      officialBallotTitle: "Judge of the Supreme Court",
      aiValue: undefined,
    });
    expect(tx).toBe(true);

    const ca = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "California",
        district_type: "statewide",
        state: "CA",
      },
      contestFamily: "judicial_office",
      raceType: "office",
      officialBallotTitle: "Judge of the Superior Court",
      aiValue: true,
    });
    expect(ca).toBe(false);
  });

  it("uses AI value for mixed school states and leaves undefined when missing", () => {
    const fromAi = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "Demo Unified School District",
        district_type: "school_unified",
        state: "NC",
      },
      contestFamily: "all",
      raceType: "office",
      officialBallotTitle: "School Board Member",
      aiValue: true,
    });
    expect(fromAi).toBe(true);

    const missingAi = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "Demo Unified School District",
        district_type: "school_unified",
        state: "NC",
      },
      contestFamily: "all",
      raceType: "office",
      officialBallotTitle: "School Board Member",
      aiValue: undefined,
    });
    expect(missingAi).toBeUndefined();
  });

  it("supports California Court of Appeal title detection", () => {
    expect(isJudicialOfficeTitle("Justice of the Court of Appeal, District 2")).toBe(true);
  });

  it("treats judicial retention contests as nonpartisan in partisan-judicial states", () => {
    expect(isJudicialRetentionTitle("Justice of the Supreme Court (Retention)")).toBe(true);
    expect(isJudicialRetentionTitle("Water Retention District Director")).toBe(false);
    // California phrasing: no "retain" anywhere, but a Yes/No on one justice.
    expect(
      isJudicialRetentionTitle("Shall Presiding Justice THERESE M. STEWART be elected to the office for the term provided by law?")
    ).toBe(true);
    expect(isJudicialRetentionTitle("Shall DAVID B. SAPP be elected to the office for the term provided by law?")).toBe(true);

    const resolved = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "Kansas",
        district_type: "statewide",
        state: "KS",
      },
      contestFamily: "judicial_office",
      raceType: "office",
      officialBallotTitle: "Justice of the Supreme Court (Retention)",
      aiValue: true,
    });
    expect(resolved).toBe(false);
  });

  it("keeps non-retention judicial contests in partisan-judicial states as partisan", () => {
    const resolved = resolveElectionIsPartisan({
      draft: {
        district_id: "d-1",
        district_name: "Kansas",
        district_type: "statewide",
        state: "KS",
      },
      contestFamily: "judicial_office",
      raceType: "office",
      officialBallotTitle: "Judge of the District Court",
      aiValue: undefined,
    });
    expect(resolved).toBe(true);
  });

  it("keeps South Carolina probate judges partisan", () => {
    const resolved = resolveElectionIsPartisan({
      draft: {
        district_id: "d-sc",
        district_name: "Spartanburg County, South Carolina",
        district_type: "county",
        state: "SC",
      },
      contestFamily: "judicial_office",
      raceType: "office",
      officialBallotTitle: "Probate Judge",
      aiValue: false,
    });
    expect(resolved).toBe(true);
  });

  it("keeps Maine judges of probate partisan and every other Maine judge nonpartisan", () => {
    const draft = {
      district_id: "d-me",
      district_name: "Knox County, Maine",
      district_type: "county",
      state: "ME",
    };
    for (const title of [
      "Knox County Judge of Probate",
      "Judge of Probate",
      "Judge of Probate, Penobscot County",
    ]) {
      expect(
        resolveElectionIsPartisan({ draft, contestFamily: "judicial_office", raceType: "office", officialBallotTitle: title, aiValue: false })
      ).toBe(true);
    }
    expect(
      resolveElectionIsPartisan({
        draft,
        contestFamily: "judicial_office",
        raceType: "office",
        officialBallotTitle: "Justice of the Maine Superior Court",
        aiValue: true,
      })
    ).toBe(false);
  });

  it("keeps Maryland Orphans' Court judges partisan and every other Maryland bench nonpartisan", () => {
    const draft = {
      district_id: "d-md",
      district_name: "Frederick County, Maryland",
      district_type: "county",
      state: "MD",
    };
    for (const title of [
      "Judge of the Orphans' Court",
      "Judge of the Orphans’ Court, Carroll County",
      "Allegany County Judge of the Orphans Court",
    ]) {
      expect(
        resolveElectionIsPartisan({ draft, contestFamily: "judicial_office", raceType: "office", officialBallotTitle: title, aiValue: false })
      ).toBe(true);
    }
    expect(
      resolveElectionIsPartisan({
        draft,
        contestFamily: "judicial_office",
        raceType: "office",
        officialBallotTitle: "Judge of the Circuit Court, Circuit 6",
        aiValue: true,
      })
    ).toBe(false);
    expect(
      resolveElectionIsPartisan({
        draft,
        contestFamily: "judicial_office",
        raceType: "office",
        officialBallotTitle: "Judge, Appellate Court of Maryland, At Large - Retention",
        aiValue: true,
      })
    ).toBe(false);
    // The clerk of the same court is a county office, not a judgeship.
    expect(
      resolveElectionIsPartisan({
        draft,
        contestFamily: "all",
        raceType: "office",
        officialBallotTitle: "Clerk of the Circuit Court",
        aiValue: true,
      })
    ).toBe(true);
  });

  it("candidate policy helper excludes party for retention judicial contests", () => {
    const includeParty = shouldIncludeCandidatePartyByPolicy({
      districtType: "statewide",
      state: "KS",
      officialBallotTitle: "Shall Justice Jane Doe be retained in office?",
    });
    expect(includeParty).toBe(false);
  });

  it("forces Arizona Justice of the Peace contests to partisan", () => {
    // The JP is a precinct office in section one of the ballot, printed with
    // the party in bold-faced letters (A.R.S. § 16-502(C)(5)). Yuma County's
    // 2026 listing shows Precinct 2 as a REP-vs-DEM contest.
    const title = "Justice of the Peace, Precinct 1";

    expect(
      resolveElectionIsPartisan({
        draft: {
          district_id: "d-az",
          district_name: "Yuma County, Arizona",
          district_type: "county",
          state: "AZ",
        },
        contestFamily: "judicial_office",
        raceType: "office",
        officialBallotTitle: title,
        aiValue: false,
      })
    ).toBe(true);

    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "AZ",
        officialBallotTitle: title,
      })
    ).toBe(true);

    expect(
      shouldIncludeCandidatePartyByPolicy({
        districtType: "county",
        state: "AZ",
        officialBallotTitle: title,
      })
    ).toBe(true);
  });

  it("keeps elected Arizona Superior Court judges nonpartisan", () => {
    // Counties under 250,000 elect their Superior Court judges instead of
    // retaining them, and those candidates are nominated in a party primary —
    // but Ariz. Const. art. 6 § 12(A) puts their names on the general ballot
    // "without partisan or other designation except the division and title of
    // the office", and A.R.S. § 16-502(J) files them in the nonpartisan
    // section. A party column on a county candidate listing is the primary
    // nomination, not the November ballot classification.
    for (const title of [
      "Judge of Superior Court, Division 2",
      "Judge of the Superior Court, Division 5",
    ]) {
      expect(
        resolveElectionIsPartisan({
          draft: {
            district_id: "d-az",
            district_name: "Yuma County, Arizona",
            district_type: "county",
            state: "AZ",
          },
          contestFamily: "judicial_office",
          raceType: "office",
          officialBallotTitle: title,
          aiValue: true,
        })
      ).toBe(false);

      expect(
        shouldIncludeCandidatePartyByPolicy({
          districtType: "county",
          state: "AZ",
          officialBallotTitle: title,
        })
      ).toBe(false);
    }
  });

  it("keeps Arizona merit-selection retention contests nonpartisan", () => {
    // Maricopa, Pima, and Pinal judges — and every Arizona appellate judge —
    // stand for retention instead. Ariz. Const. art. 6 § 38 fixes the ballot
    // question as "Shall (name) of the (applicable) court be retained in
    // office?", so the retention guard has the keyword in every real title.
    const retentionTitles = [
      "Shall Judge Jane Doe of the Superior Court in Maricopa County be retained in office?",
      "Shall Justice John Roe of the Supreme Court of Arizona be retained in office?",
      "Judge of the Superior Court in Pima County (Retention) - Jane Doe",
      "Arizona Court of Appeals, Division One Retention - John Roe",
    ];

    for (const title of retentionTitles) {
      expect(isJudicialRetentionTitle(title)).toBe(true);

      for (const districtType of ["county", "statewide"] as const) {
        expect(
          resolveElectionIsPartisan({
            draft: {
              district_id: "d-az",
              district_name: "Maricopa County, Arizona",
              district_type: districtType,
              state: "AZ",
            },
            contestFamily: "judicial_office",
            raceType: "office",
            officialBallotTitle: title,
            aiValue: true,
          })
        ).toBe(false);

        expect(
          shouldIncludeCandidatePartyByPolicy({
            districtType,
            state: "AZ",
            officialBallotTitle: title,
          })
        ).toBe(false);
      }
    }
  });

  it("does not force Arizona municipal judges partisan", () => {
    // City magistrates are nonpartisan and their titles carry no retention
    // wording, so only the Justice of the Peace exception may fire in Arizona.
    // A live row already holds this contest as nonpartisan.
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "place",
        state: "AZ",
        officialBallotTitle: "Presiding Municipal Judge, City of Yuma",
      })
    ).toBe(false);

    expect(
      resolveElectionIsPartisan({
        draft: {
          district_id: "d-az-place",
          district_name: "Yuma, Arizona",
          district_type: "place",
          state: "AZ",
        },
        contestFamily: "judicial_office",
        raceType: "office",
        officialBallotTitle: "Presiding Municipal Judge, City of Yuma",
        aiValue: false,
      })
    ).toBe(false);
  });

  it("treats Clerk of Superior Court as a non-judicial office", () => {
    expect(isJudicialOfficeTitle("Clerk of Superior Court")).toBe(false);
    expect(isJudicialOfficeTitle("Clerk of the Circuit Court")).toBe(false);
    expect(isJudicialOfficeTitle("Judge of Superior Court, Division 2")).toBe(true);

    // The clerk is an elected partisan county officer in Arizona, so policy
    // must leave the value alone instead of forcing it nonpartisan.
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "AZ",
        officialBallotTitle: "Clerk of Superior Court",
      })
    ).toBeUndefined();

    // California is not a partisan-judicial state; before the fix the clerk
    // was dragged into judicial policy and forced nonpartisan there too.
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "CA",
        officialBallotTitle: "Clerk of Superior Court",
      })
    ).toBeUndefined();
  });

  it("treats prosecutors and public defenders as non-judicial offices", () => {
    // Every Georgia DA's ballot title names the circuit, and O.C.G.A. 15-6-1
    // names all 50+ circuits "<X> Judicial Circuit" — the bare `judicial` token
    // pulled the office into judicial policy, which is nonpartisan in Georgia.
    expect(isJudicialOfficeTitle("District Attorney - Paulding Judicial Circuit")).toBe(false);
    expect(isJudicialOfficeTitle("Solicitor-General, State Court of Paulding County")).toBe(false);
    expect(isJudicialOfficeTitle("Solicitor, 1st Judicial Circuit")).toBe(false);
    expect(isJudicialOfficeTitle("Public Defender, 20th Judicial Circuit")).toBe(false);
    // Illinois and Maryland use the possessive; Florida's circuit prosecutor
    // does not. Same office either way.
    expect(isJudicialOfficeTitle("State's Attorney, 9th Judicial Circuit")).toBe(false);
    expect(isJudicialOfficeTitle("Commonwealth's Attorney")).toBe(false);
    expect(isJudicialOfficeTitle("County Attorney")).toBe(false);
    expect(isJudicialOfficeTitle("District Attorney General, 19th Judicial District")).toBe(false);
    // The judges of the same circuits stay judicial.
    expect(isJudicialOfficeTitle("Judge, Superior Courts, Paulding Judicial Circuit")).toBe(true);

    // Georgia DAs are nominated in party primaries and printed with a party
    // (Paulding County's May 19 2026 certified results: "... - Rep"), so policy
    // must leave the researched value alone instead of forcing it false.
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "GA",
        officialBallotTitle: "District Attorney - Paulding Judicial Circuit",
      })
    ).toBeUndefined();
    expect(
      shouldIncludeCandidatePartyByPolicy({
        districtType: "county",
        state: "GA",
        officialBallotTitle: "District Attorney - Paulding Judicial Circuit",
      })
    ).toBe(true);
    expect(
      resolveElectionIsPartisan({
        draft: {
          district_id: "1dca234a-876f-4957-812c-3fedf8e0a7cb",
          district_name: "Paulding County, Georgia",
          district_type: "county",
          state: "GA",
        },
        contestFamily: "non_judicial_office",
        raceType: "office",
        officialBallotTitle: "District Attorney - Paulding Judicial Circuit",
        aiValue: true,
      })
    ).toBe(true);

    // The contest family must not outrank the office. A judicial pass that
    // returns the circuit's prosecutor would otherwise stamp it nonpartisan,
    // and the contract checks the title alone, so nothing downstream catches
    // it.
    for (const title of [
      "District Attorney - Paulding Judicial Circuit",
      "Solicitor-General, State Court of Paulding County",
      "Clerk of Superior Court, Paulding County",
    ]) {
      expect(
        resolveElectionIsPartisan({
          draft: {
            district_id: "1dca234a-876f-4957-812c-3fedf8e0a7cb",
            district_name: "Paulding County, Georgia",
            district_type: "county",
            state: "GA",
          },
          contestFamily: "judicial_office",
          raceType: "office",
          officialBallotTitle: title,
          aiValue: true,
        })
      ).toBe(true);
    }

    // Same construction in the other "Judicial Circuit" states.
    for (const state of ["AL", "FL", "MS", "SC"]) {
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state,
          officialBallotTitle: "District Attorney, 4th Judicial Circuit",
        })
      ).toBeUndefined();
    }
  });

  it("keeps Ohio common pleas, municipal, and county court judges nonpartisan", () => {
    // ORC 3505.04 puts "judges of a municipal court, county court, or court of
    // common pleas" on the nonpartisan ballot, which may print no party
    // designation — they are nominated at a party primary and reach November
    // with no label. Live 2026-08-08: identical common pleas titles were stored
    // as both t and f because policy forced the whole Ohio bench partisan.
    const nonpartisanTitles = [
      "For Judge of the Court of Common Pleas (General Division) (Full Term Commencing 1/2/2027)",
      "Judge of the Court of Common Pleas (Probate Division) - Full Term Commencing 02/09/2027",
      "Judge of Common Pleas Court (Domestic Relations) 1/2/2027",
      // County boards abbreviate the court; this exact title is live.
      "Judge Ct. of Com Pleas - Probate - FT Commencing 2/9/2027",
      "Judge of the Municipal Court (Full term commencing 1/1/2027)",
      "Judge of the County Court, Eastern District",
      // The probate and juvenile courts are divisions of the court of common
      // pleas (ORC 2101.01), and boards title them without ever naming that
      // court — Ross County files this exact form. Enumerating lower courts
      // would force these partisan; naming the two partisan courts does not.
      "PROBATE COURT JUDGE, JUVENILE DIVISION",
      "Judge of the Probate Court",
      "Juvenile Court Judge",
      "Domestic Relations Judge",
    ];

    for (const title of nonpartisanTitles) {
      expect(
        resolveElectionIsPartisan({
          draft: {
            district_id: "d-oh",
            district_name: "Franklin County, Ohio",
            district_type: "county",
            state: "OH",
          },
          contestFamily: "judicial_office",
          raceType: "office",
          officialBallotTitle: title,
          aiValue: true,
        })
      ).toBe(false);

      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state: "OH",
          officialBallotTitle: title,
        })
      ).toBe(false);

      expect(
        shouldIncludeCandidatePartyByPolicy({
          districtType: "county",
          state: "OH",
          officialBallotTitle: title,
        })
      ).toBe(false);
    }
  });

  it("keeps Ohio supreme court and court of appeals judges partisan", () => {
    // H.B. 149 / S.B. 80 (134th G.A.) added these two courts to the office-type
    // ballot, where ORC 3505.03 prints the nominating party under the name.
    const partisanTitles = [
      "Justice of the Supreme Court of Ohio (Full term commencing 01/01/2027)",
      "Chief Justice of the Supreme Court",
      "Judge of the Court of Appeals, 10th District (Full term commencing 2/9/2027)",
    ];

    for (const title of partisanTitles) {
      expect(
        resolveElectionIsPartisan({
          draft: {
            district_id: "d-oh",
            district_name: "Ohio",
            district_type: "statewide",
            state: "OH",
          },
          contestFamily: "judicial_office",
          raceType: "office",
          officialBallotTitle: title,
          aiValue: false,
        })
      ).toBe(true);

      expect(
        shouldIncludeCandidatePartyByPolicy({
          districtType: "statewide",
          state: "OH",
          officialBallotTitle: title,
        })
      ).toBe(true);
    }
  });

  it("does not force Ohio judicial retention or non-judicial county offices", () => {
    // "County Judge" is a non-judicial executive in some states; Ohio has no
    // such office, but the nonpartisan rule must key on "county court", not on
    // the bare word "county".
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "OH",
        officialBallotTitle: "Clerk of the Court of Common Pleas",
      })
    ).toBeUndefined();
  });

  it("leaves Tennessee judicial contests to the researched value", () => {
    // Every Tennessee trial level is decided by the county, not the title:
    // Shelby runs its circuit, criminal, chancery, and general sessions judges
    // nonpartisan while Knox, Davidson, Hamilton, and Montgomery print a party
    // on the same titles (live 2026-08-06 ballots).
    const titles = [
      "Circuit Court Judge Division III, District 30, Unexpired Term",
      "General Sessions Judge Division IV (Unexpired Term)",
      "Chancellor Part II - 19th Judicial Dist",
      "Municipal Judge, Division 1, City of Bartlett",
    ];

    for (const title of titles) {
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state: "TN",
          officialBallotTitle: title,
        })
      ).toBeUndefined();

      for (const aiValue of [true, false]) {
        expect(
          resolveElectionIsPartisan({
            draft: {
              district_id: "d-tn",
              district_name: "Shelby County, Tennessee",
              district_type: "county",
              state: "TN",
            },
            contestFamily: "judicial_office",
            raceType: "office",
            officialBallotTitle: title,
            aiValue,
          })
        ).toBe(aiValue);
      }
    }

    // With nothing forced, the prompt has to ask for the value.
    expect(
      shouldAskIsPartisanInPrompt({
        draft: {
          district_id: "d-tn",
          district_name: "Shelby County, Tennessee",
          district_type: "county",
          state: "TN",
        },
        contestFamily: "judicial_office",
      })
    ).toBe(true);
  });

  it("keeps Indiana trial judges partisan except the nonpartisan counties", () => {
    // Ind. Code 33-33-82-31 lists Vanderburgh circuit and superior judges
    // "without party designation"; Allen County's superior judges are
    // nonpartisan too, while its circuit judge stays partisan.
    for (const title of [
      "Judge of the Vanderburgh Superior Court, No. 3",
      "Judge, Vanderburgh Circuit Court",
      "Judge of the Allen Superior Court, No. 2",
      "Judge of the Superior Court, Allen County",
    ]) {
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state: "IN",
          officialBallotTitle: title,
        })
      ).toBe(false);
    }

    for (const title of [
      "Judge of the Elkhart Superior Court, No. 1",
      "Judge, Tippecanoe Superior Court No. 2",
      "Judge, Allen Circuit Court",
    ]) {
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state: "IN",
          officialBallotTitle: title,
        })
      ).toBe(true);
    }
  });

  it("keeps Indiana city and town courts partisan inside the nonpartisan counties", () => {
    // A city or town court sits inside a county without being one of its
    // courts. IC 33-35-1-1 elects those judges at the municipal election with
    // a party label in every county, so the county-wide Vanderburgh and Allen
    // carve-outs must not swallow them.
    for (const title of [
      "Judge of the Darmstadt Town Court, Vanderburgh County",
      "Vanderburgh County - Judge of the City Court",
      "Judge, New Haven City Court, Allen County",
    ]) {
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "place",
          state: "IN",
          officialBallotTitle: title,
        })
      ).toBe(true);
    }

    // The carve-out still has to survive a title that names no court level,
    // which is why the county patterns stay broad rather than being narrowed
    // to "circuit"/"superior".
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "IN",
        officialBallotTitle: "Vanderburgh County Judge",
      })
    ).toBe(false);
  });

  it("keeps the remaining partisan-judicial states forcing partisan", () => {
    // Audited 2026-08-08 against per-court-level ballot rules. These states
    // print the party at every level that reaches a ballot; where they do not
    // (Illinois/Pennsylvania/New Mexico/Missouri/Kansas later terms, Indiana
    // merit counties), the contest arrives as a retention question and the
    // retention rule catches it first.
    const cases: ReadonlyArray<[string, string]> = [
      ["AL", "Circuit Court Judge, 28th Judicial Circuit, Place No. 7"],
      ["IL", "Judge of the Circuit Court, 1st Subcircuit"],
      ["KS", "District Court Judge, 18th Judicial District, Division 5"],
      ["LA", "District Judge 22nd Judicial District Court, Division A"],
      ["MO", "Circuit Judge, 44th Judicial Circuit"],
      ["NM", "Bernalillo County Metropolitan Court Judge - Division 19"],
      ["NY", "Supreme Court Justice - 10th Judicial District"],
      ["NC", "NC District Court Judge District 26 Seat 13"],
      ["PA", "Judge of the Court of Common Pleas"],
      ["SC", "Probate Judge"],
      ["TX", "Justice, Supreme Court of Texas, Place 2"],
    ];

    for (const [state, title] of cases) {
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state,
          officialBallotTitle: title,
        })
      ).toBe(true);
    }

    // Pennsylvania's own court of common pleas is partisan — the nonpartisan
    // common pleas rule is Ohio's alone.
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "PA",
        officialBallotTitle: "Judge of the Court of Common Pleas",
      })
    ).toBe(true);
  });

  it("forces Washington state-legislative contests to partisan", () => {
    for (const districtType of ["state_upper", "state_lower"] as const) {
      expect(
        shouldAskIsPartisanInPrompt({
          draft: {
            district_id: "d-wa",
            district_name: "Washington legislative district",
            district_type: districtType,
            state: "WA",
          },
          contestFamily: "all",
        })
      ).toBe(false);

      expect(
        resolveElectionIsPartisan({
          draft: {
            district_id: "d-wa",
            district_name: "Washington legislative district",
            district_type: districtType,
            state: "WA",
          },
          contestFamily: "all",
          raceType: "office",
          officialBallotTitle: "State Representative Position 1",
          aiValue: false,
        })
      ).toBe(true);

      expect(
        shouldIncludeCandidatePartyByPolicy({
          districtType,
          state: "WA",
          officialBallotTitle: "State Representative Position 1",
        })
      ).toBe(true);
    }
  });

  it("does not treat court clerks and prosecutors as judicial offices", () => {
    for (const officialBallotTitle of [
      "Clerk of Superior Court",
      "Elkhart County Circuit Court Clerk",
      "Prosecuting Attorney of Elkhart County, 34th Judicial Circuit",
      "State Attorney, 4th Judicial Circuit",
      "Constable, Justice Precinct 2",
    ]) {
      expect(isJudicialOfficeTitle(officialBallotTitle), officialBallotTitle).toBe(false);
    }

    // Each of these is stored partisan and would be forced nonpartisan by a
    // judicial rule: Arizona's judicial fallback (clerk, constable) and the
    // unmapped-state default (Florida's state attorney). Off the judicial path
    // the researched ballot-facing value decides instead.
    for (const [state, officialBallotTitle] of [
      ["AZ", "Clerk of Superior Court"],
      ["AZ", "Constable, Justice Prec. 2"],
      ["FL", "State Attorney, 4th Judicial Circuit"],
    ] as const) {
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state,
          officialBallotTitle,
        }),
        officialBallotTitle
      ).toBeUndefined();
      expect(
        shouldIncludeCandidatePartyByPolicy({
          districtType: "county",
          state,
          officialBallotTitle,
        }),
        officialBallotTitle
      ).toBe(true);
    }
  });

  it("treats AR/TX county judge and KY judge/executive + magistrate as NON-judicial county offices", () => {
    // Titles that contain a judicial keyword but name a county EXECUTIVE or
    // LEGISLATIVE office in that state — the same executive titles migration
    // 145 aliases to the County Executive office. The judicial branch (which
    // would force the state's judicial ballot rule) must not claim them.
    expect(isJudicialOfficeTitle("Crawford County Judge", "AR")).toBe(false);
    expect(isJudicialOfficeTitle("Pulaski County Justice of the Peace District 3", "AR")).toBe(false);
    expect(isJudicialOfficeTitle("Justice of the Peace, District 7", "ar")).toBe(false);
    expect(isJudicialOfficeTitle("Laurel County Judge/Executive", "KY")).toBe(false);
    expect(isJudicialOfficeTitle("Laurel County Judge-Executive", "KY")).toBe(false);
    expect(isJudicialOfficeTitle("Laurel County Judge Executive", "KY")).toBe(false);
    expect(isJudicialOfficeTitle("Daviess County Judge / Executive", "KY")).toBe(false);
    expect(isJudicialOfficeTitle("Laurel County Magistrate District 3", "KY")).toBe(false);
    expect(isJudicialOfficeTitle("Van Zandt County Judge", "TX")).toBe(false);
    expect(isJudicialOfficeTitle("Kerr County County Judge", "TX")).toBe(false);
    expect(isJudicialOfficeTitle("County Judge, Unexpired Term", "TX")).toBe(false);

    // A title that names a COURT is a judgeship even with the county prefixed
    // onto it — real Texas shells, all of which must stay judicial.
    expect(isJudicialOfficeTitle("Erath County Judge, County Court at Law", "TX")).toBe(true);
    expect(isJudicialOfficeTitle("Nacogdoches County Judge, County Court-at-Law", "TX")).toBe(true);
    expect(isJudicialOfficeTitle("San Patricio County Judge, 156th Judicial District", "TX")).toBe(true);
    expect(isJudicialOfficeTitle("Bowie County Court at Law Judge", "TX")).toBe(true);
    expect(isJudicialOfficeTitle("Judge, County Court at Law", "TX")).toBe(true);
    expect(isJudicialOfficeTitle("District Judge, 294th Judicial District", "TX")).toBe(true);

    // The carve-out is state-scoped: a magistrate IS a judge elsewhere, a bare
    // "County Judge" IS a judge in Florida, and Pennsylvania elects Magisterial
    // District Judges. A real Kentucky or Arkansas judgeship keeps its routing.
    expect(isJudicialOfficeTitle("Magistrate, Charleston County", "SC")).toBe(true);
    expect(isJudicialOfficeTitle("Laurel County Magistrate District 3")).toBe(true);
    expect(isJudicialOfficeTitle("County Judge, Group 3", "FL")).toBe(true);
    expect(isJudicialOfficeTitle("Magisterial District Judge, District 05-2-01", "PA")).toBe(true);
    expect(isJudicialOfficeTitle("Circuit Judge, 27th Judicial Circuit", "KY")).toBe(true);
    expect(isJudicialOfficeTitle("District Judge, 2nd Division", "AR")).toBe(true);
    // A justice of the peace is a judge outside Arkansas: Arizona prints the
    // party for its JPs but they sit on a precinct court, and Texas's JP holds a
    // precinct court too. Both stay on the judicial branch.
    expect(isJudicialOfficeTitle("Justice of the Peace, Precinct 2", "AZ")).toBe(true);
    expect(isJudicialOfficeTitle("Justice of the Peace, Precinct 4, Place 1", "TX")).toBe(true);
    expect(isJudicialOfficeTitle("Pulaski County Justice of the Peace District 3")).toBe(true);
  });

  it("lets AR/KY/TX county executive and fiscal-court offices be stored partisan", () => {
    for (const [state, districtName, title] of [
      ["KY", "Laurel County, Kentucky", "Laurel County Judge/Executive"],
      ["KY", "Laurel County, Kentucky", "Laurel County Magistrate District 1"],
      ["AR", "Crawford County, Arkansas", "Crawford County Judge"],
      ["AR", "Pulaski County, Arkansas", "Pulaski County Justice of the Peace District 3"],
      ["TX", "Van Zandt County, Texas", "Van Zandt County Judge"],
    ] as const) {
      // No fixed policy value, so a source-backed true survives instead of
      // being rejected as contradicting a forced nonpartisan judicial rule.
      expect(
        resolveCandidateContestPartisanshipByPolicy({
          districtType: "county",
          state,
          officialBallotTitle: title,
        })
      ).toBeUndefined();

      expect(
        resolveElectionIsPartisan({
          draft: {
            district_id: "d-1",
            district_name: districtName,
            district_type: "county",
            state,
          },
          contestFamily: "non_judicial_office",
          raceType: "office",
          officialBallotTitle: title,
          aiValue: true,
        })
      ).toBe(true);

      expect(
        shouldIncludeCandidatePartyByPolicy({
          districtType: "county",
          state,
          officialBallotTitle: title,
        })
      ).toBe(true);
    }
  });

  it("keeps an Arkansas justice of the peace partisan even when discovery filed it as judicial", () => {
    // The family is only where the question was asked; the office decides.
    // A judicial_office pass returning quorum-court seats must not force the
    // researched value to nonpartisan.
    expect(
      resolveElectionIsPartisan({
        draft: {
          district_id: "d-1",
          district_name: "Garland County, Arkansas",
          district_type: "county",
          state: "AR",
        },
        contestFamily: "judicial_office",
        raceType: "office",
        officialBallotTitle: "Garland County Justice of the Peace District 5",
        aiValue: true,
      })
    ).toBe(true);

    // Arizona's JP is judicial and forced partisan by its title rule, so the
    // Arkansas carve-out must not have loosened it into ask_ai.
    expect(
      resolveCandidateContestPartisanshipByPolicy({
        districtType: "county",
        state: "AZ",
        officialBallotTitle: "Justice of the Peace, Precinct 2",
      })
    ).toBe(true);
  });
});
