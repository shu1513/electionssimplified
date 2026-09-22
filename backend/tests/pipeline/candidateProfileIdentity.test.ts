import { describe, expect, it, vi } from "vitest";

import {
  AmbiguousCandidateIdentityError,
  assertMergedOfficeRoutingConsistent,
  assessWebsiteIdentifier,
  describeUnusableWebsiteIdentifier,
  findOrCreateCandidateFromProfile,
  hasAtLeastOneHardIdentifier,
  isExactNameMatch,
  isPersonalLinkedInProfileUrl,
  isSharedPageWebsiteUrl,
  matchesByHardIdentifier,
  matchesByRegistryIdentifier,
  mergeIdentifierLists,
  mergeProfileSourceLists,
  resolveStoredCandidateParty,
  resolveWebsiteRotationOnMerge,
  stripWebsiteUrlsFromCandidate,
  unionFormerWebsiteUrls,
} from "../../src/pipeline/candidates/candidateProfileIdentity.js";
import type { CandidateProfilePayload } from "../../src/contracts/candidateProfilePayloadContract.js";

function profile(overrides: Partial<CandidateProfilePayload> = {}): CandidateProfilePayload {
  return {
    display_name: "Jane Candidate",
    first_name: "Jane",
    last_name: "Candidate",
    summary: "Candidate summary",
    has_held_public_office: false,
    sources: ["https://example.com/profile"],
    ...overrides,
  };
}

// findOrCreateCandidateFromProfile's first query is always the per-person
// advisory lock; pre-load its response so tests only chain the identity reads.
function identityQueryMock() {
  return vi.fn().mockResolvedValueOnce({ rows: [] });
}

describe("mergeIdentifierLists", () => {
  it("preserves existing ids and appends new distinct incoming ids", () => {
    const merged = mergeIdentifierLists(
      ["S123", "S234"],
      ["S234", "S345"]
    );

    expect(merged).toEqual(["S123", "S234", "S345"]);
  });

  it("dedupes case-insensitively and ignores blanks", () => {
    const merged = mergeIdentifierLists(
      ["  abc-1  "],
      ["ABC-1", "   ", "abc-2"]
    );

    expect(merged).toEqual(["abc-1", "abc-2"]);
  });

  it("returns undefined when both inputs are empty/missing", () => {
    expect(mergeIdentifierLists(undefined, undefined)).toBeUndefined();
    expect(mergeIdentifierLists([], ["   "])).toBeUndefined();
  });
});

describe("mergeProfileSourceLists", () => {
  it("keeps stored sources first and appends new distinct incoming sources", () => {
    expect(
      mergeProfileSourceLists(
        ["https://stored.example/a", "https://both.example/page"],
        ["https://both.example/page", "https://incoming.example/b"]
      )
    ).toEqual(["https://stored.example/a", "https://both.example/page", "https://incoming.example/b"]);
  });

  it("dedupes on the normalized URL, not the raw string", () => {
    // Stored legacy rows predate contract-side normalizeHttpUrl: a trailing
    // slash or hash variant is the same source, and the wave-18 duplicate
    // incident came exactly from re-deriving instead of normalizing.
    expect(
      mergeProfileSourceLists(
        ["https://a.example/page/"],
        ["https://a.example/page", "https://a.example/page#bio"]
      )
    ).toEqual(["https://a.example/page/"]);
  });

  it("keeps URLs that differ only in path or query case — they may be distinct documents", () => {
    // Paths and queries are case-sensitive per RFC 3986; collapsing them
    // would silently discard a source. Scheme and hostname ARE
    // case-insensitive, and URL parsing inside normalizeHttpUrl already
    // lowercases both, so host-case variants still dedupe.
    expect(
      mergeProfileSourceLists(
        ["https://a.example/Bio", "https://a.example/results?Name=Alice"],
        ["https://a.example/bio", "https://a.example/results?name=alice"]
      )
    ).toEqual([
      "https://a.example/Bio",
      "https://a.example/results?Name=Alice",
      "https://a.example/bio",
      "https://a.example/results?name=alice",
    ]);

    expect(
      mergeProfileSourceLists(["HTTPS://EXAMPLE.com/bio"], ["https://example.com/bio"])
    ).toEqual(["HTTPS://EXAMPLE.com/bio"]);
  });

  it("ignores blanks and keeps a non-URL string on its raw form", () => {
    expect(mergeProfileSourceLists(["  ", "not a url"], ["NOT A URL"])).toEqual(["not a url"]);
  });
});

describe("resolveStoredCandidateParty", () => {
  it("uses the roster party for a partisan contest and Nonpartisan otherwise", () => {
    expect(
      resolveStoredCandidateParty({
        includeParty: true,
        rosterParty: "Republican",
        profileParty: "Democratic",
      })
    ).toBe("Republican");
    expect(
      resolveStoredCandidateParty({
        includeParty: false,
        rosterParty: undefined,
        profileParty: undefined,
      })
    ).toBe("Nonpartisan");
  });

  it("canonicalizes the party spelling on the way to storage", () => {
    expect(
      resolveStoredCandidateParty({
        includeParty: true,
        rosterParty: "DEM",
        profileParty: undefined,
      })
    ).toBe("Democratic");
    expect(
      resolveStoredCandidateParty({
        includeParty: true,
        rosterParty: undefined,
        profileParty: "Republican Party",
      })
    ).toBe("Republican");
  });
});

