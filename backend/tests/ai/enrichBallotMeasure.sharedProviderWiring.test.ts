import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  callResearchProviderMock,
  trimDebugTextMock,
  verifyHttpUrlReachabilityMock,
} = vi.hoisted(() => ({
  callResearchProviderMock: vi.fn(),
  trimDebugTextMock: vi.fn((input: string) => input),
  verifyHttpUrlReachabilityMock: vi.fn(async (url: string) => ({
    ok: true,
    finalUrl: url,
    status: 200,
  })),
}));

vi.mock("../../src/ai/researchProviderClient.ts", () => ({
  callResearchProvider: callResearchProviderMock,
  trimDebugText: trimDebugTextMock,
}));

vi.mock("../../src/ai/urlReachability.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ai/urlReachability.ts")>()),
  verifyHttpUrlReachability: verifyHttpUrlReachabilityMock,
}));

beforeEach(() => {
  verifyHttpUrlReachabilityMock.mockImplementation(async (url: string) => ({
    ok: true,
    finalUrl: url,
    status: 200,
  }));
});

afterEach(() => {
  callResearchProviderMock.mockReset();
  trimDebugTextMock.mockClear();
  verifyHttpUrlReachabilityMock.mockReset();
  vi.restoreAllMocks();
});

describe("enrichBallotMeasure shared provider wiring", () => {
  it("exposes full ballot-measure payload validation for manual writers", async () => {
    verifyHttpUrlReachabilityMock.mockImplementation(async (url: string) => ({
      ok: true,
      finalUrl: url.replace("http://", "https://"),
      status: 200,
    }));

    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await validateBallotMeasureAiPayload(
      {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources: ["https://example.org/measure-er.pdf", "http://example.org/county-voter-guide"],
      },
      1000,
      new Set(["healthcare_affordability"])
    );

    expect(callResearchProviderMock).not.toHaveBeenCalled();
    expect(verifyHttpUrlReachabilityMock).toHaveBeenCalledTimes(3);
    expect(verifyHttpUrlReachabilityMock.mock.calls[0]?.[0]).toBe(
      "https://example.org/measure-er.pdf"
    );
    expect(verifyHttpUrlReachabilityMock.mock.calls[1]?.[0]).toBe(
      "https://example.org/measure-er.pdf"
    );
    expect(verifyHttpUrlReachabilityMock.mock.calls[2]?.[0]).toBe(
      "http://example.org/county-voter-guide"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.officialMeasureUrl).toBe("https://example.org/measure-er.pdf");
      expect(result.sources).toEqual([
        "https://example.org/measure-er.pdf",
        "https://example.org/county-voter-guide",
      ]);
      expect(result.officialMeasureUrlVerification).toEqual({ status: 200 });
    }
  });

  it("rejects manual ballot-measure payloads with unreachable source URLs", async () => {
    verifyHttpUrlReachabilityMock.mockImplementation(async (url: string) =>
      url.includes("missing-source")
        ? { ok: false, reason: "citation fetch returned status 404" }
        : { ok: true, finalUrl: url, status: 200 }
    );

    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await validateBallotMeasureAiPayload(
      {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources: ["https://example.org/measure-er.pdf", "https://example.org/missing-source"],
      },
      1000,
      new Set(["healthcare_affordability"])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("source URL is not reachable");
      expect(result.failureDebug).toMatchObject({
        bad_source_urls: [
          {
            url: "https://example.org/missing-source",
            reason: "citation fetch returned status 404",
          },
        ],
      });
    }
  });

  it("rejects manual ballot-measure payloads with more sources than can be verified", async () => {
    const sources = Array.from(
      { length: 21 },
      (_, index) => `https://example.org/measure-er-source-${index + 1}.pdf`
    );

    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await validateBallotMeasureAiPayload(
      {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources,
      },
      1000,
      new Set(["healthcare_affordability"])
    );

    expect(verifyHttpUrlReachabilityMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      reason: "sources contains 21 URLs; at most 20 can be verified",
      blockedUrls: [],
      failureDebug: {
        source_url_count: 21,
        max_source_urls_to_verify: 20,
      },
    });
  });

  it("rejects manual ballot-measure payloads with unreachable official_measure_url", async () => {
    verifyHttpUrlReachabilityMock.mockImplementation(async (url: string) =>
      url.includes("measure-er.pdf")
        ? { ok: false, reason: "citation URL fetch timed out" }
        : { ok: true, finalUrl: url, status: 200 }
    );

    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await validateBallotMeasureAiPayload(
      {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources: ["https://example.org/county-voter-guide"],
      },
      1000,
      new Set(["healthcare_affordability"])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("official_measure_url is not reachable: citation URL fetch timed out");
      expect(result.blockedUrls).toEqual(["https://example.org/measure-er.pdf"]);
      expect(result.failureDebug).toMatchObject({
        official_measure_url: "https://example.org/measure-er.pdf",
        official_measure_url_verification_reason: "citation URL fetch timed out",
      });
    }
  });

  it("reports TLS certificate failures on official_measure_url as operator repair issues", async () => {
    verifyHttpUrlReachabilityMock.mockImplementation(async (url: string) =>
      url.includes("measure-er.pdf")
        ? {
            ok: false,
            reason: "citation URL fetch failed: fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          }
        : { ok: true, finalUrl: url, status: 200 }
    );

    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await validateBallotMeasureAiPayload(
      {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources: ["https://example.org/county-voter-guide"],
      },
      1000,
      new Set(["healthcare_affordability"])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        "official_measure_url could not be verified due to TLS/certificate issue"
      );
      expect(result.blockedUrls).toEqual([]);
      expect(result.failureDebug).toMatchObject({
        failure_kind: "tls_certificate_verification",
        official_measure_url: "https://example.org/measure-er.pdf",
        official_measure_url_verification_reason:
          "citation URL fetch failed: fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        suggested_operator_action:
          "Check whether the official site has a certificate problem. If this is a local trust-chain issue, configure NODE_EXTRA_CA_CERTS or repair the backend CA bundle, then retry.",
      });
    }
  });

  it("rejects manual ballot-measure payloads with malformed source URLs", async () => {
    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await validateBallotMeasureAiPayload(
      {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources: ["not a url"],
      },
      1000,
      new Set(["healthcare_affordability"])
    );

    expect(verifyHttpUrlReachabilityMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: "sources must contain valid http(s) URLs",
      blockedUrls: [],
    });
  });

  it("rejects over-cap summary and yes/no meanings with rewrite guidance", async () => {
    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const base = {
      official_measure_url: "https://example.org/measure-er.pdf",
      summary: "County measure to increase sales tax for public health services.",
      what_yes_means: "Approves a county sales tax increase for health services.",
      what_no_means: "Keeps current tax rates and funding levels.",
      research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
      sources: ["https://example.org/measure-er.pdf"],
    };

    const longSummary = await validateBallotMeasureAiPayload(
      { ...base, summary: "x".repeat(301) },
      1000,
      new Set(["healthcare_affordability"])
    );
    expect(longSummary.ok).toBe(false);
    if (!longSummary.ok) {
      expect(longSummary.reason).toContain("summary is 301 characters (max 300)");
      expect(longSummary.reason).toContain("two short plain sentences");
    }

    const longYes = await validateBallotMeasureAiPayload(
      { ...base, what_yes_means: "y".repeat(251) },
      1000,
      new Set(["healthcare_affordability"])
    );
    expect(longYes.ok).toBe(false);
    if (!longYes.ok) {
      expect(longYes.reason).toContain("what_yes_means is 251 characters (max 250)");
    }

    const longNo = await validateBallotMeasureAiPayload(
      { ...base, what_no_means: "n".repeat(251) },
      1000,
      new Set(["healthcare_affordability"])
    );
    expect(longNo.ok).toBe(false);
    if (!longNo.ok) {
      expect(longNo.reason).toContain("what_no_means is 251 characters (max 250)");
    }
  });

  it("feeds the length-cap failure back to the model on retry", async () => {
    callResearchProviderMock
      .mockResolvedValueOnce({
        ok: true,
        parsed: {
          official_measure_url: "https://example.org/measure-er.pdf",
          summary: "x".repeat(501),
          what_yes_means: "Approves a county sales tax increase for health services.",
          what_no_means: "Keeps current tax rates and funding levels.",
          research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
          sources: ["https://example.org/measure-er.pdf"],
        },
        rawText: "{}",
        debugMeta: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        parsed: {
          official_measure_url: "https://example.org/measure-er.pdf",
          summary: "County measure to increase sales tax for public health services.",
          what_yes_means: "Approves a county sales tax increase for health services.",
          what_no_means: "Keeps current tax rates and funding levels.",
          research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
          sources: ["https://example.org/measure-er.pdf"],
        },
        rawText: "{}",
        debugMeta: {},
      });

    const { enrichBallotMeasure } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await enrichBallotMeasure(
      {
        districtName: "Los Angeles County, California",
        districtType: "county",
        state: "CA",
        electionDate: "2026-06-02",
        officialBallotTitle: "Measure ER",
        seedUrls: [],
        allowedResearchAreaSlugs: ["healthcare_affordability"],
      },
      {
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      },
      [{ provider: "openai", model: "gpt-5.4-mini" }]
    );

    expect(callResearchProviderMock).toHaveBeenCalledTimes(2);
    expect(callResearchProviderMock.mock.calls[1]?.[1]).toContain(
      "Fix this validation issue: summary is 501 characters (max 300)"
    );
    expect(result.ok).toBe(true);
  });

  it("rejects manual ballot-measure payloads with unknown research-area slugs", async () => {
    const { validateBallotMeasureAiPayload } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await validateBallotMeasureAiPayload(
      {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "legal_competence", stance: "for" }],
        sources: ["https://example.org/measure-er.pdf"],
      },
      1000,
      new Set(["healthcare_affordability"])
    );

    expect(verifyHttpUrlReachabilityMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: "research_area_slug 'legal_competence' is not allowed for ballot measures",
      blockedUrls: [],
    });
  });

  it("routes provider calls through researchProviderClient", async () => {
    callResearchProviderMock.mockResolvedValue({
      ok: true,
      parsed: {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [
          { research_area_slug: "healthcare_affordability", stance: "for" },
          { research_area_slug: "cost_of_living_reduction", stance: "against" },
        ],
        sources: [
          "https://example.org/measure-er.pdf",
          "https://example.org/county-voter-guide",
        ],
      },
      rawText: "{\"official_measure_url\":\"https://example.org/measure-er.pdf\"}",
      debugMeta: { provider_test_flag: true },
    });

    const { enrichBallotMeasure } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await enrichBallotMeasure(
      {
        districtName: "Los Angeles County, California",
        districtType: "county",
        state: "CA",
        electionDate: "2026-06-02",
        officialBallotTitle: "Measure ER",
        seedUrls: [],
        allowedResearchAreaSlugs: ["healthcare_affordability", "cost_of_living_reduction"],
      },
      {
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      },
      [{ provider: "openai", model: "gpt-5.4-mini" }]
    );

    expect(callResearchProviderMock).toHaveBeenCalledTimes(1);
    expect(callResearchProviderMock).toHaveBeenCalledWith(
      { provider: "openai", model: "gpt-5.4-mini" },
      expect.any(String),
      expect.objectContaining({
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-5.4-mini");
      expect(result.officialMeasureUrl).toBe("https://example.org/measure-er.pdf");
      expect(result.summary).toBe("County measure to increase sales tax for public health services.");
      expect(result.researchAreaTags).toEqual([
        { researchAreaSlug: "healthcare_affordability", stance: "for" },
        { researchAreaSlug: "cost_of_living_reduction", stance: "against" },
      ]);
      expect(result.researchUrls).toContain("https://example.org/measure-er.pdf");
    }
  });

  it("rejects research-area tags outside the allowed ballot-measure list", async () => {
    callResearchProviderMock.mockResolvedValue({
      ok: true,
      parsed: {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "legal_competence", stance: "for" }],
        sources: ["https://example.org/measure-er.pdf"],
      },
      rawText: "{\"official_measure_url\":\"https://example.org/measure-er.pdf\"}",
      debugMeta: {},
    });

    const { enrichBallotMeasure } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await enrichBallotMeasure(
      {
        districtName: "Los Angeles County, California",
        districtType: "county",
        state: "CA",
        electionDate: "2026-06-02",
        officialBallotTitle: "Measure ER",
        seedUrls: [],
        allowedResearchAreaSlugs: ["healthcare_affordability", "cost_of_living_reduction"],
      },
      {
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      },
      [{ provider: "openai", model: "gpt-5.4-mini" }]
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("legal_competence");
    }
  });

  it("rejects duplicate research-area tags for the same slug", async () => {
    callResearchProviderMock.mockResolvedValue({
      ok: true,
      parsed: {
        official_measure_url: "https://example.org/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [
          { research_area_slug: "healthcare_affordability", stance: "for" },
          { research_area_slug: "healthcare_affordability", stance: "against" },
        ],
        sources: ["https://example.org/measure-er.pdf"],
      },
      rawText: "{\"official_measure_url\":\"https://example.org/measure-er.pdf\"}",
      debugMeta: {},
    });

    const { enrichBallotMeasure } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await enrichBallotMeasure(
      {
        districtName: "Los Angeles County, California",
        districtType: "county",
        state: "CA",
        electionDate: "2026-06-02",
        officialBallotTitle: "Measure ER",
        seedUrls: [],
        allowedResearchAreaSlugs: ["healthcare_affordability"],
      },
      {
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      },
      [{ provider: "openai", model: "gpt-5.4-mini" }]
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(
        "research_area_tags has duplicate research_area_slug 'healthcare_affordability'"
      );
    }
  });

  it("retries when official_measure_url returns 403 and asks the model to actively investigate it", async () => {
    callResearchProviderMock
      .mockResolvedValueOnce({
        ok: true,
        parsed: {
          official_measure_url: "https://elections.example.gov/measure-er",
          summary: "County measure to increase sales tax for public health services.",
          what_yes_means: "Approves a county sales tax increase for health services.",
          what_no_means: "Keeps current tax rates and funding levels.",
          research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
          sources: ["https://elections.example.gov/measure-er"],
        },
        rawText: "{\"official_measure_url\":\"https://elections.example.gov/measure-er\"}",
        debugMeta: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        parsed: {
          official_measure_url: "https://elections.example.gov/measure-er-full-text.pdf",
          summary: "County measure to increase sales tax for public health services.",
          what_yes_means: "Approves a county sales tax increase for health services.",
          what_no_means: "Keeps current tax rates and funding levels.",
          research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
          sources: ["https://elections.example.gov/measure-er-full-text.pdf"],
        },
        rawText: "{\"official_measure_url\":\"https://elections.example.gov/measure-er-full-text.pdf\"}",
        debugMeta: {},
      });
    verifyHttpUrlReachabilityMock.mockImplementation(async (url: string) => ({
      ok: true,
      finalUrl: url,
      status: url.endsWith("/measure-er") ? 403 : 200,
    }));

    const { enrichBallotMeasure } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await enrichBallotMeasure(
      {
        districtName: "Los Angeles County, California",
        districtType: "county",
        state: "CA",
        electionDate: "2026-06-02",
        officialBallotTitle: "Measure ER",
        seedUrls: [],
        allowedResearchAreaSlugs: ["healthcare_affordability"],
      },
      {
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      },
      [{ provider: "openai", model: "gpt-5.4-mini" }]
    );

    expect(callResearchProviderMock).toHaveBeenCalledTimes(2);
    expect(callResearchProviderMock.mock.calls[1]?.[1]).toContain(
      "Actively investigate that URL and related official election-authority pages."
    );
    expect(callResearchProviderMock.mock.calls[1]?.[1]).toContain(
      "Do not return that URL again as official_measure_url."
    );
    expect(callResearchProviderMock.mock.calls[1]?.[1]).not.toContain(
      "Do not use or cite this URL: https://elections.example.gov/measure-er"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.officialMeasureUrl).toBe("https://elections.example.gov/measure-er-full-text.pdf");
    }
  });

  it("rejects a 403 official URL when the retry returns it again", async () => {
    callResearchProviderMock.mockResolvedValue({
      ok: true,
      parsed: {
        official_measure_url: "https://elections.example.gov/measure-er",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources: ["https://elections.example.gov/measure-er"],
      },
      rawText: "{\"official_measure_url\":\"https://elections.example.gov/measure-er\"}",
      debugMeta: {},
    });
    verifyHttpUrlReachabilityMock.mockResolvedValue({
      ok: true,
      finalUrl: "https://elections.example.gov/measure-er",
      status: 403,
    });

    const { enrichBallotMeasure } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await enrichBallotMeasure(
      {
        districtName: "Los Angeles County, California",
        districtType: "county",
        state: "CA",
        electionDate: "2026-06-02",
        officialBallotTitle: "Measure ER",
        seedUrls: [],
        allowedResearchAreaSlugs: ["healthcare_affordability"],
      },
      {
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      },
      [{ provider: "openai", model: "gpt-5.4-mini" }]
    );

    expect(callResearchProviderMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("official_measure_url returned HTTP 403");
    }
  });

  it("returns operator repair guidance when mocked AI finds an official URL with TLS verification failure", async () => {
    callResearchProviderMock.mockResolvedValue({
      ok: true,
      parsed: {
        official_measure_url: "https://elections.example.gov/measure-er.pdf",
        summary: "County measure to increase sales tax for public health services.",
        what_yes_means: "Approves a county sales tax increase for health services.",
        what_no_means: "Keeps current tax rates and funding levels.",
        research_area_tags: [{ research_area_slug: "healthcare_affordability", stance: "for" }],
        sources: ["https://elections.example.gov/measure-er.pdf"],
      },
      rawText: "{\"official_measure_url\":\"https://elections.example.gov/measure-er.pdf\"}",
      debugMeta: {},
    });
    verifyHttpUrlReachabilityMock.mockResolvedValue({
      ok: false,
      reason: "citation URL fetch failed: fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });

    const { enrichBallotMeasure } = await import("../../src/ai/enrichBallotMeasure.ts");
    const result = await enrichBallotMeasure(
      {
        districtName: "Los Angeles County, California",
        districtType: "county",
        state: "CA",
        electionDate: "2026-06-02",
        officialBallotTitle: "Measure ER",
        seedUrls: [],
        allowedResearchAreaSlugs: ["healthcare_affordability"],
      },
      {
        timeoutMs: 1000,
        openAiApiKey: "test-openai-key",
      },
      [{ provider: "openai", model: "gpt-5.4-mini" }]
    );

    expect(callResearchProviderMock).toHaveBeenCalledTimes(2);
    expect(callResearchProviderMock.mock.calls[1]?.[1]).toContain(
      "Fix this validation issue: official_measure_url could not be verified due to TLS/certificate issue"
    );
    expect(callResearchProviderMock.mock.calls[1]?.[1]).not.toContain(
      "Do not use or cite this URL: https://elections.example.gov/measure-er.pdf"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        "official_measure_url could not be verified due to TLS/certificate issue"
      );
      expect(result.failureDebug).toMatchObject({
        failure_kind: "tls_certificate_verification",
        official_measure_url: "https://elections.example.gov/measure-er.pdf",
        official_measure_url_verification_reason:
          "citation URL fetch failed: fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        suggested_operator_action:
          "Check whether the official site has a certificate problem. If this is a local trust-chain issue, configure NODE_EXTRA_CA_CERTS or repair the backend CA bundle, then retry.",
      });
    }
  });
});
