import { describe, expect, it } from "vitest";
import {
  buildSanFranciscoContestManifestApiUrl,
  buildSanFranciscoContestManifestUrl,
  getSanFranciscoContestManifest,
  parseSanFranciscoContestManifest,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoDashboardManifestClient.js";

// Compact excerpt of the real elections/2026-06-02/contests/bos04.md
// frontmatter (captured 2026-08-06), keeping the shapes that matter:
// a wrapped committee name, a committee that supports one candidate while
// opposing another, and an unknown top-level key the parser must tolerate.
const BOS04_FIXTURE = `---
layout: contest_candidate
election: '2026-06-02'
candidate: true
title: Board of Supervisors D04
unknown_future_key:
- something: else
candidates:
- filer_nid: '215112140'
  filer_id: '1485709'
  committee_name: ALAN WONG FOR SUPERVISOR 2026
  candidate_name: ALAN WONG
  funds: 412371.0
  expenses: 410727.79
- filer_nid: '214896050'
  filer_id: '1484806'
  committee_name: NATALIE GEE FOR SUPERVISOR 2026
  candidate_name: NATALIE GEE
  funds: 405160.12
  expenses: 409056.2
ie_candidates:
- candidate_name: ALAN WONG
  filer_id: '1485709'
  committees:
  - position: OPPOSE
    filer_id: '1488862'
    committee_name: AFFORDABLE SF NOW SUPPORTING NATALIE GEE FOR SUPERVISOR 2026,
      SPONSORED BY LABOR ORGANIZATIONS
    funds: 0.0
    expenses: 24753.92
  - position: SUPPORT
    filer_id: '1488188'
    committee_name: GROWSF SUPPORTING ALAN WONG FOR SUPERVISOR 2026
    funds: 323556.0
    expenses: 209221.7
- candidate_name: NATALIE GEE
  filer_id: '1484806'
  committees:
  - position: OPPOSE
    filer_id: '1488188'
    committee_name: GROWSF SUPPORTING ALAN WONG FOR SUPERVISOR 2026
    funds: 0.0
    expenses: 56989.43
contributors:
- - Michael Moritz
  - 250000.0

---
`;

const PARSE_INPUT = {
  electionDate: "2026-06-02",
  contestCode: "bos04",
  sourceUrl:
    "https://raw.githubusercontent.com/sfethics/dashboards-2025/main/elections/2026-06-02/contests/bos04.md",
};

describe("parseSanFranciscoContestManifest", () => {
  it("parses candidates with reconciled totals in cents", () => {
    const manifest = parseSanFranciscoContestManifest({
      ...PARSE_INPUT,
      markdown: BOS04_FIXTURE,
    });
    expect(manifest.title).toBe("Board of Supervisors D04");
    expect(manifest.candidates).toHaveLength(2);
    expect(manifest.candidates[0]).toEqual({
      filerNid: "215112140",
      fppcId: "1485709",
      committeeName: "ALAN WONG FOR SUPERVISOR 2026",
      candidateName: "ALAN WONG",
      fundsCents: 41237100,
      expensesCents: 41072779,
    });
  });

  it("parses outside relations per candidate and direction", () => {
    const manifest = parseSanFranciscoContestManifest({
      ...PARSE_INPUT,
      markdown: BOS04_FIXTURE,
    });
    expect(manifest.outsideRelations).toHaveLength(3);
    // YAML folds the wrapped committee name back onto one line.
    expect(manifest.outsideRelations[0]).toEqual({
      candidateName: "ALAN WONG",
      candidateFppcId: "1485709",
      position: "oppose",
      spenderFppcId: "1488862",
      spenderName:
        "AFFORDABLE SF NOW SUPPORTING NATALIE GEE FOR SUPERVISOR 2026, SPONSORED BY LABOR ORGANIZATIONS",
      amountCents: 2475392,
    });
    // The same committee legitimately supports one candidate and opposes
    // another; direction is per relation, never per committee.
    const growSf = manifest.outsideRelations.filter(
      (relation) => relation.spenderFppcId === "1488188",
    );
    expect(
      growSf.map((relation) => [relation.candidateName, relation.position]),
    ).toEqual([
      ["ALAN WONG", "support"],
      ["NATALIE GEE", "oppose"],
    ]);
  });

  it("keeps an outside relation whose committee id is missing", () => {
    const markdown = BOS04_FIXTURE.replace(
      "  - position: SUPPORT\n    filer_id: '1488188'\n",
      "  - position: SUPPORT\n",
    );
    const manifest = parseSanFranciscoContestManifest({
      ...PARSE_INPUT,
      markdown,
    });
    const relation = manifest.outsideRelations.find(
      (row) => row.position === "support",
    );
    expect(relation?.spenderFppcId).toBeNull();
    expect(relation?.amountCents).toBe(20922170);
  });

  it("rejects absent IE scope instead of claiming zero spending", () => {
    const markdown = BOS04_FIXTURE.replace(
      /ie_candidates:[\s\S]*?contributors:/,
      "contributors:",
    );
    expect(() =>
      parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
    ).toThrow(/ie_candidates is not a list/);
  });

  it.each(["null", "{}", "false", "unknown"])(
    "rejects malformed IE scope %s instead of claiming zero spending",
    (value) => {
      const markdown = BOS04_FIXTURE.replace(
        /ie_candidates:[\s\S]*?contributors:/,
        `ie_candidates: ${value}\ncontributors:`,
      );
      expect(() =>
        parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
      ).toThrow(/ie_candidates is not a list/);
    },
  );

  it("accepts an explicit empty IE list only within the valid manifest schema", () => {
    const markdown = BOS04_FIXTURE.replace(
      /ie_candidates:[\s\S]*?contributors:/,
      "ie_candidates: []\ncontributors:",
    );
    const result = parseSanFranciscoContestManifest({
      ...PARSE_INPUT,
      markdown,
    });
    expect(result.outsideRelations).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    expect(result.schemaFingerprint).toContain("ie_candidates");
    expect(() =>
      parseSanFranciscoContestManifest({
        ...PARSE_INPUT,
        markdown: markdown.replace("funds: 412371.0", "funds: unavailable"),
      }),
    ).toThrow(/non-money funds/);
  });

  it.each(["[null]", "[{}]", "[{candidate_name: ALAN WONG}]"])(
    "rejects malformed IE entries %s",
    (value) => {
      const markdown = BOS04_FIXTURE.replace(
        /ie_candidates:[\s\S]*?contributors:/,
        `ie_candidates: ${value}\ncontributors:`,
      );
      expect(() =>
        parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
      ).toThrow(/ie_candidates/);
    },
  );

  it("does not turn a malformed target ID into name-only matching", () => {
    const markdown = BOS04_FIXTURE.replace(
      "- candidate_name: ALAN WONG\n  filer_id: '1485709'",
      "- candidate_name: ALAN WONG\n  filer_id: wrong-id",
    );
    expect(() =>
      parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
    ).toThrow(/invalid filer_id/);
  });

  it.each(["null", "-1", "0.001", "90071992547410"])(
    "rejects unavailable or inexact outside money %s",
    (value) => {
      const markdown = BOS04_FIXTURE.replace(
        "expenses: 24753.92",
        `expenses: ${value}`,
      );
      expect(() =>
        parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
      ).toThrow(/non-money expenses/);
    },
  );

  it.each([undefined, "2024-11-05"])(
    "rejects explicit empty IE scope with missing or wrong source election %s",
    (election) => {
      const markdown = BOS04_FIXTURE.replace(
        /ie_candidates:[\s\S]*?contributors:/,
        "ie_candidates: []\ncontributors:",
      ).replace(
        "election: '2026-06-02'\n",
        election ? `election: '${election}'\n` : "",
      );
      expect(() =>
        parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
      ).toThrow(/election does not match request/);
    },
  );

  it("rejects a candidate entry missing committee identity", () => {
    const markdown = BOS04_FIXTURE.replace("  filer_id: '1485709'\n", "");
    expect(() =>
      parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
    ).toThrow(/ALAN WONG is missing committee identity/);
  });

  it("rejects a non-money funds value", () => {
    const markdown = BOS04_FIXTURE.replace("funds: 412371.0", "funds: n/a");
    expect(() =>
      parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
    ).toThrow(/non-money funds/);
  });

  it("rejects an unknown position", () => {
    const markdown = BOS04_FIXTURE.replace(
      "position: OPPOSE",
      "position: ASSIST",
    );
    expect(() =>
      parseSanFranciscoContestManifest({ ...PARSE_INPUT, markdown }),
    ).toThrow(/unknown position: assist/);
  });

  it("records a schema fingerprint that surfaces upstream drift", () => {
    const manifest = parseSanFranciscoContestManifest({
      ...PARSE_INPUT,
      markdown: BOS04_FIXTURE,
    });
    expect(manifest.schemaFingerprint).toBe(
      [
        "top:candidate,candidates,contributors,election,ie_candidates,layout,title,unknown_future_key",
        "candidate:candidate_name,committee_name,expenses,filer_id,filer_nid,funds",
        "ie_candidate:candidate_name,committees,filer_id",
        "ie_committee:committee_name,expenses,filer_id,funds,position",
      ].join("|"),
    );
    const drifted = parseSanFranciscoContestManifest({
      ...PARSE_INPUT,
      markdown: BOS04_FIXTURE.replace(
        "  funds: 412371.0\n",
        "  funds: 412371.0\n  new_column: 1\n",
      ),
    });
    expect(drifted.schemaFingerprint).toContain("candidate:candidate_name");
    expect(drifted.schemaFingerprint).toContain("new_column");
    expect(drifted.schemaFingerprint).not.toBe(manifest.schemaFingerprint);
  });

  it("rejects a file without frontmatter", () => {
    expect(() =>
      parseSanFranciscoContestManifest({
        ...PARSE_INPUT,
        markdown: "# not a manifest",
      }),
    ).toThrow(/no YAML frontmatter/);
  });
});

describe("buildSanFranciscoContestManifestUrl", () => {
  it("builds the raw GitHub URL from defaults", () => {
    expect(
      buildSanFranciscoContestManifestUrl({
        electionDate: "2024-11-05",
        contestCode: "myr",
      }),
    ).toBe(
      "https://raw.githubusercontent.com/sfethics/dashboards-2025/main/elections/2024-11-05/contests/myr.md",
    );
  });

  it("rejects malformed election dates and contest codes", () => {
    expect(() =>
      buildSanFranciscoContestManifestUrl({
        electionDate: "11/05/2024",
        contestCode: "myr",
      }),
    ).toThrow(/Invalid San Francisco dashboard election date/);
    expect(() =>
      buildSanFranciscoContestManifestUrl({
        electionDate: "2024-11-05",
        contestCode: "../secrets",
      }),
    ).toThrow(/Invalid San Francisco dashboard contest code/);
    expect(() =>
      buildSanFranciscoContestManifestApiUrl({
        electionDate: "2024-11-05",
        contestCode: "../secrets",
      }),
    ).toThrow(/Invalid San Francisco dashboard contest code/);
  });

  it("builds the GitHub contents API fallback URL", () => {
    expect(
      buildSanFranciscoContestManifestApiUrl({
        electionDate: "2026-06-02",
        contestCode: "bos04",
      }),
    ).toBe(
      "https://api.github.com/repos/sfethics/dashboards-2025/contents/elections/2026-06-02/contests/bos04.md?ref=main",
    );
  });
});

describe("getSanFranciscoContestManifest", () => {
  it("falls back to the contents API when the raw host fails", async () => {
    const requests: { url: string; accept: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        accept: new Headers(init?.headers).get("accept"),
      });
      if (url.startsWith("https://raw.githubusercontent.com/"))
        return new Response("raw host down", { status: 503 });
      return new Response(BOS04_FIXTURE, { status: 200 });
    };
    const manifest = await getSanFranciscoContestManifest(
      { electionDate: "2026-06-02", contestCode: "bos04" },
      { fetchImpl, retryCount: 0 },
    );
    expect(manifest.candidates).toHaveLength(2);
    expect(manifest.sourceUrl).toBe(
      "https://api.github.com/repos/sfethics/dashboards-2025/contents/elections/2026-06-02/contests/bos04.md?ref=main",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.accept).toBe("application/vnd.github.raw+json");
  });

  it("does not retry a parse failure through the fallback host", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response("# not a manifest", { status: 200 });
    };
    await expect(
      getSanFranciscoContestManifest(
        { electionDate: "2026-06-02", contestCode: "bos04" },
        { fetchImpl, retryCount: 0 },
      ),
    ).rejects.toThrow(/no YAML frontmatter/);
    expect(requestedUrls).toHaveLength(1);
  });

  it("reports both hosts when primary and fallback fail", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("down", { status: 500 });
    await expect(
      getSanFranciscoContestManifest(
        { electionDate: "2026-06-02", contestCode: "bos04" },
        { fetchImpl, retryCount: 0 },
      ),
    ).rejects.toThrow(/failed on both hosts: .*500.*; fallback: .*500/);
  });
});