describe("findOrCreateCandidateFromProfile", () => {
  it("refuses to discard a supplied party in a nonpartisan contest", async () => {
    const query = identityQueryMock();

    await expect(
      findOrCreateCandidateFromProfile({
        client: { query } as never,
        profile: profile({ party: "Republican" }),
        state: "WA",
        rosterParty: undefined,
        includeParty: false,
      })
    ).rejects.toThrow(/would discard candidate party/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("inserts a new candidate when no same-name hard-identifier match exists", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"] }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-new", matchedExisting: false });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[1]).toContain("Jane Candidate");
    expect(query.mock.calls[2]?.[1]).toContain("Democratic");
    expect(query.mock.calls[2]?.[1]).toContain("US");
  });

  it("writes current office when inserting a new candidate", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"], current_office: "Governor" }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
    });

    const insertSql = String(query.mock.calls[2]?.[0]);
    expect(insertSql).toContain("current_office");
    expect(insertSql).toContain("profile_sources");
    expect(query.mock.calls[2]?.[1]).toContain(JSON.stringify(["https://example.com/profile"]));
    expect(query.mock.calls[2]?.[1]).toContain("Governor");
  });

  it("reuses an existing same-name candidate when hard identifiers match", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "candidate-existing",
            first_name: "Jane",
            last_name: "Candidate",
            date_of_birth: null,
            twitter_handle: null,
            linkedin_url: null,
            official_website_url: null,
            fec_ids: ["P80000001"],
            state_filing_ids: null,
            current_office: null,
            state: "US",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ fec_ids: ["P80000001"], state_filing_ids: null, current_office: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"] }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.candidates"))).toBe(false);
    expect(String(query.mock.calls[3]?.[0])).toContain("last_researched = now()");
    expect(String(query.mock.calls[3]?.[0])).toContain("profile_sources = $4::jsonb");
  });

  it("adds a first FEC ID to the existing website-matched candidate instead of inserting a duplicate", async () => {
    // Manual no-FEC-ID exception follow-up: the candidate was written with a
    // campaign website only; the FEC ID arrives on a later profile write.
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "candidate-existing",
            first_name: "Jane",
            last_name: "Candidate",
            date_of_birth: null,
            twitter_handle: null,
            linkedin_url: null,
            official_website_url: "https://jane.example",
            fec_ids: null,
            state_filing_ids: null,
            current_office: null,
            state: "OH",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null, current_office: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://jane.example", fec_ids: ["H6OH04999"] }),
      state: "OH",
      rosterParty: "Independent",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.candidates"))).toBe(false);
    expect(JSON.stringify(query.mock.calls[3]?.[1])).toContain("H6OH04999");
  });

  it("fills a blank current office for an existing hard-identifier match", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "candidate-existing",
            first_name: "Jane",
            last_name: "Candidate",
            date_of_birth: null,
            twitter_handle: null,
            linkedin_url: null,
            official_website_url: null,
            fec_ids: ["P80000001"],
            state_filing_ids: null,
            current_office: null,
            state: "US",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ fec_ids: ["P80000001"], state_filing_ids: null, current_office: "  " }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      // has_held_public_office must accompany a current office (contract
      // invariant; the merge guard enforces it too).
      profile: profile({ fec_ids: ["P80000001"], current_office: "Governor", has_held_public_office: true }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
    expect(query).toHaveBeenCalledTimes(4);
    expect(String(query.mock.calls[3]?.[0])).toContain("current_office = CASE");
    expect(query.mock.calls[3]?.[1]).toEqual([
      "candidate-existing",
      JSON.stringify(["P80000001"]),
      null,
      JSON.stringify(["https://example.com/profile"]),
      null,
      false,
      null,
      false,
      null,
      false,
      "Candidate summary",
      false,
      "Governor",
      false,
      // clear flags: no field listed for clearing
      false,
      false,
      false,
      false,
      false,
      // has_held_public_office value + overwrite flag
      true,
      false,
      // effective party + overwrite flag
      "Democratic",
      false,
      // resolved website + former-website archive (nothing stored or incoming)
      null,
      null,
    ]);
  });

  it("does not overwrite a non-blank current office for an existing hard-identifier match", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "candidate-existing",
            first_name: "Jane",
            last_name: "Candidate",
            date_of_birth: null,
            twitter_handle: null,
            linkedin_url: null,
            official_website_url: null,
            fec_ids: ["P80000001"],
            state_filing_ids: null,
            current_office: "Mayor",
            state: "US",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ fec_ids: ["P80000001"], state_filing_ids: null, current_office: "Mayor" }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"], current_office: "Governor", has_held_public_office: true }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
    expect(query).toHaveBeenCalledTimes(4);
    expect(String(query.mock.calls[3]?.[0])).toContain("current_office = CASE");
    expect(String(query.mock.calls[3]?.[0])).toContain("last_researched = now()");
    expect(String(query.mock.calls[3]?.[0])).toContain("profile_sources = $4::jsonb");
    expect(query.mock.calls[3]?.[1]).toEqual([
      "candidate-existing",
      JSON.stringify(["P80000001"]),
      null,
      JSON.stringify(["https://example.com/profile"]),
      null,
      false,
      null,
      false,
      null,
      false,
      "Candidate summary",
      false,
      "Governor",
      false,
      // clear flags: no field listed for clearing
      false,
      false,
      false,
      false,
      false,
      // has_held_public_office value + overwrite flag
      true,
      false,
      // effective party + overwrite flag
      "Democratic",
      false,
      // resolved website + former-website archive (nothing stored or incoming)
      null,
      null,
    ]);
  });

  it("can reuse a same-name candidate from another state when explicitly allowed and hard identifiers match", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "candidate-home-state",
            first_name: "Jane",
            last_name: "Candidate",
            date_of_birth: null,
            twitter_handle: null,
            linkedin_url: null,
            official_website_url: null,
            fec_ids: ["P80000001"],
            state_filing_ids: null,
            current_office: null,
            state: "CA",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ fec_ids: ["P80000001"], state_filing_ids: null, current_office: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"] }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
      allowCrossStateHardIdentifierMatch: true,
    });

    expect(result).toEqual({ candidateId: "candidate-home-state", matchedExisting: true });
    expect(String(query.mock.calls[1]?.[0])).not.toContain("AND state = $3");
    expect(query.mock.calls[1]?.[1]).toEqual(["Jane", "Candidate", "Jane Candidate", null]);
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.candidates"))).toBe(false);
  });

  it("keeps default candidate matching scoped to the requested state", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new-us" }], rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"] }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-new-us", matchedExisting: false });
    expect(String(query.mock.calls[1]?.[0])).toContain("AND state = $3");
    expect(query.mock.calls[1]?.[1]).toEqual(["Jane", "Candidate", "US", "Jane Candidate", null]);
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.candidates"))).toBe(true);
  });
});


