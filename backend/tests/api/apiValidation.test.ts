import { describe, expect, it } from "vitest";

import {
  AUTH_FORGOT_PASSWORD_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_REGISTER_PATH,
  AUTH_RESET_PASSWORD_PATH,
  AUTH_RESEND_VERIFICATION_PATH,
  AUTH_VERIFY_EMAIL_PATH,
  CANDIDATE_DETAIL_PATH_PREFIX,
  ME_AUTO_PICKS_PATH,
  ME_CANDIDATE_FOLLOWS_PATH,
  ME_ELECTION_CHOICES_PATH,
  MAX_ADDRESS_INPUT_LENGTH,
  MAX_AUTH_EMAIL_LENGTH,
  MAX_FIRST_NAME_LENGTH,
  ME_ADDRESS_PATH,
  ME_RESEARCH_AREA_PREFERENCES_PATH,
  parseAuthForgotPasswordBodyValue,
  parseAuthLoginBodyValue,
  parseAuthRegisterBodyValue,
  parseAuthResetPasswordBodyValue,
  parseAuthResendVerificationBodyValue,
  parseAuthVerifyEmailBodyValue,
  parseAuthenticatedAddressBodyValue,
  parseAutoPicksBodyValue,
  parseBallotPreferencesBodyValue,
  parseBallotSummaryOptions,
  parseCandidateFollowBodyValue,
  parseCandidateId,
  parseChatbotFeedbackBodyValue,
  parseElectionChoiceBodyValue,
  parsePickCardShareBodyValue,
  parsePickCardShareDeleteQuery,
  parseMeEmailBodyValue,
  parseMeUpdateBodyValue,
  parseResearchAreaPreferencesBodyValue,
  RESEARCH_AREAS_PATH,
} from "../../src/api/apiValidation.js";
import { RequestValidationError } from "../../src/utils/requestValidationError.js";

describe("parseChatbotFeedbackBodyValue", () => {
  it("accepts a token with an up or down verdict", () => {
    expect(parseChatbotFeedbackBodyValue({ token: "abc.def", verdict: "up" })).toEqual({
      token: "abc.def",
      verdict: "up",
    });
    expect(parseChatbotFeedbackBodyValue({ token: "abc.def", verdict: "down" }).verdict).toBe("down");
  });

  it("rejects missing or empty tokens, bad verdicts, and unknown fields", () => {
    expect(() => parseChatbotFeedbackBodyValue({ verdict: "up" })).toThrow(RequestValidationError);
    expect(() => parseChatbotFeedbackBodyValue({ token: "  ", verdict: "up" })).toThrow(RequestValidationError);
    expect(() => parseChatbotFeedbackBodyValue({ token: "abc", verdict: "sideways" })).toThrow(RequestValidationError);
    expect(() => parseChatbotFeedbackBodyValue({ token: "abc", verdict: "up", extra: 1 })).toThrow(RequestValidationError);
    expect(() => parseChatbotFeedbackBodyValue({ token: "x".repeat(401), verdict: "up" })).toThrow(RequestValidationError);
    expect(() => parseChatbotFeedbackBodyValue(null)).toThrow(RequestValidationError);
  });
});

