import { describe, expect, it } from "vitest";

import type { DelawareCfrsFetchFn } from "../../../src/pipeline/delawareFinance/delawareCfrsClient.js";
import { searchAndResolveDelawareCandidateCommittee } from "../../../src/pipeline/delawareFinance/delawareCandidateCommitteeResolver.js";

type Scripted = { match: (url: string, body: string | undefined) => boolean; response: () => Response };

function scriptedFetch(script: Scripted[]): {
  fetchImpl: DelawareCfrsFetchFn;
  requests: { url: string; body: string | undefined }[];
} {
  const requests: { url: string; body: string | undefined }[] = [];
  const remaining = [...script];
  const fetchImpl: DelawareCfrsFetchFn = (url, init) => {
    requests.push({ url, body: init.body });
    const next = remaining.shift();
    if (next === undefined || !next.match(url, init.body)) {
      throw new Error(`unexpected request: ${url} body=${init.body ?? ""}`);
    }
    return Promise.resolve(next.response());
  };
  return { fetchImpl, requests };
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function gridRow(memberId: number, cfId: string, name: string, status = "Active") {
  return {
    MemberID: memberId,
    Committee_Id: cfId,
    CommitteeName: name,
    CommitteeTypeCode: "01",
    CommitteeType: "Candidate Committee",
    CommitteeStatus: status,
    OfficeSought: "",
    DistrictName: "",
    County: "",
    RegisteredDateStr: "1/1/2026",
    Formtype: "SO",
  };
}

const sessionOptions = { sleep: () => Promise.resolve(), spacingMs: 0 } as const;

describe("searchAndResolveDelawareCandidateCommittee", () => {
  it("resolves a statewide candidate through the office-filtered search", async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { match: (url) => url.includes("/Public/ViewCommittees"), response: () => html("<html>search form</html>") },
      { match: (url) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
      {
        match: (url) => url.includes("/Public/_ViewCommittees"),
        response: () =>
          json({
            data: [
              gridRow(600001, "01009999", "Jane Example for Delaware"),
              gridRow(600002, "01008888", "Friends of Sam Rival"),
              gridRow(600003, "01007777", "Old Example Committee", "Closed"),
            ],
            total: 3,
          }),
      },
    ]);

    const resolution = await searchAndResolveDelawareCandidateCommittee(
      { candidateName: "Jane Example", officeScope: "statewide", officeName: "Attorney General" },
      { ...sessionOptions, fetchImpl }
    );
    expect(resolution).toMatchObject({ status: "matched", cfId: "01009999", memberId: 600001 });
    const searchBody = requests[1]?.body ?? "";
    expect(searchBody).toContain("CommitteeType=01");
    expect(searchBody).toContain("ddlOfficeSought=AGEN");
  });

  it("resolves legislative district option values live by label", async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { match: (url) => url.includes("/Public/ViewCommittees"), response: () => html("<html>search form</html>") },
      {
        match: (url, body) => url.includes("/Public/GetDistricts") && (body ?? "").includes("Office=STSEN"),
        response: () =>
          html(`<select id='ddljurisdiction'><option value="">--Select District--</option><option value="5">District 04</option><option value="6">District 05</option></select>`),
      },
      { match: (url) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
      {
        match: (url) => url.includes("/Public/_ViewCommittees"),
        response: () => json({ data: [gridRow(600004, "01006666", "Committee to Elect Pat Senator")], total: 1 }),
      },
    ]);

    const resolution = await searchAndResolveDelawareCandidateCommittee(
      {
        candidateName: "Pat Senator",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "District 4",
      },
      { ...sessionOptions, fetchImpl }
    );
    expect(resolution).toMatchObject({ status: "matched", cfId: "01006666" });
    expect(requests[2]?.body).toContain("ddljurisdiction=5");
  });

  it("matches names glued together in the committee name (live: HarryGold4Delaware, Friends of KamelaSmith)", async () => {
    const rows = [
      gridRow(600011, "01006724", "HarryGold4Delaware"),
      gridRow(600012, "01005886", "Friends of KamelaSmith"),
      gridRow(600013, "01006735", "LisaMcInnis4RepDist1"),
      gridRow(600014, "01000408", "Friends To Elect Gerald Hocker"),
      gridRow(600015, "01000409", "Goldberg for Delaware"),
    ];
    const resolve = (candidateName: string) =>
      searchAndResolveDelawareCandidateCommittee(
        { candidateName, officeScope: "statewide", officeName: "Attorney General" },
        {
          ...sessionOptions,
          fetchImpl: scriptedFetch([
            { match: (url) => url.includes("/Public/ViewCommittees"), response: () => html("<html>form</html>") },
            { match: (url) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
            { match: (url) => url.includes("/Public/_ViewCommittees"), response: () => json({ data: rows, total: 5 }) },
          ]).fetchImpl,
        }
      );
    await expect(resolve("Harry S. Gold")).resolves.toMatchObject({ status: "matched", cfId: "01006724" });
    await expect(resolve("Kamela T. Smith")).resolves.toMatchObject({ status: "matched", cfId: "01005886" });
    await expect(resolve("Lisa McInnis")).resolves.toMatchObject({ status: "matched", cfId: "01006735" });
    // "Berg" is not a capital-letter boundary inside "Goldberg".
    await expect(resolve("Sam Berg")).resolves.toMatchObject({ status: "unmatched" });
  });

  it("fails closed on ambiguity and refines surname collisions with the first name", async () => {
    const rows = [
      gridRow(600005, "01001111", "Jane Example for Delaware"),
      gridRow(600006, "01002222", "Robert Example for Attorney General"),
    ];
    const script = () => [
      { match: (url: string) => url.includes("/Public/ViewCommittees"), response: () => html("<html>form</html>") },
      { match: (url: string) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
      { match: (url: string) => url.includes("/Public/_ViewCommittees"), response: () => json({ data: rows, total: 2 }) },
    ];

    const refined = await searchAndResolveDelawareCandidateCommittee(
      { candidateName: "Jane Example", officeScope: "statewide", officeName: "Attorney General" },
      { ...sessionOptions, fetchImpl: scriptedFetch(script()).fetchImpl }
    );
    expect(refined).toMatchObject({ status: "matched", cfId: "01001111" });

    const ambiguous = await searchAndResolveDelawareCandidateCommittee(
      { candidateName: "Chris Example", officeScope: "statewide", officeName: "Attorney General" },
      { ...sessionOptions, fetchImpl: scriptedFetch(script()).fetchImpl }
    );
    expect(ambiguous).toMatchObject({ status: "ambiguous", reason: "multiple_matching_committees" });
  });

  it("vetoes committees whose embedded name carries conflicting middle evidence", async () => {
    const rows = [
      gridRow(600007, "01003333", "Friends of John B Smith"),
      gridRow(600008, "01004444", "John Smith Sr for Delaware"),
    ];
    const script = () => [
      { match: (url: string) => url.includes("/Public/ViewCommittees"), response: () => html("<html>form</html>") },
      { match: (url: string) => url.includes("/Public/Search"), response: () => html("<html>results</html>") },
      { match: (url: string) => url.includes("/Public/_ViewCommittees"), response: () => json({ data: rows, total: 2 }) },
    ];

    // "John A. Smith Jr." conflicts with BOTH: a contradicting middle
    // initial on one, a different generation on the other.
    const vetoed = await searchAndResolveDelawareCandidateCommittee(
      { candidateName: "John A. Smith Jr.", officeScope: "statewide", officeName: "Attorney General" },
      { ...sessionOptions, fetchImpl: scriptedFetch(script()).fetchImpl }
    );
    expect(vetoed).toEqual({ status: "unmatched", reason: "no_candidate_committee_match" });

    // Without middle/suffix evidence of his own, only the generational
    // conflict is off the table — the middle-initial committee still
    // carries no contradiction, so it matches uniquely.
    const matched = await searchAndResolveDelawareCandidateCommittee(
      { candidateName: "John Smith Jr.", officeScope: "statewide", officeName: "Attorney General" },
      { ...sessionOptions, fetchImpl: scriptedFetch(script()).fetchImpl }
    );
    expect(matched).toMatchObject({ status: "matched", cfId: "01003333" });
  });

  it("returns typed non-matches without touching the portal when inputs are unusable", async () => {
    const neverFetch: DelawareCfrsFetchFn = () => {
      throw new Error("must not fetch");
    };
    await expect(
      searchAndResolveDelawareCandidateCommittee(
        { candidateName: "Cher", officeScope: "statewide", officeName: "Attorney General" },
        { ...sessionOptions, fetchImpl: neverFetch }
      )
    ).resolves.toEqual({ status: "unmatched", reason: "missing_candidate_name" });
    await expect(
      searchAndResolveDelawareCandidateCommittee(
        { candidateName: "Jane Example", officeScope: "county", officeName: "Sheriff" },
        { ...sessionOptions, fetchImpl: neverFetch }
      )
    ).resolves.toEqual({ status: "unmatched", reason: "unsupported_office" });
  });
});