describe("findOrCreateCandidateFromProfile field persistence and election-scoped matching", () => {
  const existingRow = {
    id: "candidate-existing",
    first_name: "Jane",
    last_name: "Candidate",
    date_of_birth: null,
    twitter_handle: null,
    linkedin_url: null,
    official_website_url: "https://old-site.example",
    fec_ids: null,
    state_filing_ids: null,
    current_office: null,
    state: "OH",
  };

  it("fills empty scalar columns on a matched re-write (fill-if-empty, never clobber)", async () => {
    const query = identityQueryMock()
      // loadSameNameCandidates
      .mockResolvedValueOnce({ rows: [{ ...existingRow, linkedin_url: null }] })
      // merge lock SELECT
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null }] })
      // merge UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({
        official_website_url: "https://old-site.example",
        linkedin_url: "https://www.linkedin.com/in/jane",
      }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result.matchedExisting).toBe(true);
    const updateSql = String(query.mock.calls[3]?.[0]);
    expect(updateSql).toContain("linkedin_url = CASE");
    // The volatile website is resolved TS-side and written directly.
    expect(updateSql).toContain("official_website_url = $24::text");
    expect(updateSql).toContain("former_website_urls = $25::jsonb");
    expect(updateSql).toContain("summary = CASE");
    const params = query.mock.calls[3]?.[1] as unknown[];
    // linkedin value present, overwrite false: fills only because column is empty
    expect(params).toContain("https://www.linkedin.com/in/jane");
  });

  it("matches a candidate already linked to the election when the sole hard identifier changed", async () => {
    const query = identityQueryMock()
      // loadSameNameCandidates: same-name row exists but hard identifiers no longer match
      .mockResolvedValueOnce({ rows: [existingRow] })
      // election-scoped display_name lookup
      .mockResolvedValueOnce({ rows: [{ id: "candidate-existing" }] })
      // merge lock SELECT
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null }] })
      // merge UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://brand-new-site.example" }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
      matchByLinkedElectionId: "election-1",
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
    const electionLookupSql = String(query.mock.calls[2]?.[0]);
    expect(electionLookupSql).toContain("candidate_elections");
    expect(electionLookupSql).toContain("running_mate_candidate_id");
  });

  it("replaces a non-empty stored value only for fields listed in overwriteProfileFields", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [{ ...existingRow, official_website_url: "https://old-site.example" }] })
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://old-site.example", summary: "Corrected summary" }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
      overwriteProfileFields: new Set(["summary"]),
    });

    const params = query.mock.calls[3]?.[1] as unknown[];
    // summary value + its overwrite flag true
    const summaryIndex = params.indexOf("Corrected summary");
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(params[summaryIndex + 1]).toBe(true);
    // resolved website rides the dedicated tail slot, not an overwrite pair
    expect(params[23]).toBe("https://old-site.example");
  });

  it("unions stored profile_sources with the payload's on a matched re-write", async () => {
    // The merge UPDATE keeps stored facts (fill-if-empty scalars, additive
    // id lists), so a narrow correction payload must not wipe the sources
    // supporting them — six wave-19/20 corrections had to hand-build
    // supersets because the old write replaced the list unconditionally.
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [existingRow] })
      .mockResolvedValueOnce({
        rows: [{
          fec_ids: null,
          state_filing_ids: null,
          profile_sources: ["https://stored.example/bio", "https://example.com/profile/"],
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://old-site.example" }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
    });

    const params = query.mock.calls[3]?.[1] as unknown[];
    // $4 = profile_sources; the payload's "https://example.com/profile" is
    // the stored trailing-slash variant, deduped on the normalized URL.
    expect(params[3]).toBe(
      JSON.stringify(["https://stored.example/bio", "https://example.com/profile/"])
    );
  });

  it("replaces profile_sources with exactly the payload's list when explicitly listed", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [existingRow] })
      .mockResolvedValueOnce({
        rows: [{
          fec_ids: null,
          state_filing_ids: null,
          profile_sources: ["https://dead-host.example/bio"],
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://old-site.example" }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
      overwriteProfileFields: new Set(["profile_sources"]),
    });

    const params = query.mock.calls[3]?.[1] as unknown[];
    expect(params[3]).toBe(JSON.stringify(["https://example.com/profile"]));
  });

  it("retracts a stored false routing answer via replace with an explicit payload null", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [existingRow] })
      .mockResolvedValueOnce({
        rows: [{
          fec_ids: null,
          state_filing_ids: null,
          current_office: null,
          has_held_public_office: false,
          party: "Democratic",
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      // The stored false was manufactured from office-history-silent sources;
      // the repair payload answers null ("sources don't cover it"), not a
      // freshly guessed boolean.
      profile: profile({ official_website_url: "https://old-site.example", has_held_public_office: null }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
      overwriteProfileFields: new Set(["has_held_public_office"]),
    });

    const updateSql = String(query.mock.calls[3]?.[0]);
    // The overwrite branch must take the payload value even when NULL — an
    // IS NOT NULL guard here would turn the manufactured-false repair into a
    // silent no-op.
    expect(updateSql).toContain("WHEN $21::boolean THEN $20::boolean");
    const params = query.mock.calls[3]?.[1] as unknown[];
    // has_held_public_office value + overwrite flag
    expect(params.slice(19, 21)).toEqual([null, true]);
  });

  it("replaces a stored party only when party is explicitly listed", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [{ ...existingRow, party: "Nonpartisan" }] })
      .mockResolvedValueOnce({
        rows: [{
          fec_ids: null,
          state_filing_ids: null,
          current_office: null,
          has_held_public_office: false,
          party: "Nonpartisan",
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://old-site.example" }),
      state: "OH",
      rosterParty: "Republican",
      includeParty: true,
      overwriteProfileFields: new Set(["party"]),
    });

    const updateSql = String(query.mock.calls[3]?.[0]);
    const params = query.mock.calls[3]?.[1] as unknown[];
    expect(updateSql).toContain("party = CASE");
    expect(updateSql).toContain("WHEN party IS NOT NULL AND length(trim(party)) = 0 THEN $22::text");
    expect(updateSql).not.toContain("WHEN party IS NULL OR");
    expect(params.slice(21, 23)).toEqual(["Republican", true]);
  });

  it("never overwrites a stored value with a blank string, even for overwrite-listed fields", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [{ ...existingRow, official_website_url: "https://old-site.example" }] })
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      // Contract-parsed profiles cannot carry blank strings, but the merge is
      // exported and must stay safe for non-contract callers.
      profile: { ...profile({ official_website_url: "https://old-site.example" }), summary: "  " },
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
      overwriteProfileFields: new Set(["summary"]),
    });

    const updateSql = String(query.mock.calls[3]?.[0]);
    // The overwrite branch requires a non-blank incoming value.
    expect(updateSql).toContain("length(trim($11::text)) > 0");
  });

  it("clears listed fields to NULL on a matched re-write, winning over fill-if-empty", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [{ ...existingRow, current_office: "Attorney, Noble Law" }] })
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      // Payload deliberately carries no current_office: the wrapper refuses
      // clear+supply for the same field, so the cleared field arrives absent.
      profile: profile({ official_website_url: "https://old-site.example" }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
      clearProfileFields: new Set(["current_office"]),
    });

    expect(result.matchedExisting).toBe(true);
    const updateSql = String(query.mock.calls[3]?.[0]);
    // The clear branch leads every scalar CASE so it wins over overwrite and
    // fill-if-empty alike.
    expect(updateSql).toContain("current_office = CASE\n            WHEN $19::boolean THEN NULL");
    const params = query.mock.calls[3]?.[1] as unknown[];
    // The five per-field clear flags (declaration order, only current_office
    // set) are followed by the has_held_public_office value + overwrite flag.
    expect(params.slice(14, 21)).toEqual([false, false, false, false, true, false, false]);
  });

  it("passes clear flags as false for every field when clearing is not requested", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [existingRow] })
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://old-site.example" }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
    });

    const params = query.mock.calls[3]?.[1] as unknown[];
    expect(params.slice(14, 21)).toEqual([false, false, false, false, false, false, false]);
  });

  it("throws when two same-name candidates are linked to the election", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [existingRow] })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-a" }, { id: "candidate-b" }] });

    await expect(
      findOrCreateCandidateFromProfile({
        client: { query } as never,
        profile: profile({ official_website_url: "https://brand-new-site.example" }),
        state: "OH",
        rosterParty: "Democratic",
        includeParty: true,
        matchByLinkedElectionId: "election-1",
      })
    ).rejects.toThrow(/Multiple candidates named/);
  });
});