describe("parseBallotSummaryOptions", () => {
  it("returns an empty options object when no params are present", () => {
    expect(parseBallotSummaryOptions(new URL("http://localhost/api/ballot"))).toEqual({});
  });

  it("parses election_date and rejects anything that is not a real YYYY-MM-DD date", () => {
    expect(parseBallotSummaryOptions(new URL("http://localhost/api/ballot?election_date=2026-11-03"))).toEqual({
      electionDate: "2026-11-03",
    });
    for (const bad of ["11/03/2026", "2026-13-01", "2026-11-3", "tomorrow"]) {
      expect(() => parseBallotSummaryOptions(new URL(`http://localhost/api/ballot?election_date=${bad}`))).toThrow(
        /election_date must be a valid YYYY-MM-DD date/
      );
    }
  });

  it("parses include=preview into includePreview", () => {
    expect(parseBallotSummaryOptions(new URL("http://localhost/api/ballot?include=preview"))).toEqual({
      includePreview: true,
    });
  });

  it("parses include=preview alongside sort and followed_first", () => {
    expect(
      parseBallotSummaryOptions(
        new URL("http://localhost/api/ballot?include=preview&sort=district_size_smallest&followed_first=false")
      )
    ).toEqual({ includePreview: true, sort: "district_size_smallest", followedFirst: false });
  });

  it("accepts a duplicated include=preview", () => {
    expect(
      parseBallotSummaryOptions(new URL("http://localhost/api/ballot?include=preview&include=preview"))
    ).toEqual({ includePreview: true });
  });

  it("rejects an unknown value smuggled in as a duplicate include", () => {
    expect(() =>
      parseBallotSummaryOptions(new URL("http://localhost/api/ballot?include=preview&include=roster"))
    ).toThrow(/include must be: preview/);
  });

  it("rejects unknown include values", () => {
    expect(() => parseBallotSummaryOptions(new URL("http://localhost/api/ballot?include=roster"))).toThrow(
      /include must be: preview/
    );
  });

  it("rejects unknown sort values", () => {
    expect(() => parseBallotSummaryOptions(new URL("http://localhost/api/ballot?sort=nope"))).toThrow(
      /sort must be one of/
    );
  });

  it("accepts the request-only state_baseline sort", () => {
    expect(parseBallotSummaryOptions(new URL("http://localhost/api/ballot?sort=state_baseline"))).toEqual({
      sort: "state_baseline",
    });
  });

  it("rejects state_baseline as a SAVED preference (the DB CHECK does not allow it)", () => {
    expect(() =>
      parseBallotPreferencesBodyValue({ sort: "state_baseline", followed_first: true })
    ).toThrow(/sort must be one of/);
  });

  it("still accepts saveable sorts as preferences", () => {
    expect(parseBallotPreferencesBodyValue({ sort: "my_areas", followed_first: false })).toEqual({
      sort: "my_areas",
      followed_first: false,
    });
  });
});

describe("candidate detail API contract constants", () => {
  it("defines and parses the public candidate detail path", () => {
    expect(CANDIDATE_DETAIL_PATH_PREFIX).toBe("/api/candidates/");
    expect(parseCandidateId(new URL("http://localhost/api/candidates/22222222-2222-4222-8222-222222222222"))).toBe(
      "22222222-2222-4222-8222-222222222222"
    );
  });

  it.each([
    ["http://localhost/api/candidates/", "Candidate detail path must be /api/candidates/:candidate_id"],
    [
      "http://localhost/api/candidates/22222222-2222-4222-8222-222222222222/extra",
      "Candidate detail path must be /api/candidates/:candidate_id",
    ],
    ["http://localhost/api/candidates/not-a-uuid", "Candidate detail path contains invalid UUID: not-a-uuid"],
  ])("rejects invalid candidate detail path %#", (url, message) => {
    expect(() => parseCandidateId(new URL(url))).toThrow(message);
  });
});

describe("authenticated address API contract constants", () => {
  it("defines the authenticated address replacement path", () => {
    expect(ME_ADDRESS_PATH).toBe("/api/me/address");
  });

  it("parses authenticated address payloads like normal address lookups", () => {
    expect(parseAuthenticatedAddressBodyValue({ address: "  123 Main St Denver CO 80203  " })).toEqual({
      address: "123 Main St Denver CO 80203",
    });
  });

  it.each([
    [null, "Request body must be a JSON object"],
    [{}, "Request body must include non-empty string field: address"],
    [{ address: "   " }, "Request body must include non-empty string field: address"],
    [{ address: 123 }, "Request body must include non-empty string field: address"],
    [
      { address: "a".repeat(MAX_ADDRESS_INPUT_LENGTH + 1) },
      `address must be at most ${MAX_ADDRESS_INPUT_LENGTH} characters`,
    ],
  ])("rejects invalid authenticated address payload %#", (payload, message) => {
    expect(() => parseAuthenticatedAddressBodyValue(payload)).toThrow(message);
  });

  it("accepts an address at exactly the length cap", () => {
    const address = "a".repeat(MAX_ADDRESS_INPUT_LENGTH);
    expect(parseAuthenticatedAddressBodyValue({ address })).toEqual({ address });
  });
});

