import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureMarylandPublicCommitteePost,
  captureMarylandPublishedGovernorContextGet,
  getMarylandCurrentFilingCycles,
} from "../../../src/pipeline/marylandFinance/marylandCurrentCycleExportClient.js";
import { buildMarylandPublicCommitteeRequest } from "../../../src/pipeline/marylandFinance/marylandPublicCommitteeClient.js";
import {
  bindMarylandOutsideReceivingContext,
  parseMaryland2026GeneralElectionDate,
  parseMaryland2026GovernorRoster,
  type MarylandOutsideReceivingContextInput,
} from "../../../src/pipeline/marylandFinance/marylandOutsideReceivingContext.js";
const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const roster = (
  name = "Wes Moore",
  committee = "Wes Moore For Maryland",
  party = "Democratic",
) =>
  `<h1>2026 Gubernatorial General Election State Candidates List</h1><details><summary>Governor / Lt. Governor</summary><h2>${name}</h2>${party}<div class="candidate"><dl><dt>Committee Name</dt><dd>${committee}</dd><dt>Unrelated field</dt><dd>not retained</dd></dl></div><h2>Related Person - Related to ${name}</h2>${party}<div class="candidate"><dl><dt>Other field</dt><dd>not retained</dd></dl></div></details>`;
const date = (literal = "November 3, 2026") =>
  `<h1>Offices up for Election in 2026</h1><dl><dt>Primary Election</dt><dd><dl><dt>Election Day</dt><dd>June 23, 2026 7AM&ndash;8PM</dd></dl></dd><dt>General Election</dt><dd><dl><dt>Early Voting</dt><dd>not election day</dd><dt>Election Day</dt><dd>${literal} 7AM&ndash;8PM</dd></dl></dd></dl>`;