describe("assertMergedOfficeRoutingConsistent", () => {
  it("refuses filling has_held_public_office=false against a stored current office", () => {
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile(),
        storedCurrentOffice: "Mayor",
        storedHasHeldPublicOffice: null,
      })
    ).toThrow(/contradictory candidate row/);
  });

  it("refuses filling a blank office while a stored false routing answer survives", () => {
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile({ current_office: "Mayor", has_held_public_office: true }),
        storedCurrentOffice: null,
        storedHasHeldPublicOffice: false,
      })
    ).toThrow(/--replace-profile-fields has_held_public_office/);
  });

  it("accepts the merge when the office is being cleared or replaced away", () => {
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile(),
        storedCurrentOffice: "Attorney, Noble Law",
        storedHasHeldPublicOffice: null,
        clearFields: new Set(["current_office"]),
      })
    ).not.toThrow();
  });

  it("accepts an overwrite that corrects the stale false answer", () => {
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile({ current_office: "Mayor", has_held_public_office: true }),
        storedCurrentOffice: null,
        storedHasHeldPublicOffice: false,
        overwriteFields: new Set(["has_held_public_office"]),
      })
    ).not.toThrow();
  });

  it("accepts a replace-with-null retraction of a manufactured false", () => {
    // The repair pass for a false asserted from office-history-silent
    // sources: payload answers null under --replace-profile-fields, and the
    // effective row becomes office-less + unanswered, which is consistent.
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile({ has_held_public_office: null }),
        storedCurrentOffice: null,
        storedHasHeldPublicOffice: false,
        overwriteFields: new Set(["has_held_public_office"]),
      })
    ).not.toThrow();
  });

  it("refuses a null-retraction while a stored current office would survive", () => {
    // The office itself proves the answer is true — retracting beside it
    // either erases a provable fact or leaves a stale office standing.
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile({ has_held_public_office: null }),
        storedCurrentOffice: "Mayor",
        storedHasHeldPublicOffice: true,
        overwriteFields: new Set(["has_held_public_office"]),
      })
    ).toThrow(/refuses to retract has_held_public_office to null while current_office/);
  });

  it("accepts a null-retraction when the stale office is cleared in the same write", () => {
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile({ has_held_public_office: null }),
        storedCurrentOffice: "Attorney, Noble Law",
        storedHasHeldPublicOffice: true,
        overwriteFields: new Set(["has_held_public_office"]),
        clearFields: new Set(["current_office"]),
      })
    ).not.toThrow();
  });

  it("accepts a plain null answer that merely fails to repair a legacy office+NULL row", () => {
    // Legacy rows hold current_office with a NULL routing answer wholesale.
    // A pass answering null from office-history-silent sources (no overwrite)
    // leaves both columns untouched and must still be able to fill the row's
    // other empty fields — only an active retraction is refused.
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile({ has_held_public_office: null }),
        storedCurrentOffice: "Mayor",
        storedHasHeldPublicOffice: null,
      })
    ).not.toThrow();
  });

  it("accepts consistent states: officeholder with office, never-held without one", () => {
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile({ current_office: "Governor", has_held_public_office: true }),
        storedCurrentOffice: "Governor",
        storedHasHeldPublicOffice: true,
      })
    ).not.toThrow();
    expect(() =>
      assertMergedOfficeRoutingConsistent({
        profile: profile(),
        storedCurrentOffice: null,
        storedHasHeldPublicOffice: null,
      })
    ).not.toThrow();
  });
});

describe("findOrCreateCandidateFromProfile identity hardening", () => {
  const duplicateRows = ["candidate-a", "candidate-b"].map((id) => ({
    id,
    first_name: "Jane",
    last_name: "Candidate",
    date_of_birth: null,
    twitter_handle: null,
    linkedin_url: null,
    official_website_url: null,
    fec_ids: ["P80000001"],
    state_filing_ids: null,
    current_office: null,
    state: "US",
  }));

  it("throws AmbiguousCandidateIdentityError instead of inserting when several rows match hard identifiers", async () => {
    const query = identityQueryMock().mockResolvedValueOnce({ rows: duplicateRows });

    await expect(
      findOrCreateCandidateFromProfile({
        client: { query } as never,
        profile: profile({ fec_ids: ["P80000001"] }),
        state: "US",
        rosterParty: "Democratic",
        includeParty: true,
      })
    ).rejects.toBeInstanceOf(AmbiguousCandidateIdentityError);

    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.candidates"))).toBe(false);
  });

  it("takes the per-person advisory lock before reading candidate identity", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"] }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
    });

    const lockSql = String(query.mock.calls[0]?.[0]);
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0]?.[1]).toEqual(["jane candidate"]);
    expect(String(query.mock.calls[1]?.[0])).toContain("FROM public.candidates");
  });
});