describe("candidate follow API contract constants", () => {
  it("defines the authenticated candidate-follow path", () => {
    expect(ME_CANDIDATE_FOLLOWS_PATH).toBe("/api/me/candidate-follows");
  });

  it("parses candidate follow payloads into pipeline inputs", () => {
    expect(
      parseCandidateFollowBodyValue({
        candidate_id: "  22222222-2222-4222-8222-222222222222  ",
        following: true,
        notify_elections: false,
        notify_updates: true,
      })
    ).toEqual({
      candidateId: "22222222-2222-4222-8222-222222222222",
      following: true,
      notifyElections: false,
      notifyUpdates: true,
    });
  });

  it("allows minimal unfollow payloads", () => {
    expect(
      parseCandidateFollowBodyValue({
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: false,
      })
    ).toEqual({
      candidateId: "22222222-2222-4222-8222-222222222222",
      following: false,
    });
  });

  it.each([
    [null, "Request body must be a JSON object"],
    [{}, "Request body must include UUID string field: candidate_id"],
    [{ candidate_id: 123, following: true }, "Request body must include UUID string field: candidate_id"],
    [{ candidate_id: "not-a-uuid", following: true }, "candidate_id must be a valid UUID: not-a-uuid"],
    [
      { candidate_id: "22222222-2222-4222-8222-222222222222" },
      "Request body must include boolean field: following",
    ],
    [
      { candidate_id: "22222222-2222-4222-8222-222222222222", following: "yes" },
      "Request body must include boolean field: following",
    ],
    [
      {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: true,
        notify_elections: "yes",
      },
      "notify_elections must be a boolean",
    ],
    [
      {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: true,
        notify_updates: "yes",
      },
      "notify_updates must be a boolean",
    ],
  ])("rejects invalid candidate follow payload %#", (payload, message) => {
    expect(() => parseCandidateFollowBodyValue(payload)).toThrow(message);
  });
});

describe("pick card share API contract", () => {
  it("parses and trims a valid share body", () => {
    expect(parsePickCardShareBodyValue({ election_date: "  2026-11-03  " })).toEqual({
      electionDate: "2026-11-03",
    });
  });

  it.each([
    // V8 rolls impossible days over (2026-02-30 parses as March 2); the
    // parser must reject them here as a 400, not let Postgres 500 on the
    // ::date cast.
    ["2026-02-30"],
    ["2026-13-01"],
    ["2026-00-10"],
    ["not-a-date"],
    ["2026-1-3"],
    // Round-trips unchanged in JS (year 0 = 1 BC) but Postgres has no year
    // zero — must 400 here, not 500 on the ::date cast.
    ["0000-01-01"],
  ])("rejects non-calendar election_date %s", (value) => {
    expect(() => parsePickCardShareBodyValue({ election_date: value })).toThrow(
      /valid YYYY-MM-DD date/
    );
  });

  it("accepts leap-day dates that actually exist", () => {
    expect(parsePickCardShareBodyValue({ election_date: "2028-02-29" })).toEqual({
      electionDate: "2028-02-29",
    });
    expect(() => parsePickCardShareBodyValue({ election_date: "2026-02-29" })).toThrow(
      /valid YYYY-MM-DD date/
    );
  });

  it("parses the revoke query's election_date and rejects a missing or bad one", () => {
    expect(
      parsePickCardShareDeleteQuery(new URL("http://localhost/api/me/pick-card-shares?election_date=2026-11-03"))
    ).toBe("2026-11-03");
    expect(() => parsePickCardShareDeleteQuery(new URL("http://localhost/api/me/pick-card-shares"))).toThrow(
      RequestValidationError
    );
    expect(() =>
      parsePickCardShareDeleteQuery(new URL("http://localhost/api/me/pick-card-shares?election_date=2026-02-30"))
    ).toThrow(/valid YYYY-MM-DD date/);
  });
});

