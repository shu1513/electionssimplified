import { describe, expect, it } from "vitest";
import { groupSanFranciscoCommitteeCashByInterest } from "../../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashReader.js";

const row = (id: string, name: string, amount: string) => ({
  candidate_id: "c",
  election_id: "e",
  committee_id: id,
  committee_name: name,
  amount,
  source_url: "https://data.sfgov.org/d/pitq-e56w",
  reported_through: "2026-09-19",
  last_synced_at: "2026-10-12",
});

describe("San Francisco committee cash reader", () => {
  it("excludes every campaign label found in the real Yekutiel source packet", () => {
    const names = [
      "MATT HANEY FOR ASSEMBLY 2026",
      "JOE SANGIRARDI FOR SAN FRANCISCO DEMOCRATIC COUNTY CENTRAL COMMITTEE 2024 OFFICEHOLDER COMMITTEE",
      "TONI ATKINS FOR GOVERNOR 2026",
      "JACKIE SPEIER FOR SUPERVISOR 2028",
      "PATRICK AHRENS FOR ASSEMBLY 2026",
      "JESSE GABRIEL FOR ASSEMBLY 2026",
      "RE-ELECT RICK CHAVEZ ZBUR FOR ASSEMBLY 2026",
      "JOSH BECKER FOR SENATE 2028",
    ];
    expect(
      groupSanFranciscoCommitteeCashByInterest(
        names.map((name, n) => row(String(n), name, "500")),
      ).size,
    ).toBe(0);
  });

  it("preserves genuine unknown committees, excludes named candidate campaigns and nonpositive net positions", () => {
    const groups = groupSanFranciscoCommitteeCashByInterest([
      row("a", "Community Alliance", "500"),
      row("b", "Joe Sangirardi for Supervisor 2026", "500"),
      row("c", "Return-only Committee", "-100"),
      row("d", "Fully Refunded Committee", "0"),
    ]).get("c\u0000e")!;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      interest: "unclassified",
      interest_name: "Not yet sorted",
      amount: 500,
      pac_count: 1,
    });
    expect(groups[0]!.pacs.map((p) => p.committee_id)).toEqual(["a"]);
  });

  it("counts all positive net committees before applying display caps", () => {
    const groups = groupSanFranciscoCommitteeCashByInterest(
      Array.from({ length: 8 }, (_, n) =>
        row(String(n), `Community Group ${n}`, `${n + 1}00`),
      ),
    ).get("c\u0000e")!;
    expect(groups[0]).toMatchObject({ amount: 3600, pac_count: 8 });
    expect(groups[0]!.pacs.map((p) => p.amount)).toEqual([
      800, 700, 600, 500, 400,
    ]);
  });

  it("keeps candidate-election scopes independent", () => {
    const groups = groupSanFranciscoCommitteeCashByInterest([
      row("a", "Community Alliance", "500"),
      { ...row("a", "Community Alliance", "700"), election_id: "other" },
    ]);
    expect(groups.get("c\u0000e")![0]!.amount).toBe(500);
    expect(groups.get("c\u0000other")![0]!.amount).toBe(700);
  });
});