describe("website rotation (campaign sites change between races)", () => {
  const row = {
    id: "candidate-existing",
    first_name: "Jane",
    last_name: "Candidate",
    date_of_birth: null,
    twitter_handle: null,
    linkedin_url: null,
    official_website_url: "https://jane2026.example",
    former_website_urls: null as unknown,
    fec_ids: null,
    state_filing_ids: null,
    current_office: null,
    state: "OH",
  };

  it("matches on a former website URL — the old campaign site still identifies the person", () => {
    const matched = matchesByHardIdentifier(
      profile({ official_website_url: "https://jane2024.example/" }),
      { ...row, former_website_urls: ["https://jane2024.example"] }
    );
    expect(matched).toBe(true);
  });

  it("does not match two junk (non-URL) LinkedIn values", () => {
    const matched = matchesByHardIdentifier(
      profile({ linkedin_url: "not a url" }),
      { ...row, official_website_url: null, linkedin_url: "also not a url" }
    );
    expect(matched).toBe(false);
  });

  it("does not match two junk (non-URL) website values", () => {
    const matched = matchesByHardIdentifier(
      profile({ official_website_url: "not a url" }),
      { ...row, official_website_url: "also not a url" }
    );
    expect(matched).toBe(false);
  });

  it("replaces a differing stored website on a matched re-write and archives the old one", async () => {
    const query = identityQueryMock()
      // loadSameNameCandidates: matched via FEC id, stored site is the old race's
      .mockResolvedValueOnce({
        rows: [{ ...row, official_website_url: "https://jane2024.example", fec_ids: ["P80000001"] }],
      })
      // merge lock SELECT re-reads the stored site under FOR UPDATE
      .mockResolvedValueOnce({
        rows: [{
          fec_ids: ["P80000001"],
          state_filing_ids: null,
          official_website_url: "https://jane2024.example",
          former_website_urls: null,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ fec_ids: ["P80000001"], official_website_url: "https://jane2026.example" }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
    });

    const params = query.mock.calls[3]?.[1] as unknown[];
    expect(params[23]).toBe("https://jane2026.example");
    expect(params[24]).toBe(JSON.stringify(["https://jane2024.example"]));
  });

  describe("resolveWebsiteRotationOnMerge", () => {
    it("rotates a differing incoming URL in and archives the stored one", () => {
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://jane2024.example",
          storedFormerWebsites: [],
          incomingWebsite: "https://jane2026.example",
          overwrite: false,
          clear: false,
        })
      ).toEqual({
        website: "https://jane2026.example",
        formerWebsites: ["https://jane2024.example"],
      });
    });

    it("keeps the stored URL when the incoming one is the same after normalization", () => {
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://jane.example",
          storedFormerWebsites: ["https://old.example"],
          incomingWebsite: "https://jane.example/#home",
          overwrite: false,
          clear: false,
        })
      ).toEqual({ website: "https://jane.example", formerWebsites: ["https://old.example"] });
    });

    it("keeps the stored URL when the payload carries none", () => {
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://jane.example",
          storedFormerWebsites: [],
          incomingWebsite: undefined,
          overwrite: false,
          clear: false,
        })
      ).toEqual({ website: "https://jane.example", formerWebsites: [] });
    });

    it("fills an empty stored URL without archiving anything", () => {
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: null,
          storedFormerWebsites: [],
          incomingWebsite: "https://jane.example",
          overwrite: false,
          clear: false,
        })
      ).toEqual({ website: "https://jane.example", formerWebsites: [] });
    });

    it("keeps the stored site when the incoming URL is an archived former site (stale-replay guard)", () => {
      // A URL is only in the archive because a LATER write displaced it, so
      // a payload carrying it (retried job, re-run of an old research file)
      // is older than the row: it matches the person but must not revert the
      // newer stored site.
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://jane2026.example",
          storedFormerWebsites: ["https://jane2024.example"],
          incomingWebsite: "https://jane2024.example/",
          overwrite: false,
          clear: false,
        })
      ).toEqual({
        website: "https://jane2026.example",
        formerWebsites: ["https://jane2024.example"],
      });
    });

    it("replace (overwrite) is the sanctioned path back to an archived URL", () => {
      // Genuine return to an earlier site: the operator names the field. The
      // reverted-to URL leaves the archive; the displaced URL is dropped, not
      // archived (replace never archives).
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://jane2026.example",
          storedFormerWebsites: ["https://jane2024.example"],
          incomingWebsite: "https://jane2024.example",
          overwrite: true,
          clear: false,
        })
      ).toEqual({
        website: "https://jane2024.example",
        formerWebsites: [],
      });
    });

    it("replace (overwrite) swaps the URL WITHOUT archiving the wrong stored value", () => {
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://wrong-person.example",
          storedFormerWebsites: ["https://old.example"],
          incomingWebsite: "https://jane.example",
          overwrite: true,
          clear: false,
        })
      ).toEqual({ website: "https://jane.example", formerWebsites: ["https://old.example"] });
    });

    it("clear drops the stored URL without archiving it", () => {
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://wrong-person.example",
          storedFormerWebsites: ["https://old.example"],
          incomingWebsite: undefined,
          overwrite: false,
          clear: true,
        })
      ).toEqual({ website: null, formerWebsites: ["https://old.example"] });
    });

    it("dedupes the archive on the normalized URL", () => {
      expect(
        resolveWebsiteRotationOnMerge({
          storedWebsite: "https://jane2024.example",
          storedFormerWebsites: ["https://jane2024.example/"],
          incomingWebsite: "https://jane2026.example",
          overwrite: false,
          clear: false,
        })
      ).toEqual({
        website: "https://jane2026.example",
        formerWebsites: ["https://jane2024.example/"],
      });
    });
  });

  describe("unionFormerWebsiteUrls", () => {
    it("folds the duplicate's current and former sites into the survivor's archive", () => {
      expect(
        unionFormerWebsiteUrls({
          survivorCurrentWebsite: "https://jane2026.example",
          survivorFormerWebsites: ["https://jane2022.example"],
          duplicateCurrentWebsite: "https://jane2024.example",
          duplicateFormerWebsites: ["https://jane2022.example/"],
        })
      ).toEqual(["https://jane2022.example", "https://jane2024.example"]);
    });

    it("keeps the survivor's effective current site out of the archive", () => {
      expect(
        unionFormerWebsiteUrls({
          survivorCurrentWebsite: "https://jane2026.example",
          survivorFormerWebsites: [],
          duplicateCurrentWebsite: "https://jane2026.example/",
          duplicateFormerWebsites: [],
        })
      ).toEqual([]);
    });
  });
});