describe("election choice API contract constants", () => {
  it("defines the authenticated election-choices path", () => {
    expect(ME_ELECTION_CHOICES_PATH).toBe("/api/me/election-choices");
  });

  it("parses candidate choice payloads into pipeline inputs, trimming both UUIDs", () => {
    expect(
      parseElectionChoiceBodyValue({
        election_id: "  33333333-3333-4333-8333-333333333333  ",
        candidate_id: "  22222222-2222-4222-8222-222222222222  ",
        chosen: true,
      })
    ).toEqual({
      electionId: "33333333-3333-4333-8333-333333333333",
      candidateId: "22222222-2222-4222-8222-222222222222",
      chosen: true,
    });
  });

  it("parses measure position payloads, including the null clear", () => {
    expect(
      parseElectionChoiceBodyValue({
        election_id: "33333333-3333-4333-8333-333333333333",
        measure_position: "no",
      })
    ).toEqual({
      electionId: "33333333-3333-4333-8333-333333333333",
      measurePosition: "no",
    });
    expect(
      parseElectionChoiceBodyValue({
        election_id: "33333333-3333-4333-8333-333333333333",
        measure_position: null,
      })
    ).toEqual({
      electionId: "33333333-3333-4333-8333-333333333333",
      measurePosition: null,
    });
  });

  it.each([
    [null, "Request body must be a JSON object"],
    [{}, "Request body must include UUID string field: election_id"],
    [{ election_id: "not-a-uuid" }, "election_id must be a valid UUID: not-a-uuid"],
    [
      { election_id: "33333333-3333-4333-8333-333333333333" },
      "Request body must include exactly one of: candidate_id, measure_position",
    ],
    [
      {
        election_id: "33333333-3333-4333-8333-333333333333",
        candidate_id: "22222222-2222-4222-8222-222222222222",
        chosen: true,
        measure_position: "yes",
      },
      "Request body must include exactly one of: candidate_id, measure_position",
    ],
    [
      { election_id: "33333333-3333-4333-8333-333333333333", candidate_id: "not-a-uuid", chosen: true },
      "candidate_id must be a valid UUID: not-a-uuid",
    ],
    [
      { election_id: "33333333-3333-4333-8333-333333333333", candidate_id: 123, chosen: true },
      "candidate_id must be a UUID string",
    ],
    [
      { election_id: "33333333-3333-4333-8333-333333333333", candidate_id: "22222222-2222-4222-8222-222222222222" },
      "Request body must include boolean field: chosen",
    ],
    [
      { election_id: "33333333-3333-4333-8333-333333333333", measure_position: "maybe" },
      "measure_position must be 'yes', 'no', or null",
    ],
    [
      { election_id: "33333333-3333-4333-8333-333333333333", measure_position: "yes", chosen: true },
      "chosen applies only to candidate choices",
    ],
  ])("rejects invalid election choice payload %#", (payload, message) => {
    expect(() => parseElectionChoiceBodyValue(payload)).toThrow(message);
  });
});