const sourceRow = () => ({
  filerRegistrationGuid: uuid(1),
  registrationDocumentGuid: uuid(2),
  filingEntityId: 1013630,
  committeeName: "Moore, Wes For Maryland",
  candidateName: "MOORE, WESTLEY W.",
  committeeType: "Candidate",
  committeeTypeCode: "CC",
  officeSought: "Governor/Lieutenant Governor",
  officeSoughtId: 40,
  jurisdiction: "Maryland State",
  jurisdictionId: 1,
  partyAffiliation: "Democrat",
  accountStatus: "Active",
  accountStatusCode: "FACT",
  electionYears: "2026,2022",
  electionCycleID: "12023",
  electionTypeCodes: "GBRELEC",
  elections: "Gubernatorial - 11/08/2026, Gubernatorial - 11/08/2022",
  registrationYear: 2021,
  isActive: true,
  registrationSubmittalDate: "2021-01-01",
  registrationApprovalDate: "2021-01-02",
  registrationTerminatedDate: null,
  lastRegistrationAmendedDate: "2026-01-01",
});
const dirs: string[] = [];
async function dir() {
  const d = await mkdtemp(join(tmpdir(), "md-context-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function input() {
  const d = await dir(),
    rows = [sourceRow()],
    envelope = {
      succeeded: true,
      error: null,
      data: { items: rows, totalItems: 1, pageNumber: 0, pageSize: 0 },
    };
  const numeric = await captureMarylandPublicCommitteePost(
    buildMarylandPublicCommitteeRequest({
      query: { kind: "numeric", filingEntityId: 1013630 },
      pageNumber: 1,
    }),
    {
      outputPath: join(d, "number"),
      fetchImpl: async () => new Response(JSON.stringify(envelope)),
    },
  );
  const named = await captureMarylandPublicCommitteePost(
    buildMarylandPublicCommitteeRequest({
      query: { kind: "name", committeeName: "Moore, Wes For Maryland" },
      pageNumber: 1,
    }),
    {
      outputPath: join(d, "name"),
      fetchImpl: async () => new Response(JSON.stringify(envelope)),
    },
  );
  const rosterCapture = await captureMarylandPublishedGovernorContextGet(
    "general_roster",
    {
      outputPath: join(d, "roster"),
      fetchImpl: async () => new Response(roster()),
    },
  );
  const dateCapture = await captureMarylandPublishedGovernorContextGet(
    "election_dates",
    {
      outputPath: join(d, "date"),
      fetchImpl: async () => new Response(date()),
    },
  );
  const cycle = await getMarylandCurrentFilingCycles({
    outputPath: join(d, "cycle"),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          succeeded: true,
          error: null,
          data: [{ value: "12023", name: "2023-2026", isDefault: true }],
        }),
      ),
  });
  return {
    canonical: {
      candidateId: uuid(10),
      electionId: uuid(11),
      linkId: uuid(12),
      candidateName: "Wes Moore",
      party: "Democratic",
      officeName: "Governor",
      state: "MD",
      districtId: uuid(13),
      canonicalDistrictId: null,
      districtType: "statewide",
      districtGeoidCompact: "24",
      officeScope: "statewide",
      electionYear: 2026,
      electionDate: "2026-11-03",
      electionStage: "general",
      candidateDeleted: false,
      candidateMerged: false,
      declared: true,
      linkActive: true,
      activeReceivingLinkCount: 1,
      committeeId: "1013630",
      committeeName: "Moore, Wes For Maryland",
    },
    numericRegistration: { captures: [numeric] },
    nameRegistration: { captures: [named] },
    rosterCapture,
    dateCapture,
    cycleCapture: cycle.capture,
  } satisfies MarylandOutsideReceivingContextInput;
}
async function replace(
  c: { outputPath: string; sha256: string; byteCount: number },
  body: string,
) {
  await writeFile(c.outputPath, body);
  c.byteCount = Buffer.byteLength(body);
  c.sha256 = createHash("sha256").update(body).digest("hex");
}
describe("official finite receiving source facts", () => {
  it("separates Governor finance block from related LG and keeps only public context fields", () => {
    const p = parseMaryland2026GovernorRoster(roster());
    expect(p.candidates).toHaveLength(2);
    expect(p.candidates[0]).toEqual({
      candidateName: "Wes Moore",
      party: "Democratic",
      committeeName: "Wes Moore For Maryland",
      relatedTo: null,
    });
    expect(p.candidates[1]!.committeeName).toBeNull();
    expect(JSON.stringify(p)).not.toContain("not retained");
  });
  it.each(["comment", "script", "style"])(
    "rejects context present only in %s",
    (kind) => {
      const html =
        kind === "comment"
          ? `<!--${roster()}-->`
          : `<${kind}>${roster()}</${kind}>`;
      expect(() => parseMaryland2026GovernorRoster(html)).toThrow(
        "invalid_receiving_context_source",
      );
      expect(() =>
        parseMaryland2026GeneralElectionDate(
          kind === "comment"
            ? `<!--${date()}-->`
            : `<${kind}>${date()}</${kind}>`,
        ),
      ).toThrow();
    },
  );
  it("ignores fake script/comment nodes alongside genuine source", () => {
    expect(
      parseMaryland2026GovernorRoster(
        `<!--${roster("Wrong")}--><script>${roster("Wrong")}</script>${roster()}`,
      ).candidates[0]!.candidateName,
    ).toBe("Wes Moore");
  });
  it("does not borrow related block committee or wrong office summary", () => {
    expect(() =>
      parseMaryland2026GovernorRoster(
        roster().replace(
          /<dt>Committee Name<\/dt><dd>Wes Moore For Maryland<\/dd>/,
          "",
        ),
      ),
    ).toThrow();
    expect(() =>
      parseMaryland2026GovernorRoster(
        roster().replace("Governor / Lt. Governor", "Attorney General"),
      ),
    ).toThrow();
  });
  it("reads only General Election Day, preserves alternative actual dates as facts", () => {
    expect(parseMaryland2026GeneralElectionDate(date()).electionDate).toBe(
      "2026-11-03",
    );
    expect(
      parseMaryland2026GeneralElectionDate(date("November 10, 2026"))
        .electionDate,
    ).toBe("2026-11-10");
    expect(() =>
      parseMaryland2026GeneralElectionDate(date("February 30, 2026")),
    ).toThrow();
    expect(() =>
      parseMaryland2026GeneralElectionDate(
        date().replace("General Election", "Primary Election"),
      ),
    ).toThrow();
  });
  it("binds only finite full committee display pair without personal alias or date rewrite", async () => {
    const i = await input(),
      r = await bindMarylandOutsideReceivingContext(i);
    expect(r.binding).toMatchObject({
      sourceCommitteeName: "Moore, Wes For Maryland",
      sourceOwnerName: "MOORE, WESTLEY W.",
      committeeDisplayPolicy: "moore_complete_committee_label_pair_v1",
    });
    expect(r.binding!.sourceElectionMembership).toContain("11/08/2026");
    expect(r.binding!.canonical.electionDate).toBe("2026-11-03");
    expect(r.binding).not.toHaveProperty("qualified");
    expect(r.binding).not.toHaveProperty("money");
  });
  it.each([
    { candidateName: "Westley Moore" },
    { party: "Republican" },
    { officeName: "Attorney General" },
    { state: "VA" },
    { canonicalDistrictId: uuid(13) },
    { districtGeoidCompact: "25" },
    { districtType: "state_lower" },
    { officeScope: "district" },
    { districtId: "not a UUID" },
    { electionStage: "primary" },
    { electionDate: "2026-11-08" },
    { candidateDeleted: true },
    { candidateMerged: true },
    { declared: false },
    { linkActive: false },
    { activeReceivingLinkCount: 2 },
    { committeeName: "Wes Moore For Maryland" },
  ])("holds incompatible actual canonical context %j", async (extra) => {
    const i = await input();
    const r = await bindMarylandOutsideReceivingContext({
      ...i,
      canonical: { ...i.canonical, ...extra },
    } as never);
    expect(r.binding).toBeUndefined();
  });
  it("rejects unclosed old research scope and hash corruption", async () => {
    const i = await input();
    const bad = {
      ...i.numericRegistration.captures[0]!,
      requestBody: undefined,
    } as never;
    expect(
      (
        await bindMarylandOutsideReceivingContext({
          ...i,
          numericRegistration: { captures: [bad] },
        })
      ).binding,
    ).toBeUndefined();
    await writeFile(i.rosterCapture.outputPath, roster("Wrong"));
    expect(
      (await bindMarylandOutsideReceivingContext(i)).binding,
    ).toBeUndefined();
  });
  it.each([
    { candidateName: "MOORE, WES" },
    { committeeTypeCode: "PAC" },
    { officeSought: "Attorney General" },
    { partyAffiliation: "Republican" },
    { electionYears: "2022" },
    { electionTypeCodes: "PRELEC" },
    { isActive: false },
    { accountStatus: "Terminated" },
  ])(
    "holds changed source identity/class/office/membership %j",
    async (extra) => {
      const i = await input();
      for (const group of [i.numericRegistration, i.nameRegistration]) {
        const c = { ...group.captures[0]! };
        const v = JSON.parse(await readFile(c.outputPath, "utf8"));
        Object.assign(v.data.items[0], extra);
        await replace(c, JSON.stringify(v));
        group.captures = [c];
      }
      expect(
        (await bindMarylandOutsideReceivingContext(i)).binding,
      ).toBeUndefined();
    },
  );
  it("holds wrong official date or duplicate roster target despite valid capture hashes", async () => {
    const i = await input();
    const dc = { ...i.dateCapture };
    await replace(dc, date("November 10, 2026"));
    expect(
      (await bindMarylandOutsideReceivingContext({ ...i, dateCapture: dc }))
        .binding,
    ).toBeUndefined();
    const rc = { ...i.rosterCapture };
    await replace(
      rc,
      roster().replace(
        "</details>",
        `<h2>Wes Moore</h2>Democratic<div class="candidate"><dl><dt>Committee Name</dt><dd>Other</dd></dl></div></details>`,
      ),
    );
    expect(
      (await bindMarylandOutsideReceivingContext({ ...i, rosterCapture: rc }))
        .binding,
    ).toBeUndefined();
  });
});