describe("name-variant identity (stored name parts differ from the payload's)", () => {
  // Primary-stage row split by a roster: "Jimmie Wilson Jr." stored as
  // first_name "Jimmie" / last_name "Jr." — the live shape that minted a
  // duplicate in the November 2026 legislative run.
  const baseRow = {
    id: "candidate-existing",
    first_name: "Chris",
    last_name: "Venable",
    date_of_birth: null,
    twitter_handle: null,
    linkedin_url: null,
    official_website_url: null,
    former_website_urls: null as unknown,
    fec_ids: null,
    state_filing_ids: null,
    current_office: null,
    state: "MI",
  };
  const variantProfile = () =>
    profile({ display_name: "Chris Venable", first_name: "Christopher", last_name: "Venable" });

  it("loads rows sharing either name part or the display name, scoped to the state", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: variantProfile(),
      state: "MI",
      rosterParty: "Democratic",
      includeParty: true,
    });

    const poolSql = String(query.mock.calls[1]?.[0]);
    expect(poolSql).toContain("lower(first_name) = lower($1)");
    expect(poolSql).toContain("OR lower(last_name) = lower($2)");
    expect(poolSql).toContain("OR lower(trim(display_name)) = lower(trim($4))");
    expect(poolSql).toContain("AND state = $3");
    expect(poolSql).toContain("lower(rtrim(official_website_url, '/')) = lower(rtrim($5::text, '/'))");
    expect(query.mock.calls[1]?.[1]).toEqual(["Christopher", "Venable", "MI", "Chris Venable", null]);
  });

  it("matches a same-last-name row on a shared state filing id and does not insert", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [{ ...baseRow, state_filing_ids: ["0613800"] }] })
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: ["0613800"], current_office: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: { ...variantProfile(), state_filing_ids: ["0613800"] },
      state: "MI",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.candidates"))).toBe(false);
  });

  it("matches a same-first-name row (suffix stored as last_name) on a shared FEC id", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [{ ...baseRow, first_name: "Jimmie", last_name: "Jr.", fec_ids: ["H6MI13001"] }],
      })
      .mockResolvedValueOnce({ rows: [{ fec_ids: ["H6MI13001"], state_filing_ids: null, current_office: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({
        display_name: "Jimmie Wilson Jr.",
        first_name: "Jimmie",
        last_name: "Wilson",
        fec_ids: ["H6MI13001"],
      }),
      state: "MI",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
  });

  it("does NOT match a name-variant row on a shared website alone (slate and family sites)", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [{ ...baseRow, first_name: "Bob", last_name: "White", official_website_url: "https://whites.example" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({
        display_name: "Cathy White",
        first_name: "Cathy",
        last_name: "White",
        official_website_url: "https://whites.example",
      }),
      state: "MD",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-new", matchedExisting: false });
  });

  it("does NOT match a name-variant row on a shared birth date alone", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [{ ...baseRow, first_name: "Ann", last_name: "Twin", date_of_birth: "1980-01-01" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({
        display_name: "Beth Twin",
        first_name: "Beth",
        last_name: "Twin",
        date_of_birth: "1980-01-01",
      }),
      state: "OH",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-new", matchedExisting: false });
  });

  it("still matches an exact-name row on a shared website (weak identifiers keep the exact-name rule)", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [{ ...baseRow, first_name: "Cathy", last_name: "White", official_website_url: "https://whites.example" }],
      })
      .mockResolvedValueOnce({ rows: [{ fec_ids: null, state_filing_ids: null, current_office: null }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({
        display_name: "Cathy White",
        first_name: "Cathy",
        last_name: "White",
        official_website_url: "https://whites.example",
      }),
      state: "MD",
      rosterParty: "Democratic",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
  });

  it("surfaces existing duplicates: an exact-name website match plus a variant filing-id match is ambiguous", async () => {
    const query = identityQueryMock().mockResolvedValueOnce({
      rows: [
        { ...baseRow, id: "candidate-a", first_name: "Christopher", official_website_url: "https://venable.example" },
        { ...baseRow, id: "candidate-b", first_name: "Chris", state_filing_ids: ["0613800"] },
      ],
    });

    await expect(
      findOrCreateCandidateFromProfile({
        client: { query } as never,
        profile: profile({
          display_name: "Chris Venable",
          first_name: "Christopher",
          last_name: "Venable",
          official_website_url: "https://venable.example",
          state_filing_ids: ["0613800"],
        }),
        state: "MI",
        rosterParty: "Democratic",
        includeParty: true,
      })
    ).rejects.toBeInstanceOf(AmbiguousCandidateIdentityError);
    expect(query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.candidates"))).toBe(false);
  });

  it("isExactNameMatch compares both parts case-insensitively", () => {
    const p = profile({ first_name: "Chris", last_name: "Venable" });
    expect(isExactNameMatch(p, { ...baseRow, first_name: "CHRIS", last_name: "venable" })).toBe(true);
    expect(isExactNameMatch(p, { ...baseRow, first_name: "Christopher" })).toBe(false);
    expect(isExactNameMatch(p, { ...baseRow, last_name: "Jr." })).toBe(false);
  });

  it("matchesByRegistryIdentifier trusts linkedin, FEC and state filing ids only", () => {
    const p = profile({
      linkedin_url: "https://www.linkedin.com/in/chris-venable/",
      fec_ids: ["H6MI13001"],
      state_filing_ids: ["0613800"],
      official_website_url: "https://venable.example",
      twitter_handle: "@venable",
      date_of_birth: "1980-01-01",
    });
    const mi = { state: "MI" };
    expect(matchesByRegistryIdentifier(p, { ...baseRow, linkedin_url: "https://www.linkedin.com/in/chris-venable" }, mi)).toBe(true);
    expect(matchesByRegistryIdentifier(p, { ...baseRow, fec_ids: ["h6mi13001"] }, mi)).toBe(true);
    expect(matchesByRegistryIdentifier(p, { ...baseRow, state_filing_ids: [" 0613800 "] }, mi)).toBe(true);
    expect(matchesByRegistryIdentifier(p, { ...baseRow, official_website_url: "https://venable.example" }, mi)).toBe(false);
    expect(matchesByRegistryIdentifier(p, { ...baseRow, twitter_handle: "venable" }, mi)).toBe(false);
    expect(matchesByRegistryIdentifier(p, { ...baseRow, date_of_birth: "1980-01-01" }, mi)).toBe(false);
    // The full hard-identifier check still accepts the weak ones.
    expect(matchesByHardIdentifier(p, { ...baseRow, official_website_url: "https://venable.example" })).toBe(true);
  });

  it("a state filing id only counts for a row in the payload's state", () => {
    const p = profile({ state_filing_ids: ["0613800"] });
    const wiRow = { ...baseRow, state: "WI", state_filing_ids: ["0613800"] };
    expect(matchesByRegistryIdentifier(p, wiRow, { state: "MI" })).toBe(false);
    expect(matchesByRegistryIdentifier(p, wiRow, { state: "WI" })).toBe(true);
    // Exact-name matching is unchanged: no state scoping there.
    expect(matchesByHardIdentifier(p, wiRow)).toBe(true);
  });

  it("a company or school LinkedIn page is not a registry identifier", () => {
    const company = "https://www.linkedin.com/company/acme-corp";
    const p = profile({ linkedin_url: company });
    expect(matchesByRegistryIdentifier(p, { ...baseRow, linkedin_url: company }, { state: "MI" })).toBe(false);
    // Exact-name matching still accepts it, as before.
    expect(matchesByHardIdentifier(p, { ...baseRow, linkedin_url: company })).toBe(true);
    expect(isPersonalLinkedInProfileUrl("https://www.linkedin.com/in/jane-doe/")).toBe(true);
    expect(isPersonalLinkedInProfileUrl("https://linkedin.com/in/jane-doe")).toBe(true);
    expect(isPersonalLinkedInProfileUrl("https://www.linkedin.com/company/acme")).toBe(false);
    expect(isPersonalLinkedInProfileUrl("https://www.linkedin.com/school/mit")).toBe(false);
    expect(isPersonalLinkedInProfileUrl("https://www.linkedin.com/in/")).toBe(false);
    expect(isPersonalLinkedInProfileUrl("https://evil.example/in/jane")).toBe(false);
    expect(isPersonalLinkedInProfileUrl("not a url")).toBe(false);
  });

  it("cross-state pool: a name-variant row from another state does not match on a state filing id", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [{ ...baseRow, first_name: "Jane", last_name: "Other", state: "WI", state_filing_ids: ["0613800"] }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ state_filing_ids: ["0613800"] }),
      state: "US",
      rosterParty: "Democratic",
      includeParty: true,
      allowCrossStateHardIdentifierMatch: true,
    });

    expect(result).toEqual({ candidateId: "candidate-new", matchedExisting: false });
  });
});