describe("auto-picks API contract constants", () => {
  const electionId = "33333333-3333-4333-8333-333333333333";

  it("defines the auto-picks path", () => {
    expect(ME_AUTO_PICKS_PATH).toBe("/api/me/auto-picks");
  });

  it("parses a payload, trimming ids and passing dry_run through", () => {
    expect(
      parseAutoPicksBodyValue({ election_ids: [`  ${electionId}  `], mode: "replace", dry_run: true })
    ).toEqual({ electionIds: [electionId], mode: "replace", dryRun: true });
    expect(parseAutoPicksBodyValue({ election_ids: [electionId], mode: "fill_empty" })).toEqual({
      electionIds: [electionId],
      mode: "fill_empty",
    });
  });

  it.each([
    [null, "Request body must be a JSON object"],
    [{}, "Request body must include non-empty array field: election_ids"],
    [{ election_ids: [], mode: "replace" }, "Request body must include non-empty array field: election_ids"],
    [
      { election_ids: Array.from({ length: 201 }, (_, index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`), mode: "replace" },
      "election_ids must contain at most 200 ids",
    ],
    [{ election_ids: [123], mode: "replace" }, "election_ids must contain only UUID strings"],
    [{ election_ids: ["not-a-uuid"], mode: "replace" }, "election_ids contains an invalid UUID: not-a-uuid"],
    [
      { election_ids: [electionId, electionId], mode: "replace" },
      `election_ids contains a duplicate: ${electionId}`,
    ],
    [{ election_ids: [electionId] }, "mode must be 'fill_empty' or 'replace'"],
    [{ election_ids: [electionId], mode: "everything" }, "mode must be 'fill_empty' or 'replace'"],
    [{ election_ids: [electionId], mode: "replace", dry_run: "yes" }, "dry_run must be a boolean"],
  ])("rejects invalid auto-picks payload %#", (payload, message) => {
    expect(() => parseAutoPicksBodyValue(payload)).toThrow(message);
  });
});

describe("public auth API contract constants", () => {
  it("defines the public auth endpoints", () => {
    expect(AUTH_REGISTER_PATH).toBe("/api/auth/register");
    expect(AUTH_VERIFY_EMAIL_PATH).toBe("/api/auth/verify-email");
    expect(AUTH_LOGIN_PATH).toBe("/api/auth/login");
    expect(AUTH_LOGOUT_PATH).toBe("/api/auth/logout");
    expect(AUTH_FORGOT_PASSWORD_PATH).toBe("/api/auth/forgot-password");
    expect(AUTH_RESEND_VERIFICATION_PATH).toBe("/api/auth/resend-verification");
    expect(AUTH_RESET_PASSWORD_PATH).toBe("/api/auth/reset-password");
  });

  it("parses public auth payloads", () => {
    expect(
      parseAuthRegisterBodyValue({
        email: "  user@example.com ",
        password: "correct horse battery staple",
        first_name: "  Alice  ",
        accepted_terms_version: " 1.0 ",
      })
    ).toEqual({
      email: "user@example.com",
      password: "correct horse battery staple",
      first_name: "Alice",
      accepted_terms_version: "1.0",
    });
    // Clickwrap: registration without terms acceptance must not parse.
    expect(() =>
      parseAuthRegisterBodyValue({ email: "user@example.com", password: "correct horse battery staple" })
    ).toThrow("accepted_terms_version");
    expect(parseAuthLoginBodyValue({ email: " user@example.com ", password: " secret123 " })).toEqual({
      email: "user@example.com",
      password: "secret123",
    });
    expect(parseAuthForgotPasswordBodyValue({ email: " user@example.com " })).toEqual({
      email: "user@example.com",
    });
    expect(parseAuthResendVerificationBodyValue({ email: " user@example.com " })).toEqual({
      email: "user@example.com",
    });
    expect(parseAuthVerifyEmailBodyValue({ token: " abc " })).toEqual({ token: "abc" });
    expect(parseAuthResetPasswordBodyValue({ token: " abc ", password: " password123 " })).toEqual({
      token: "abc",
      password: "password123",
    });
  });

  it("caps auth email, first name, and change-email fields at practical lengths", () => {
    // 320 is the RFC 5321 mailbox ceiling; longer values are junk, not mail.
    const longEmail = `${"a".repeat(MAX_AUTH_EMAIL_LENGTH)}@example.com`;
    const emailCapMessage = `must be at most ${MAX_AUTH_EMAIL_LENGTH} characters`;
    expect(() =>
      parseAuthRegisterBodyValue({
        email: longEmail,
        password: "correct horse battery staple",
        accepted_terms_version: "1.0",
      })
    ).toThrow(emailCapMessage);
    expect(() => parseAuthLoginBodyValue({ email: longEmail, password: "secret123" })).toThrow(emailCapMessage);
    expect(() => parseAuthForgotPasswordBodyValue({ email: longEmail })).toThrow(emailCapMessage);
    expect(() => parseMeEmailBodyValue({ new_email: longEmail, password: "secret123" })).toThrow(emailCapMessage);

    const longFirstName = "b".repeat(MAX_FIRST_NAME_LENGTH + 1);
    const firstNameCapMessage = `first_name must be at most ${MAX_FIRST_NAME_LENGTH} characters`;
    expect(() =>
      parseAuthRegisterBodyValue({
        email: "user@example.com",
        password: "correct horse battery staple",
        accepted_terms_version: "1.0",
        first_name: longFirstName,
      })
    ).toThrow(firstNameCapMessage);
    expect(() => parseMeUpdateBodyValue({ first_name: longFirstName })).toThrow(firstNameCapMessage);
    expect(parseMeUpdateBodyValue({ first_name: "c".repeat(MAX_FIRST_NAME_LENGTH) })).toEqual({
      first_name: "c".repeat(MAX_FIRST_NAME_LENGTH),
    });
  });
});

describe("research area API contract constants", () => {
  it("defines the public research-area catalog and authenticated preference paths", () => {
    expect(RESEARCH_AREAS_PATH).toBe("/api/research-areas");
    expect(ME_RESEARCH_AREA_PREFERENCES_PATH).toBe("/api/me/research-area-preferences");
  });

  it("parses research area preference payloads into pipeline inputs", () => {
    expect(
      parseResearchAreaPreferencesBodyValue({
        preferences: [
          { research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1 },
          { research_area_id: "33333333-3333-4333-8333-333333333333", rank: null },
        ],
      })
    ).toEqual({
      preferences: [
        { researchAreaId: "22222222-2222-4222-8222-222222222222", rank: 1 },
        { researchAreaId: "33333333-3333-4333-8333-333333333333", rank: null },
      ],
    });
  });

  it("passes direction and hard_veto through, and leaves them undefined when omitted", () => {
    const parsed = parseResearchAreaPreferencesBodyValue({
      preferences: [
        { research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1, direction: "oppose", hard_veto: true },
        { research_area_id: "33333333-3333-4333-8333-333333333333", rank: 2 },
      ],
    });
    expect(parsed.preferences[0]).toEqual({
      researchAreaId: "22222222-2222-4222-8222-222222222222",
      rank: 1,
      direction: "oppose",
      hardVeto: true,
    });
    // Omitted = "keep what is stored" downstream, so it must not default here.
    expect(parsed.preferences[1]?.direction).toBeUndefined();
    expect(parsed.preferences[1]?.hardVeto).toBeUndefined();
  });

  it("accepts any number of preferences and ranks past 7", () => {
    const preferences = Array.from({ length: 25 }, (_value, index) => ({
      research_area_id: `22222222-2222-4222-8222-${(index + 1).toString().padStart(12, "0")}`,
      rank: index + 1,
    }));
    expect(parseResearchAreaPreferencesBodyValue({ preferences }).preferences).toHaveLength(25);
  });

  it("allows clearing all research area preferences", () => {
    expect(parseResearchAreaPreferencesBodyValue({ preferences: [] })).toEqual({ preferences: [] });
  });

  it.each([
    [{}, "Request body must include array field: preferences"],
    [{ preferences: ["bad"] }, "preferences must contain only JSON objects"],
    [
      { preferences: [{ research_area_id: "not-a-uuid" }] },
      "preferences contains invalid research_area_id: not-a-uuid",
    ],
    [
      {
        preferences: [
          { research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1 },
          { research_area_id: "22222222-2222-4222-8222-222222222222", rank: 2 },
        ],
      },
      "preferences contains duplicate research_area_id: 22222222-2222-4222-8222-222222222222",
    ],
    [
      { preferences: [{ research_area_id: "22222222-2222-4222-8222-222222222222", rank: 0 }] },
      "preferences[].rank must be an integer from 1 to 1",
    ],
    [
      { preferences: [{ research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1.5 }] },
      "preferences[].rank must be an integer from 1 to 1",
    ],
    [
      // Rank is a list position: past the end is rejected with a 400, not
      // left for Postgres (integer overflow would otherwise surface as a 500).
      {
        preferences: [
          { research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1 },
          { research_area_id: "33333333-3333-4333-8333-333333333333", rank: 2147483648 },
        ],
      },
      "preferences[].rank must be an integer from 1 to 2",
    ],
    [
      { preferences: [{ research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1, direction: "against" }] },
      "preferences[].direction must be 'support' or 'oppose'",
    ],
    [
      { preferences: [{ research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1, hard_veto: "yes" }] },
      "preferences[].hard_veto must be a boolean",
    ],
    [
      {
        preferences: [
          { research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1 },
          { research_area_id: "33333333-3333-4333-8333-333333333333", rank: 1 },
        ],
      },
      "preferences contains duplicate rank: 1",
    ],
  ])("rejects invalid research area preference payload %#", (payload, message) => {
    expect(() => parseResearchAreaPreferencesBodyValue(payload)).toThrow(message);
  });
});

describe("content report API contract constants", () => {
  it("defines and parses the public content report path", async () => {
    const { CONTENT_REPORTS_PATH, parseContentReportBodyValue } = await import("../../src/api/apiValidation.js");
    expect(CONTENT_REPORTS_PATH).toBe("/api/content-reports");
    expect(
      parseContentReportBodyValue({
        entity_type: "candidate_record",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "  This record looks wrong.  ",
        suggested_source_url: " https://example.org/source ",
        reporter_email: " reader@example.com ",
      })
    ).toEqual({
      entityType: "candidate_record",
      entityId: "22222222-2222-4222-8222-222222222222",
      message: "This record looks wrong.",
      suggestedSourceUrl: "https://example.org/source",
      reporterEmail: "reader@example.com",
    });
  });

  it.each([
    [null, "Request body must be a JSON object"],
    [{}, "Request body must include string field: entity_type"],
    [
      {
        entity_type: "bad",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
      },
      "entity_type must be one of",
    ],
    [
      {
        entity_type: "candidate",
        entity_id: "not-a-uuid",
        message: "wrong",
      },
      "entity_id must be a valid UUID: not-a-uuid",
    ],
    [
      {
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: " ",
      },
      "Request body must include non-empty string field: message",
    ],
    [
      {
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
        suggested_source_url: "ftp://example.org/file",
      },
      "suggested_source_url must be a valid http(s) URL",
    ],
    [
      {
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
        reporter_email: "not-an-email",
      },
      "reporter_email must be a valid email address when provided",
    ],
    [
      {
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
        entity_label_snapshot: "client supplied",
      },
      "Request body contains unknown field: entity_label_snapshot",
    ],
  ])("rejects invalid content report payload %#", async (payload, message) => {
    const { parseContentReportBodyValue } = await import("../../src/api/apiValidation.js");
    expect(() => parseContentReportBodyValue(payload)).toThrow(message);
  });

  it.each([
    [
      {
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "a".repeat(2001),
      },
      "message must be at most 2000 characters",
    ],
    [
      {
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
        suggested_source_url: `https://example.org/${"a".repeat(2040)}`,
      },
      "suggested_source_url must be at most 2048 characters",
    ],
    [
      {
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
        reporter_email: `${"a".repeat(310)}@example.org`,
      },
      "reporter_email must be at most 320 characters",
    ],
  ])("rejects oversized content report payload %#", async (payload, message) => {
    const { parseContentReportBodyValue } = await import("../../src/api/apiValidation.js");
    expect(() => parseContentReportBodyValue(payload)).toThrow(message);
  });
});

describe("parsePublicAddressResolveBodyValue", () => {
  it("requires the accepted terms version", async () => {
    const { parsePublicAddressResolveBodyValue } = await import("../../src/api/apiValidation.js");
    expect(() => parsePublicAddressResolveBodyValue({ address: "1 Main St" })).toThrow(
      /accepted_terms_version/
    );
  });

  it("rejects a blank version", async () => {
    const { parsePublicAddressResolveBodyValue } = await import("../../src/api/apiValidation.js");
    expect(() =>
      parsePublicAddressResolveBodyValue({ address: "1 Main St", accepted_terms_version: "   " })
    ).toThrow(/accepted_terms_version/);
  });

  it("returns the trimmed address and version", async () => {
    const { parsePublicAddressResolveBodyValue } = await import("../../src/api/apiValidation.js");
    const { CURRENT_TERMS_VERSION } = await import("../../src/constants/legal.js");
    expect(
      parsePublicAddressResolveBodyValue({
        address: "  1 Main St  ",
        accepted_terms_version: ` ${CURRENT_TERMS_VERSION} `,
      })
    ).toEqual({
      address: "1 Main St",
      accepted_terms_version: CURRENT_TERMS_VERSION,
      coordinates: undefined,
      allow_partial: false,
    });
  });

  it("normalizes region_state and region_locality, and rejects malformed ones", async () => {
    const { parsePublicAddressResolveBodyValue } = await import("../../src/api/apiValidation.js");
    const { CURRENT_TERMS_VERSION } = await import("../../src/constants/legal.js");
    const base = { address: "Los Angeles, CA, USA", accepted_terms_version: CURRENT_TERMS_VERSION };

    const parsed = parsePublicAddressResolveBodyValue({
      ...base,
      region_state: "ca",
      region_locality: " Los Angeles ",
    });
    expect(parsed.region_state).toBe("CA");
    expect(parsed.region_locality).toBe("Los Angeles");

    // Absent fields stay absent, not undefined-valued keys.
    expect("region_state" in parsePublicAddressResolveBodyValue(base)).toBe(false);

    for (const region_state of ["C", "CAL", "C1", 12, null]) {
      expect(() => parsePublicAddressResolveBodyValue({ ...base, region_state })).toThrow(/region_state/);
    }
    for (const region_locality of ["", "   ", "x".repeat(121), 12]) {
      expect(() =>
        parsePublicAddressResolveBodyValue({ ...base, region_state: "CA", region_locality })
      ).toThrow(/region_locality/);
    }
    // A locality without a state has nothing to scope it.
    expect(() => parsePublicAddressResolveBodyValue({ ...base, region_locality: "Los Angeles" })).toThrow(
      /region_locality requires region_state/
    );
  });

  it("passes through valid optional coordinates", async () => {
    const { parsePublicAddressResolveBodyValue } = await import("../../src/api/apiValidation.js");
    const { CURRENT_TERMS_VERSION } = await import("../../src/constants/legal.js");
    expect(
      parsePublicAddressResolveBodyValue({
        address: "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA",
        accepted_terms_version: CURRENT_TERMS_VERSION,
        coordinates: { lat: 40.8135, lng: -74.0741 },
      }).coordinates
    ).toEqual({ lat: 40.8135, lng: -74.0741 });
  });

  it("omits coordinates when absent or null", async () => {
    const { parsePublicAddressResolveBodyValue } = await import("../../src/api/apiValidation.js");
    const { CURRENT_TERMS_VERSION } = await import("../../src/constants/legal.js");
    const base = { address: "1 Main St", accepted_terms_version: CURRENT_TERMS_VERSION };
    expect(parsePublicAddressResolveBodyValue(base).coordinates).toBeUndefined();
    expect(parsePublicAddressResolveBodyValue({ ...base, coordinates: null }).coordinates).toBeUndefined();
  });

  it("rejects malformed or out-of-range coordinates", async () => {
    const { parsePublicAddressResolveBodyValue } = await import("../../src/api/apiValidation.js");
    const { CURRENT_TERMS_VERSION } = await import("../../src/constants/legal.js");
    const base = { address: "1 Main St", accepted_terms_version: CURRENT_TERMS_VERSION };
    for (const coordinates of [
      "40.8,-74.1",
      ["40.8", "-74.1"],
      { lat: "40.8", lng: -74.1 },
      { lat: 40.8 },
      { lat: 91, lng: 0 },
      { lat: 0, lng: -181 },
      { lat: Number.NaN, lng: 0 },
    ]) {
      expect(() => parsePublicAddressResolveBodyValue({ ...base, coordinates })).toThrow(/coordinates/);
    }
  });

  it("leaves the saved-address payload alone — it has no clickwrap to carry", async () => {
    const { parseAuthenticatedAddressBodyValue } = await import("../../src/api/apiValidation.js");
    expect(parseAuthenticatedAddressBodyValue({ address: "1 Main St" })).toEqual({ address: "1 Main St" });
  });
});

describe("containsNulCharacter", () => {
  it("finds U+0000 in nested strings and nowhere else", async () => {
    const { containsNulCharacter } = await import("../../src/api/apiValidation.js");
    expect(containsNulCharacter("plain")).toBe(false);
    expect(containsNulCharacter({ a: ["ok", { b: "fine" }], n: 1, t: true, z: null })).toBe(false);
    expect(containsNulCharacter("bad\u0000")).toBe(true);
    expect(containsNulCharacter({ a: ["ok", { b: "x\u0000y" }] })).toBe(true);
    expect(containsNulCharacter([1, [2, ["\u0000"]]])).toBe(true);
    expect(containsNulCharacter({ ["k\u0000"]: "safe" })).toBe(true);
    expect(containsNulCharacter({ outer: [{ ["\u0000"]: 1 }] })).toBe(true);
    expect(containsNulCharacter(null)).toBe(false);
    expect(containsNulCharacter(undefined)).toBe(false);
  });

  it("walks deeply nested bodies without overflowing the call stack", async () => {
    const { containsNulCharacter } = await import("../../src/api/apiValidation.js");
    const depth = 100_000;
    const deepArrays: unknown = JSON.parse("[".repeat(depth) + "]".repeat(depth));
    expect(containsNulCharacter(deepArrays)).toBe(false);
    const deepObjects: unknown = JSON.parse('{"a":'.repeat(depth) + '"x\\u0000"' + "}".repeat(depth));
    expect(containsNulCharacter(deepObjects)).toBe(true);
  });

  it("makes the candidate search query reject NUL before the ILIKE query", async () => {
    const { parseCandidateSearchQuery } = await import("../../src/api/apiValidation.js");
    expect(() => parseCandidateSearchQuery(new URL("http://x/api/candidates/search?q=hil%00ar"))).toThrow(
      /must not contain NUL/
    );
    expect(parseCandidateSearchQuery(new URL("http://x/api/candidates/search?q=hilar"))).toBe("hilar");
  });
});
