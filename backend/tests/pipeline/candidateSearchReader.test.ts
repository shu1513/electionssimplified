import { describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_SEARCH_LIMIT,
  escapeIlikePattern,
  searchCandidatesByName,
} from "../../src/pipeline/candidates/candidateSearchReader.js";

describe("escapeIlikePattern", () => {
  it("escapes ILIKE metacharacters so user input matches literally", () => {
    expect(escapeIlikePattern("100% _real_ \\name")).toBe("100\\% \\_real\\_ \\\\name");
  });

  it("leaves plain text untouched", () => {
    expect(escapeIlikePattern("Hilary Brown")).toBe("Hilary Brown");
  });
});

describe("searchCandidatesByName", () => {
  it("returns no rows without querying when the input is blank", async () => {
    const query = vi.fn();
    const result = await searchCandidatesByName({ query } as never, "   ");
    expect(result).toEqual({ candidates: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("passes the escaped trimmed query and row limit to the database", async () => {
    const rows = [
      {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        display_name: "Hilary Brown",
        party: "Independent",
        state: "CA",
        current_office: null,
      },
    ];
    const query = vi.fn().mockResolvedValue({ rows });

    const result = await searchCandidatesByName({ query } as never, "  50%_hilar  ");

    expect(result).toEqual({ candidates: rows });
    expect(query).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls[0]!;
    expect(params).toEqual(["50\\%\\_hilar", CANDIDATE_SEARCH_LIMIT, [], ["50\\%\\_hilar"]]);
  });

  it("splits the query into words so a middle initial does not block a match", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await searchCandidatesByName({ query } as never, " John   Smith ");

    const [, params] = query.mock.calls[0]!;
    expect(params).toEqual(["John   Smith", CANDIDATE_SEARCH_LIMIT, [], ["John", "Smith"]]);
  });

  it("passes the ballot district ids that rank on-ballot candidates first", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const districtId = "11111111-1111-4111-8111-111111111111";

    await searchCandidatesByName({ query } as never, "hilar", [districtId]);

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("election.district_id = ANY($3::uuid[])");
    expect(params).toEqual(["hilar", CANDIDATE_SEARCH_LIMIT, [districtId], ["hilar"]]);
  });
});