describe("shared-page websites are not hard identifiers", () => {
  const sharedPages = [
    "https://www.tarrantcountytx.gov/en/county/about-tarrant/elected-county-officials.html",
    "https://votetravis.gov/candidates-office-holders/elected-officials",
    "https://elections.maryland.gov/elections/2026/primary_results/gen_results_2026_by_county_13_P.html",
    "https://www.popecountyar.gov/justices-of-peace",
    "https://www.mncourts.gov/About-The-Courts/Overview/JudicialDirectory.aspx?d=9",
    "https://www.co.panola.tx.us/Directory.aspx",
    "https://www.dcboe.org/elections/2026-elections",
    "https://www.co.live-oak.tx.us/page/liveoak.Elected%20Officials",
    "https://www.co.newton.tx.us/upload/page/3518/docs/Elected%20Officials%20and%20Terms%20Updated%2011%202025.pdf",
    "https://web.sos.ky.gov/CandidateFilings/countyfilings.aspx?id=8",
    "https://www.lakecountyil.gov/2336/Board-Members",
    "https://www.co.montague.tx.us/page/montague.Commissioners.Court",
    "https://www.ppsb.org/apps/pages/index.jsp?pREC_ID=staff&type=d&uREC_ID=169137",
    "https://www.wyoleg.gov/Legislators/2026/H",
    "https://hoodcounty.texas.gov/departments/elections_administration/index.php",
    "https://www.wfyi.org/education/2026-09-11/voter-guide-msd-wayne-township-school-board-2026",
    "https://candidates.sos.mn.gov/CandidateFilingResults.aspx?candidateid=0&county=23",
  ];
  const ownSites = [
    "https://patriciaforphoenix.com",
    "https://www.jenniferbalkcom.com/",
    "https://carver.vote",
    "https://mgaleg.maryland.gov/mgawebsite/Members/Details/arentz01",
    "https://wapp.capitol.tn.gov/apps/LegislatorInfo/Member?district=H86&ga=114",
    "https://www.senate.mn.gov/members/member_bio.html?mem_id=1234",
    "https://www.legis.iowa.gov/legislators/legislator?personID=123",
    "https://clyburn.house.gov/about/official-biography",
    "https://clyburn.house.gov",
    "https://www.schumer.senate.gov/",
    "https://burke4congress.us",
    // A bare shared root is not visible from the URL alone; the stored-holder check catches it.
    "https://www.nacogdochesco.gov",
    "https://janedoe.com/about",
    "https://www.facebook.com/janeforjudge",
  ];

  it("recognizes officials directories, results pages, court and board rosters", () => {
    for (const url of sharedPages) {
      expect(isSharedPageWebsiteUrl(url), url).toBe(true);
    }
  });

  it("leaves personal campaign sites, a member's own bare host, and a legislator's member page alone", () => {
    for (const url of ownSites) {
      expect(isSharedPageWebsiteUrl(url), url).toBe(false);
    }
    expect(isSharedPageWebsiteUrl("not a url")).toBe(false);
  });

  it("hasAtLeastOneHardIdentifier ignores a shared-page website by default", () => {
    expect(hasAtLeastOneHardIdentifier(profile({ official_website_url: sharedPages[0] }))).toBe(false);
    expect(hasAtLeastOneHardIdentifier(profile({ official_website_url: ownSites[0] }))).toBe(true);
    expect(
      hasAtLeastOneHardIdentifier(profile({ official_website_url: ownSites[0] }), { websiteCountsAsIdentifier: false })
    ).toBe(false);
    expect(
      hasAtLeastOneHardIdentifier(profile({ official_website_url: sharedPages[0], state_filing_ids: ["123"] }))
    ).toBe(true);
  });

  const row = {
    id: "candidate-existing",
    first_name: "Jane",
    last_name: "Candidate",
    display_name: "Jane Candidate",
    date_of_birth: null,
    twitter_handle: null,
    linkedin_url: null,
    official_website_url: sharedPages[0]!,
    former_website_urls: null as unknown,
    fec_ids: null,
    state_filing_ids: null,
    current_office: null,
    state: "TX",
  };

  it("matchesByHardIdentifier does not match an exact-name row on a shared page", () => {
    expect(matchesByHardIdentifier(profile({ official_website_url: sharedPages[0] }), row)).toBe(false);
    expect(
      matchesByHardIdentifier(profile({ official_website_url: "https://jane.example" }), {
        ...row,
        official_website_url: "https://jane.example",
      })
    ).toBe(true);
    expect(
      matchesByHardIdentifier(
        profile({ official_website_url: "https://jane.example" }),
        { ...row, official_website_url: "https://jane.example" },
        { websiteCountsAsIdentifier: false }
      )
    ).toBe(false);
  });

  it("assessWebsiteIdentifier refuses a URL another candidate under a different name holds", () => {
    const other = { ...row, id: "candidate-other", first_name: "Bob", last_name: "Other", display_name: "Bob Other", official_website_url: "https://ticket.example" };
    const assessment = assessWebsiteIdentifier(profile({ official_website_url: "https://ticket.example/" }), [other]);
    expect(assessment).toEqual({
      url: "https://ticket.example/",
      usable: false,
      reason: "held_by_other_candidate",
      holders: [{ id: "candidate-other", displayName: "Bob Other" }],
    });
    expect(describeUnusableWebsiteIdentifier(assessment)).toContain("Bob Other (candidate-other)");
    expect(describeUnusableWebsiteIdentifier(assessment)).toContain("--allow-no-hard-identifier");
  });

  it("assessWebsiteIdentifier also reads former websites and ignores same-name holders", () => {
    const formerHolder = { ...row, id: "candidate-other", display_name: "Bob Other", first_name: "Bob", last_name: "Other", official_website_url: null, former_website_urls: ["https://ticket.example"] };
    expect(assessWebsiteIdentifier(profile({ official_website_url: "https://ticket.example" }), [formerHolder]).reason).toBe(
      "held_by_other_candidate"
    );
    const sameName = { ...row, id: "candidate-same", display_name: "Jane Candidate", official_website_url: "https://jane.example" };
    expect(assessWebsiteIdentifier(profile({ official_website_url: "https://jane.example" }), [sameName])).toEqual({
      url: "https://jane.example",
      usable: true,
      reason: null,
      holders: [],
    });
    // Same person under a name variant (punctuation, ordering) is not "another candidate".
    const variant = { ...row, id: "candidate-variant", first_name: "Jane", last_name: "Candidate Jr.", display_name: "Jane Candidate, Jr.", official_website_url: "https://jane.example" };
    expect(assessWebsiteIdentifier(profile({ display_name: "Jane Candidate Jr", official_website_url: "https://jane.example" }), [variant]).usable).toBe(true);
    expect(assessWebsiteIdentifier(profile({ official_website_url: sharedPages[0] }), []).reason).toBe("shared_page");
    expect(assessWebsiteIdentifier(profile(), []).reason).toBeNull();
    expect(describeUnusableWebsiteIdentifier(assessWebsiteIdentifier(profile(), []))).toBeNull();
  });

  it("findOrCreateCandidateFromProfile inserts instead of matching an exact-name row on a shared page", async () => {
    const query = identityQueryMock()
      // pool: the exact-name row and 38 others all hold the county page
      .mockResolvedValueOnce({
        rows: [row, { ...row, id: "candidate-other", first_name: "Bob", last_name: "Other", display_name: "Bob Other" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: sharedPages[0] }),
      state: "TX",
      rosterParty: "Republican",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-new", matchedExisting: false });
    expect(query.mock.calls[1]?.[1]?.[4]).toBe(sharedPages[0]);
  });

  it("findOrCreateCandidateFromProfile does not match on a personal site another candidate holds", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({
        rows: [
          { ...row, official_website_url: "https://ticket.example" },
          { ...row, id: "candidate-lead", first_name: "Bob", last_name: "Lead", display_name: "Bob Lead", official_website_url: "https://ticket.example" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "candidate-new" }], rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://ticket.example" }),
      state: "TX",
      rosterParty: "Republican",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-new", matchedExisting: false });
  });

  it("findOrCreateCandidateFromProfile still matches an exact-name row on a personal site nobody else holds", async () => {
    const query = identityQueryMock()
      .mockResolvedValueOnce({ rows: [{ ...row, official_website_url: "https://jane.example" }] })
      .mockResolvedValueOnce({
        rows: [{ fec_ids: null, state_filing_ids: null, current_office: null, official_website_url: "https://jane.example", former_website_urls: null }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await findOrCreateCandidateFromProfile({
      client: { query } as never,
      profile: profile({ official_website_url: "https://jane.example" }),
      state: "TX",
      rosterParty: "Republican",
      includeParty: true,
    });

    expect(result).toEqual({ candidateId: "candidate-existing", matchedExisting: true });
  });

  it("stripWebsiteUrlsFromCandidate removes flagged current and former websites without archiving", () => {
    const result = stripWebsiteUrlsFromCandidate({
      storedWebsite: sharedPages[0],
      storedFormerWebsites: ["https://jane2024.example", sharedPages[1]!, "https://jane2024.example/"],
      shouldStrip: isSharedPageWebsiteUrl,
    });
    expect(result).toEqual({
      website: null,
      formerWebsites: ["https://jane2024.example"],
      strippedUrls: [sharedPages[0], sharedPages[1]],
      changed: true,
    });
    const untouched = stripWebsiteUrlsFromCandidate({
      storedWebsite: "https://jane.example",
      storedFormerWebsites: ["https://jane2024.example"],
      shouldStrip: isSharedPageWebsiteUrl,
    });
    expect(untouched.changed).toBe(false);
    expect(untouched.website).toBe("https://jane.example");
  });
});
