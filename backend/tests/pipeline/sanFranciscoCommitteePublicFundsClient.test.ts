import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  parseSanFranciscoCommitteePublicFunds,
  getSanFranciscoCommitteePublicFunds,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteePublicFundsClient.js";
const candidate = {
  fppcId: "1483804",
  filerNid: "214772801",
  candidateName: "EMANUEL YEKUTIEL",
  committeeName: "MANNY YEKUTIEL FOR SUPERVISOR 2026",
  fundsCents: 77795799,
  expensesCents: 33383038,
};
const markdown = `---
layout: candidate_committee
committee_type: candidate
filer_id: '1483804'
filer_nid: '214772801'
filer_name: Manny Yekutiel for Supervisor 2026
candidate_name: Emanuel Yekutiel
election: '2026-11-03'
totals: [522957.99, 333830.38]
pubfi:
  participant: 'True'
  total: 255000.0
---
`;
const input = { candidate, electionDate: "2026-11-03", contestCode: "bos08" };
const url =
  "https://raw.githubusercontent.com/sfethics/dashboards-2025/main/elections/2026-11-03/committees/CA1483804.md";
describe("exact-account SF public financing publication", () => {
  it("preserves source account amounts and owner spelling without mapping Manny to Emanuel", () => {
    expect(
      parseSanFranciscoCommitteePublicFunds({
        ...input,
        markdown,
        sourceUrl: url,
      }),
    ).toMatchObject({
      fppcId: "1483804",
      filerNid: "214772801",
      candidateName: "Emanuel Yekutiel",
      contributionCents: 52295799,
      publicFundsCents: 25500000,
      expenditureCents: 33383038,
      sha256: createHash("sha256").update(markdown).digest("hex"),
    });
  });
  it.each([
    ["filer_id: '1483804'", "filer_id: '1483805'"],
    ["filer_nid: '214772801'", "filer_nid: '999999999'"],
    ["Emanuel Yekutiel", "Manny Yekutiel"],
    [
      "Manny Yekutiel for Supervisor 2026",
      "Manny Yekutiel for Supervisor 2024",
    ],
    ["2026-11-03", "2026-06-02"],
    ["committee_type: candidate", "committee_type: primarily_formed"],
  ])("rejects misbound owner/account/election %s", (from, to) => {
    expect(() =>
      parseSanFranciscoCommitteePublicFunds({
        ...input,
        markdown: markdown.replace(from, to),
        sourceUrl: url,
      }),
    ).toThrow(/identity/);
  });
  it.each(["-1", "NaN", "255000.001", "9007199254740992"])(
    "rejects unsupported source amount %s",
    (amount) => {
      expect(() =>
        parseSanFranciscoCommitteePublicFunds({
          ...input,
          markdown: markdown.replace("255000.0", amount),
          sourceUrl: url,
        }),
      ).toThrow(/amount/);
    },
  );
  it.each(["False", "true", ""])(
    "rejects missing or unproven participation %s",
    (participant) => {
      expect(() =>
        parseSanFranciscoCommitteePublicFunds({
          ...input,
          markdown: markdown.replace("'True'", `'${participant}'`),
          sourceUrl: url,
        }),
      ).toThrow(/metadata/);
    },
  );
  it("requests only the exact public account and retains caller identity across await", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutable = structuredClone(input);
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(markdown);
    });
    const result = getSanFranciscoCommitteePublicFunds(mutable, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    mutable.candidate.fppcId = "9999999";
    mutable.candidate.candidateName = "OTHER PERSON";
    release();
    expect((await result).fppcId).toBe("1483804");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(url);
  });
  it("HTTP/error HTML cannot become a participating zero", async () => {
    await expect(
      getSanFranciscoCommitteePublicFunds(input, {
        fetchImpl: vi.fn(
          async () => new Response("not source", { status: 500 }),
        ),
      }),
    ).rejects.toThrow(/500/);
    await expect(
      getSanFranciscoCommitteePublicFunds(input, {
        fetchImpl: vi.fn(async () => new Response("<html>error</html>")),
      }),
    ).rejects.toThrow(/frontmatter/);
  });
});
