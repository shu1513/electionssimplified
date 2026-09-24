import { type IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";

import { createApiApp } from "../../src/api/apiServer.js";
import { MAX_INITIALIZE_DISTRICT_IDS } from "../../src/api/apiValidation.js";
import { CURRENT_TERMS_VERSION, GRACE_TERMS_VERSIONS } from "../../src/constants/legal.js";
import type { CandidateElectionFinanceResult } from "../../src/pipeline/address/ballotLookup.js";
import { CensusAddressGeocoderError } from "../../src/pipeline/address/censusAddressGeocoder.js";
import {
  ZipDistrictResolutionError,
  type AddressResolutionResult,
} from "../../src/pipeline/address/addressResolverService.js";
import { UserCandidateFollowsError } from "../../src/pipeline/users/userCandidateFollows.js";
import { UserElectionChoicesError } from "../../src/pipeline/users/userElectionChoices.js";
import { InitializeUserDistrictsError } from "../../src/pipeline/users/userDistrictInitializer.js";
import { UserDistrictReaderError } from "../../src/pipeline/users/userDistrictReader.js";
import { ReplaceUserDistrictsError } from "../../src/pipeline/users/userDistrictReplacer.js";
import { UserIdentityError } from "../../src/pipeline/users/userIdentity.js";
import { UserResearchAreaPreferencesError } from "../../src/pipeline/users/userResearchAreaPreferences.js";

const resolvedAddress: AddressResolutionResult = {
  matched_address: "3921 HARLAN AVE, BALDWIN PARK, CA, 91706",
  coordinates: { lat: 34.082500135664, lng: -117.981072355887 },
  scope: "exact",
  address_match_count: 1,
  district_keys: [
    {
      district_type: "county",
      geoid_compact: "06037",
      source: "mtfcc",
      layer_name: "Counties",
      mtfcc: "G4020",
      name: "Los Angeles County",
    },
  ],
  districts: [
    {
      id: "district-la",
      district_type: "county",
      geoid_compact: "06037",
      name: "Los Angeles County",
      state: "CA",
      state_fips: "06",
      population: 9876482,
      representation_power_score: 12.3,
    },
  ],
  missing_district_keys: [],
  warnings: [],
};

const districtId = "11111111-1111-4111-8111-111111111111";
const electionId = "33333333-3333-4333-8333-333333333333";

function makeDistrictId(index: number): string {
  return `11111111-1111-4111-8111-${index.toString().padStart(12, "0")}`;
}

async function invokeExpressApp(
  app: Express,
  input: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  }
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown; rawBody: string }> {
  const requestBody = input.body ?? "";
  const headers = {
    ...(input.headers ?? {}),
    ...(requestBody.length > 0 && !input.headers?.["content-length"]
      ? { "content-length": Buffer.byteLength(requestBody).toString() }
      : {}),
  };
  const request = Readable.from(requestBody.length > 0 ? [requestBody] : []) as IncomingMessage;
  Object.assign(request, {
    method: input.method,
    url: input.path,
    headers,
    socket: {
      remoteAddress: input.remoteAddress ?? "127.0.0.1",
    },
  });

  const response = new ServerResponse(request);
  const responseChunks: Buffer[] = [];
  const socket = new Writable({
    write(chunk, _encoding, callback) {
      responseChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.assignSocket(socket as never);

  return await new Promise((resolve, reject) => {
    response.on("finish", () => {
      const rawResponse = Buffer.concat(responseChunks).toString("utf8");
      const [, rawBody = ""] = rawResponse.split("\r\n\r\n");
      const body =
        rawBody.length > 0 && String(response.getHeader("content-type") ?? "").includes("application/json")
          ? JSON.parse(rawBody)
          : rawBody;
      const headers = Object.fromEntries(
        Object.entries(response.getHeaders()).map(([key, value]) => [key, String(value)])
      );
      resolve({
        statusCode: response.statusCode,
        headers,
        body,
        rawBody,
      });
    });
    response.on("error", reject);
    app(request, response);
  });
}

describe("createApiApp", () => {
  it("serves POST /api/address/resolve without leaking coordinates or ballot data", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);
    const logDiagnostics = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, logDiagnostics }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      matched_address: resolvedAddress.matched_address,
      address_match_count: resolvedAddress.address_match_count,
      districts: resolvedAddress.districts,
      scope: "exact",
    });
    expect(response.body).not.toHaveProperty("coordinates");
    expect(response.body).not.toHaveProperty("ballot");
    expect(resolveAddress).toHaveBeenCalledWith("3921 Harlan Ave Baldwin Park CA 91706", undefined, false, undefined, undefined);
    expect(logDiagnostics).toHaveBeenCalledWith({
      address_match_count: 1,
      scope: "exact",
      district_keys: resolvedAddress.district_keys,
      missing_district_keys: [],
      warnings: [],
    });
  });

  it("passes autocomplete coordinates through to the resolver", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({
        address: "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA",
        accepted_terms_version: CURRENT_TERMS_VERSION,
        coordinates: { lat: 40.8135, lng: -74.0741 },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveAddress).toHaveBeenCalledWith(
      "1 MetLife Stadium Dr, East Rutherford, NJ 07073, USA",
      { lat: 40.8135, lng: -74.0741 },
      false,
      undefined,
      undefined
    );
  });

  it("passes region_state and region_locality through to the resolver", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({
        address: "Los Angeles, CA, USA",
        accepted_terms_version: CURRENT_TERMS_VERSION,
        allow_partial: true,
        region_state: "CA",
        region_locality: "Los Angeles",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    expect(resolveAddress).toHaveBeenCalledWith("Los Angeles, CA, USA", undefined, true, "CA", "Los Angeles");
  });

  it("passes allow_partial through and rejects a non-boolean value", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const accepted = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({
        address: "78701",
        accepted_terms_version: CURRENT_TERMS_VERSION,
        allow_partial: true,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(resolveAddress).toHaveBeenCalledWith("78701", undefined, true, undefined, undefined);

    const rejected = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({
        address: "78701",
        accepted_terms_version: CURRENT_TERMS_VERSION,
        allow_partial: "yes",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(resolveAddress).toHaveBeenCalledTimes(1);
  });

  it("maps ZIP partial-path failures to 422 with their distinct codes", async () => {
    const resolveAddress = vi
      .fn()
      .mockRejectedValue(new ZipDistrictResolutionError("zip_multi_state", "ZIP code 02861 crosses state lines"));

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({
        address: "02861",
        accepted_terms_version: CURRENT_TERMS_VERSION,
        allow_partial: true,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual({
      error: { code: "zip_multi_state", message: "ZIP code 02861 crosses state lines" },
    });
  });

  it("rejects malformed resolve coordinates with 400", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({
        address: "1 Main St",
        accepted_terms_version: CURRENT_TERMS_VERSION,
        coordinates: { lat: 91, lng: 0 },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("refuses to resolve an address without an accepted terms version", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must include non-empty string field: accepted_terms_version",
      },
    });
    // The clickwrap is the gate: a caller who accepted nothing gets no search,
    // however they reached the endpoint.
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("refuses to resolve an address against a superseded terms version", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: "0.9" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("resolves an address for a grace terms version during a bump rollout", async () => {
    const graceVersion = GRACE_TERMS_VERSIONS[0];
    if (graceVersion === undefined) {
      // Grace list empty between rollouts — nothing to verify.
      return;
    }
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    // A stale bundle one bump behind still renders the documents it names,
    // so its acceptance stays valid while the rollout completes.
    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: graceVersion }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveAddress).toHaveBeenCalledTimes(1);
  });

  it("defaults every response to cache-control no-store", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const resolved = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json" },
    });
    // Error paths must not be cached either.
    const notFound = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "GET",
      path: "/api/does-not-exist",
    });

    expect(resolved.headers["cache-control"]).toBe("no-store");
    expect(notFound.statusCode).toBe(404);
    expect(notFound.headers["cache-control"]).toBe("no-store");
  });

  it("keeps address resolve read-only even when user district initialization is configured", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/address/resolve",
        body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(initializeUserDistricts).not.toHaveBeenCalled();
    expect(resolveAuthenticatedUserId).not.toHaveBeenCalled();
  });

  it("does not fail successful address responses when diagnostics logging throws", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);
    const logDiagnostics = vi.fn(() => {
      throw new Error("diagnostics sink failed");
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, logDiagnostics }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      matched_address: resolvedAddress.matched_address,
      address_match_count: resolvedAddress.address_match_count,
      districts: resolvedAddress.districts,
      scope: "exact",
    });
    expect(logDiagnostics).toHaveBeenCalledOnce();
  });

  it("handles allowed CORS preflight before rate limiting", async () => {
    const resolveAddress = vi.fn();
    const rateLimit = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, allowedOrigins: ["http://localhost:3000"], rateLimit }),
      {
        method: "OPTIONS",
        path: "/api/address/resolve",
        headers: { origin: "http://localhost:3000" },
      }
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-voteapp-client",
      "access-control-max-age": "600",
      vary: "Origin, Sec-Fetch-Site",
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects disallowed origins before rate limiting", async () => {
    const resolveAddress = vi.fn();
    const rateLimit = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, allowedOrigins: ["http://localhost:3000"], rateLimit }),
      {
        method: "POST",
        path: "/api/address/resolve",
        body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
        headers: { origin: "https://evil.example", "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Origin is not allowed",
      },
    });
    expect(response.headers).toMatchObject({ vary: "Origin, Sec-Fetch-Site" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves same-origin or server-side requests without CORS headers", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const response = await invokeExpressApp(createApiApp({ resolveAddress, allowedOrigins: ["http://localhost:3000"] }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).not.toHaveProperty("access-control-allow-origin");
    expect(resolveAddress).toHaveBeenCalledWith("3921 Harlan Ave Baldwin Park CA 91706", undefined, false, undefined, undefined);
  });

  it("serves configured dynamic sitemap XML", async () => {
    const resolveAddress = vi.fn();
    const getSitemapXml = vi.fn().mockResolvedValue(
      '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://electionssimplified.com/</loc></url></urlset>'
    );

    const response = await invokeExpressApp(createApiApp({ resolveAddress, getSitemapXml }), {
      method: "GET",
      path: "/sitemap.xml",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/xml");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.rawBody).toContain("<urlset>");
    expect(response.rawBody).toContain("https://electionssimplified.com/");
    expect(response.body).toBe(response.rawBody);
    expect(getSitemapXml).toHaveBeenCalledOnce();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves one sitemap child file by part and page", async () => {
    const resolveAddress = vi.fn();
    const getSitemapXml = vi.fn().mockResolvedValue('<?xml version="1.0" encoding="UTF-8"?><urlset></urlset>');

    const response = await invokeExpressApp(createApiApp({ resolveAddress, getSitemapXml }), {
      method: "GET",
      path: "/sitemap.xml?part=elections&page=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/xml");
    expect(getSitemapXml).toHaveBeenCalledWith({ part: "elections", page: 2 });
  });

  it("answers 404 for a sitemap child file that does not exist", async () => {
    const resolveAddress = vi.fn();
    // Past the last page: the generator says no such file.
    const getSitemapXml = vi.fn().mockResolvedValue(null);

    const pastTheEnd = await invokeExpressApp(createApiApp({ resolveAddress, getSitemapXml }), {
      method: "GET",
      path: "/sitemap.xml?part=elections&page=99",
    });
    expect(pastTheEnd.statusCode).toBe(404);
    expect(pastTheEnd.body).toEqual({ error: { code: "not_found", message: "No such sitemap file" } });
    expect(getSitemapXml).toHaveBeenCalledWith({ part: "elections", page: 99 });

    // An unknown part never reaches the generator.
    getSitemapXml.mockClear();
    const unknownPart = await invokeExpressApp(createApiApp({ resolveAddress, getSitemapXml }), {
      method: "GET",
      path: "/sitemap.xml?part=users",
    });
    expect(unknownPart.statusCode).toBe(404);
    expect(getSitemapXml).not.toHaveBeenCalled();
  });

  it("keeps sitemap dark when it is not configured", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "GET",
      path: "/sitemap.xml",
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "not_found",
        message: "Sitemap is not configured",
      },
    });
  });

  it("rejects unsupported sitemap methods", async () => {
    const resolveAddress = vi.fn();
    const getSitemapXml = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, getSitemapXml }), {
      method: "POST",
      path: "/sitemap.xml",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET");
    expect(response.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET /sitemap.xml",
      },
    });
    expect(getSitemapXml).not.toHaveBeenCalled();
  });

  it("supports wildcard CORS origins", async () => {
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddress);

    const response = await invokeExpressApp(createApiApp({ resolveAddress, allowedOrigins: ["*"] }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { origin: "https://frontend.example", "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": "*",
      vary: "Origin, Sec-Fetch-Site",
    });
    expect(response.headers).not.toHaveProperty("access-control-allow-credentials");
  });

  it("preserves CORS headers on route validation errors", async () => {
    const resolveAddress = vi.fn();
    const lookupBallotSummaries = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress,
        lookupBallotSummaries,
        allowedOrigins: ["https://frontend.example"],
      }),
      {
        method: "GET",
        path: "/api/ballot?district_ids=not-a-uuid",
        headers: { origin: "https://frontend.example" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": "https://frontend.example",
      vary: "Origin, Sec-Fetch-Site",
    });
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Query parameter district_ids contains invalid UUID: not-a-uuid",
      },
    });
  });

  it("returns unknown-path 404 before origin rejection and rate limiting", async () => {
    const resolveAddress = vi.fn();
    const rateLimit = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, allowedOrigins: ["http://localhost:3000"], rateLimit }),
      {
        method: "POST",
        path: "/api/other",
        body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
        headers: { origin: "https://evil.example", "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "not_found",
        message: "Not found",
      },
    });
    expect(response.headers).toMatchObject({ vary: "Origin, Sec-Fetch-Site" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rate limits address POST requests before parsing oversized bodies", async () => {
    const resolveAddress = vi.fn();
    const rateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 7 });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, rateLimit }), {
      method: "POST",
      path: "/api/address/resolve",
      body: "x".repeat(16 * 1024 + 1),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.body).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again later.",
      },
    });
    expect(response.headers).toMatchObject({ "retry-after": "7" });
    expect(rateLimit).toHaveBeenCalledWith({
      clientIp: expect.any(String),
      method: "POST",
      pathname: "/api/address/resolve",
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps oversized address bodies to 413 after rate limiting allows the request", async () => {
    const resolveAddress = vi.fn();
    const rateLimit = vi.fn().mockReturnValue({ allowed: true });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, rateLimit }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "x".repeat(16 * 1024) }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(413);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "request body exceeds 16384 bytes",
      },
    });
    expect(rateLimit).toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps invalid JSON to invalid_json", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: "{not-json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_json",
        message: "Request body must be valid JSON",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content types before parsing address resolve bodies", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "text/plain" },
    });

    expect(response.statusCode).toBe(415);
    expect(response.body).toEqual({
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects non-application +json content types before parsing bodies", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "text/plain+json" },
    });

    expect(response.statusCode).toBe(415);
    expect(response.body).toEqual({
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps empty JSON bodies to invalid_request", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must be a JSON object",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps strict JSON primitive bodies to invalid_json", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify("not an object"),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_json",
        message: "Request body must be valid JSON",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps validation errors to invalid_request", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must include non-empty string field: address",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it.each([
    {
      upstreamError: new CensusAddressGeocoderError("invalid_address", "Address is invalid"),
      statusCode: 400,
      code: "invalid_request",
    },
    {
      upstreamError: new CensusAddressGeocoderError("not_found", "Census geocoder could not locate the address"),
      statusCode: 422,
      code: "address_not_found",
    },
    {
      upstreamError: new CensusAddressGeocoderError("bad_response", "Census geocoder returned malformed JSON"),
      statusCode: 502,
      code: "bad_upstream_response",
    },
    {
      upstreamError: new CensusAddressGeocoderError("timeout", "Census geocoder timed out"),
      statusCode: 503,
      code: "upstream_unavailable",
    },
    {
      upstreamError: new CensusAddressGeocoderError("network_error", "Census geocoder request failed: fetch failed"),
      statusCode: 503,
      code: "upstream_unavailable",
    },
  ])("maps Census geocoder $code errors", async ({ upstreamError, statusCode, code }) => {
    const resolveAddress = vi.fn().mockRejectedValue(upstreamError);

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "missing address", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.body).toEqual({
      error: {
        code,
        message: upstreamError.message,
      },
    });
  });

  it("maps unexpected route errors to internal_error with a logged request id", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const resolveAddress = vi
        .fn()
        .mockRejectedValue(new Error("database went sideways for voter@example.com"));
      const captureUnexpectedError = vi.fn();

      const response = await invokeExpressApp(createApiApp({ resolveAddress, captureUnexpectedError }), {
        method: "POST",
        path: "/api/address/resolve",
        body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
        headers: { "content-type": "application/json" },
      });

      expect(response.statusCode).toBe(500);
      const body = response.body as { error: { code: string; message: string; request_id?: string } };
      expect(body.error.code).toBe("internal_error");
      expect(body.error.message).toBe("Internal error");
      // The response id must match the server-side log line so a user
      // report can be correlated with the captured error.
      expect(body.error.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const [logLine, loggedError] = consoleError.mock.calls[0]!;
      expect(logLine).toContain(`request_id=${body.error.request_id}`);
      expect(logLine).toContain("POST /api/address/resolve");
      expect(logLine).not.toContain("Harlan Ave");
      // Stack string, not the error object: custom enumerable properties on
      // wrapped errors must not reach the log — and the local log line gets
      // the same email/query-string masking as Sentry events.
      expect(loggedError).toEqual(expect.stringContaining("database went sideways for [email]"));
      expect(loggedError).not.toContain("voter@example.com");
      // The monitoring hook receives the same id the user can report.
      expect(captureUnexpectedError).toHaveBeenCalledTimes(1);
      expect(captureUnexpectedError).toHaveBeenCalledWith(expect.any(Error), {
        requestId: body.error.request_id,
        method: "POST",
        path: "/api/address/resolve",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    ["TypeError", new TypeError("Cannot read properties of undefined (reading 'district_id')")],
    ["SyntaxError", new SyntaxError("Unexpected token } in JSON at position 12")],
  ])("maps an internal %s to a scrubbed 500 with exactly one capture", async (_name, thrown) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The request itself is well-formed; the failure is a bug deeper in the
      // handler. It must not come back as a 400 carrying the internal message.
      const resolveAddress = vi.fn().mockRejectedValue(thrown);
      const captureUnexpectedError = vi.fn();

      const response = await invokeExpressApp(createApiApp({ resolveAddress, captureUnexpectedError }), {
        method: "POST",
        path: "/api/address/resolve",
        body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
        headers: { "content-type": "application/json" },
      });

      expect(response.statusCode).toBe(500);
      const body = response.body as { error: { code: string; message: string; request_id?: string } };
      expect(body.error.code).toBe("internal_error");
      expect(body.error.message).toBe("Internal error");
      expect(JSON.stringify(body)).not.toContain(thrown.message);
      expect(captureUnexpectedError).toHaveBeenCalledTimes(1);
      expect(captureUnexpectedError).toHaveBeenCalledWith(thrown, expect.objectContaining({ requestId: body.error.request_id }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not log or tag expected mapped errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const resolveAddress = vi
        .fn()
        .mockRejectedValue(new CensusAddressGeocoderError("timeout", "Census geocoder timed out"));
      const captureUnexpectedError = vi.fn();

      const response = await invokeExpressApp(createApiApp({ resolveAddress, captureUnexpectedError }), {
        method: "POST",
        path: "/api/address/resolve",
        body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
        headers: { "content-type": "application/json" },
      });

      expect(response.statusCode).toBe(503);
      expect((response.body as { error: { request_id?: string } }).error.request_id).toBeUndefined();
      expect(consoleError).not.toHaveBeenCalled();
      expect(captureUnexpectedError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps known-path wrong methods as 405 responses", async () => {
    const resolveAddress = vi.fn();
    const lookupBallotSummaries = vi.fn();
    const lookupAuthenticatedBallotSummaries = vi.fn();
    const lookupElectionDetail = vi.fn();
    const updateAuthenticatedAddressDistricts = vi.fn();
    const initializeUserDistricts = vi.fn();
    const listResearchAreas = vi.fn();
    const listAuthenticatedResearchAreaPreferences = vi.fn();
    const replaceAuthenticatedResearchAreaPreferences = vi.fn();
    const app = createApiApp({
      resolveAddress,
      lookupBallotSummaries,
      lookupAuthenticatedBallotSummaries,
      lookupElectionDetail,
      updateAuthenticatedAddressDistricts,
      initializeUserDistricts,
      listResearchAreas,
      listAuthenticatedResearchAreaPreferences,
      replaceAuthenticatedResearchAreaPreferences,
    });

    const ballotResponse = await invokeExpressApp(app, {
      method: "POST",
      path: `/api/ballot?district_ids=${districtId}`,
    });
    expect(ballotResponse.statusCode).toBe(405);
    expect(ballotResponse.headers).toMatchObject({ allow: "GET" });
    expect(ballotResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET /api/ballot?district_ids=...",
      },
    });

    const electionResponse = await invokeExpressApp(app, {
      method: "POST",
      path: `/api/elections/${electionId}`,
    });
    expect(electionResponse.statusCode).toBe(405);
    expect(electionResponse.headers).toMatchObject({ allow: "GET" });
    expect(electionResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET /api/elections/:election_id",
      },
    });

    const authenticatedBallotResponse = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/me/ballot",
    });
    expect(authenticatedBallotResponse.statusCode).toBe(405);
    expect(authenticatedBallotResponse.headers).toMatchObject({ allow: "GET" });
    expect(authenticatedBallotResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET /api/me/ballot",
      },
    });

    const authenticatedDistrictsResponse = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/me/districts",
    });
    expect(authenticatedDistrictsResponse.statusCode).toBe(405);
    expect(authenticatedDistrictsResponse.headers).toMatchObject({ allow: "GET" });
    expect(authenticatedDistrictsResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET /api/me/districts",
      },
    });

    const authenticatedAddressResponse = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/me/address",
    });
    expect(authenticatedAddressResponse.statusCode).toBe(405);
    expect(authenticatedAddressResponse.headers).toMatchObject({ allow: "PUT" });
    expect(authenticatedAddressResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use PUT /api/me/address",
      },
    });

    const researchAreasResponse = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/research-areas",
    });
    expect(researchAreasResponse.statusCode).toBe(405);
    expect(researchAreasResponse.headers).toMatchObject({ allow: "GET" });
    expect(researchAreasResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET /api/research-areas",
      },
    });

    const researchAreaPreferencesResponse = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/me/research-area-preferences",
    });
    expect(researchAreaPreferencesResponse.statusCode).toBe(405);
    expect(researchAreaPreferencesResponse.headers).toMatchObject({ allow: "GET, PUT" });
    expect(researchAreaPreferencesResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET or PUT /api/me/research-area-preferences",
      },
    });

    const addressResponse = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/address/resolve",
    });
    expect(addressResponse.statusCode).toBe(405);
    expect(addressResponse.headers).toMatchObject({ allow: "POST" });
    expect(addressResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use POST /api/address/resolve",
      },
    });

    const initializeResponse = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/me/districts/initialize",
    });
    expect(initializeResponse.statusCode).toBe(405);
    expect(initializeResponse.headers).toMatchObject({ allow: "POST" });
    expect(initializeResponse.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use POST /api/me/districts/initialize",
      },
    });

    expect(resolveAddress).not.toHaveBeenCalled();
    expect(lookupBallotSummaries).not.toHaveBeenCalled();
    expect(lookupAuthenticatedBallotSummaries).not.toHaveBeenCalled();
    expect(lookupElectionDetail).not.toHaveBeenCalled();
    expect(updateAuthenticatedAddressDistricts).not.toHaveBeenCalled();
    expect(initializeUserDistricts).not.toHaveBeenCalled();
    expect(listResearchAreas).not.toHaveBeenCalled();
    expect(listAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
  });

  it("rate limits known-path wrong methods before returning 405", async () => {
    const resolveAddress = vi.fn();
    const rateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 11 });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, rateLimit }), {
      method: "GET",
      path: "/api/address/resolve",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers).toMatchObject({ "retry-after": "11" });
    expect(response.body).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again later.",
      },
    });
    expect(rateLimit).toHaveBeenCalledWith({
      clientIp: expect.any(String),
      method: "GET",
      pathname: "/api/address/resolve",
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("uses configured client IP resolution for rate limiting", async () => {
    const resolveAddress = vi.fn();
    const resolveClientIp = vi.fn().mockReturnValue("198.51.100.44");
    const rateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 3 });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveClientIp, rateLimit }), {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.44" },
      remoteAddress: "10.0.0.5",
    });

    expect(response.statusCode).toBe(429);
    expect(resolveClientIp).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-forwarded-for": "198.51.100.44" }),
      remoteAddress: "10.0.0.5",
    });
    expect(rateLimit).toHaveBeenCalledWith({
      clientIp: "198.51.100.44",
      method: "POST",
      pathname: "/api/address/resolve",
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves ballot summaries and election detail routes", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedCandidateFollows = vi.fn();
    const lookupBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });
    const lookupElectionDetail = vi.fn().mockResolvedValue({
      id: electionId,
      district_id: districtId,
      district: {
        id: districtId,
        district_type: "county",
        geoid_compact: "06037",
        name: "Los Angeles County",
        state: "CA",
        state_fips: "06",
      },
      race_type: "office",
      official_ballot_title: "Sheriff",
      election_date: "2026-06-02",
      election_stage: "primary",
      is_partisan: false,
      discovery_contest_family: "non_judicial_office",
      sources: [],
      candidates: [],
      ballot_measure: null,
      results: [],
    });
    const app = createApiApp({
      resolveAddress,
      resolveAuthenticatedUserId,
      listAuthenticatedCandidateFollows,
      lookupBallotSummaries,
      lookupElectionDetail,
    });

    const ballotResponse = await invokeExpressApp(app, {
      method: "GET",
      path: `/api/ballot?district_ids=${districtId}`,
    });
    expect(ballotResponse.statusCode).toBe(200);
    expect(ballotResponse.body).toEqual({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });

    const electionResponse = await invokeExpressApp(app, {
      method: "GET",
      path: `/api/elections/${electionId}`,
      headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
    });
    expect(electionResponse.statusCode).toBe(200);
    expect(electionResponse.body).toMatchObject({
      id: electionId,
      race_type: "office",
      official_ballot_title: "Sheriff",
    });

    expect(lookupBallotSummaries).toHaveBeenCalledWith([districtId], {});
    expect(lookupElectionDetail).toHaveBeenCalledWith(electionId);
    expect(resolveAuthenticatedUserId).not.toHaveBeenCalled();
    expect(listAuthenticatedCandidateFollows).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves candidate name search anonymously", async () => {
    const resolveAddress = vi.fn();
    const searchCandidates = vi.fn().mockResolvedValue({
      candidates: [
        {
          candidate_id: "22222222-2222-4222-8222-222222222222",
          display_name: "Hilary Brown",
          party: "Independent",
          state: "CA",
          current_office: null,
        },
      ],
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, searchCandidates }), {
      method: "GET",
      path: "/api/candidates/search?q=hilar",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      candidates: [{ candidate_id: "22222222-2222-4222-8222-222222222222", display_name: "Hilary Brown" }],
    });
    expect(searchCandidates).toHaveBeenCalledWith("hilar");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it.each([
    ["blank", "/api/candidates/search?q=%20"],
    ["single-character", "/api/candidates/search?q=h"],
  ])("rejects a %s candidate search query", async (_label, path) => {
    const searchCandidates = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), searchCandidates }), {
      method: "GET",
      path,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "invalid_request" } });
    expect(searchCandidates).not.toHaveBeenCalled();
  });

  it("rejects non-GET candidate search", async () => {
    const searchCandidates = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), searchCandidates }), {
      method: "POST",
      path: "/api/candidates/search?q=hilar",
      body: {},
    });

    expect(response.statusCode).toBe(405);
    expect(searchCandidates).not.toHaveBeenCalled();
  });

  it("serves public candidate detail anonymously", async () => {
    const resolveAddress = vi.fn();
    const lookupCandidateDetail = vi.fn().mockResolvedValue({
      candidate: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        display_name: "Jane Smith",
        first_name: "Jane",
        last_name: "Smith",
        party: "Democratic",
        state: "CA",
        current_office: "Mayor",
        summary: "Incumbent mayor.",
        fec_ids: [],
        state_filing_ids: [],
        records: [],
        elections: [],
        is_following: false,
        follow: null,
      },
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateDetail }), {
      method: "GET",
      path: "/api/candidates/22222222-2222-4222-8222-222222222222",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      candidate: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        display_name: "Jane Smith",
        is_following: false,
      },
    });
    expect(lookupCandidateDetail).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", null);
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("passes the trusted user ID to candidate detail when authentication is present", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupCandidateDetail = vi.fn().mockResolvedValue({
      candidate: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        display_name: "Jane Smith",
        first_name: "Jane",
        last_name: "Smith",
        party: "Democratic",
        state: "CA",
        current_office: "Mayor",
        summary: null,
        fec_ids: [],
        state_filing_ids: [],
        records: [],
        elections: [],
        is_following: true,
        follow: {
          notify_elections: true,
          notify_updates: false,
          created_at: "2026-01-02T03:04:05.000Z",
        },
      },
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, lookupCandidateDetail }),
      {
        method: "GET",
        path: "/api/candidates/22222222-2222-4222-8222-222222222222",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      candidate: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        is_following: true,
      },
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(lookupCandidateDetail).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "99999999-9999-4999-8999-999999999999"
    );
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 404 when candidate detail is missing", async () => {
    const resolveAddress = vi.fn();
    const lookupCandidateDetail = vi.fn().mockResolvedValue(null);

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateDetail }), {
      method: "GET",
      path: "/api/candidates/22222222-2222-4222-8222-222222222222",
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "not_found",
        message: "Candidate not found",
      },
    });
    expect(lookupCandidateDetail).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", null);
  });

  it("rejects invalid candidate detail IDs before lookup", async () => {
    const resolveAddress = vi.fn();
    const lookupCandidateDetail = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateDetail }), {
      method: "GET",
      path: "/api/candidates/not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Candidate detail path contains invalid UUID: not-a-uuid",
      },
    });
    expect(lookupCandidateDetail).not.toHaveBeenCalled();
  });

  it("rejects unsupported candidate detail methods", async () => {
    const resolveAddress = vi.fn();
    const lookupCandidateDetail = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateDetail }), {
      method: "POST",
      path: "/api/candidates/22222222-2222-4222-8222-222222222222",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET");
    expect(response.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET /api/candidates/:candidate_id",
      },
    });
    expect(lookupCandidateDetail).not.toHaveBeenCalled();
  });

  it("returns 500 when candidate detail lookup is not configured", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "GET",
      path: "/api/candidates/22222222-2222-4222-8222-222222222222",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Candidate detail lookup is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves the selectable research area catalog", async () => {
    const resolveAddress = vi.fn();
    const listResearchAreas = vi.fn().mockResolvedValue({
      research_areas: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: "Housing policy",
        },
      ],
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, listResearchAreas }), {
      method: "GET",
      path: "/api/research-areas",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      research_areas: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: "Housing policy",
        },
      ],
    });
    expect(listResearchAreas).toHaveBeenCalledOnce();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves state voting resources with a shared-cache header", async () => {
    const resolveAddress = vi.fn();
    const stateResources = {
      state_abbreviation: "WA",
      state_name: "Washington",
      voter_registration_url: "https://voter.votewa.gov/WhereToVote.aspx",
      polling_place_url: "https://voter.votewa.gov",
      mail_voting_available: true,
      mail_ballot_request_url:
        "https://www.sos.wa.gov/elections/voters/helpful-information/frequently-asked-questions-voting-mail",
      mail_ballot_request_type: "not_required",
      mail_ballot_request_deadline_rule: null,
    };
    const getStateVotingResources = vi.fn().mockResolvedValue({ state_resources: stateResources });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, getStateVotingResources }), {
      method: "GET",
      path: "/api/state-resources?state=wa",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ state_resources: stateResources });
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    // The parser uppercases before the lookup so callers can pass either case.
    expect(getStateVotingResources).toHaveBeenCalledWith("WA");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  describe("site stats and IndexNow key", () => {
    it("serves the coverage statistics with the browse cache header", async () => {
      const stats = { as_of: "2026-09-24", totals: { states: 0 }, states: [] };
      const getSiteStats = vi.fn().mockResolvedValue(stats);
      const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), getSiteStats }), { method: "GET", path: "/api/stats" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("public, max-age=3600");
      expect(response.body).toEqual(stats);
      expect(getSiteStats).toHaveBeenCalledOnce();
    });

    it("serves the IndexNow key as plain text and 404s when unset", async () => {
      const served = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), indexNowKey: "abc123" }), { method: "GET", path: "/api/indexnow-key.txt" });
      expect(served.statusCode).toBe(200);
      expect(served.headers["content-type"]).toContain("text/plain");
      expect(served.rawBody).toBe("abc123");

      const unset = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn() }), { method: "GET", path: "/api/indexnow-key.txt" });
      expect(unset.statusCode).toBe(404);
    });
  });

  describe("browse catalog", () => {
    const browse = () => ({
      resolveAddress: vi.fn(),
      listBrowseStates: vi.fn().mockResolvedValue({ states: [{ state: "KY", name: "Kentucky", district_count: 2, upcoming_election_count: 5 }] }),
      getBrowseState: vi.fn().mockResolvedValue({ state: "KY", name: "Kentucky", districts: [] }),
      getBrowseDistrict: vi.fn().mockResolvedValue({
        district: { id: "dddddddd-1111-4111-8111-111111111111", name: "Simpson County, Kentucky", district_type: "county", state: "KY", state_name: "Kentucky" },
        elections: [],
      }),
    });

    it("lists states with a shared-cache header", async () => {
      const options = browse();
      const response = await invokeExpressApp(createApiApp(options), { method: "GET", path: "/api/browse/states" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("public, max-age=3600");
      expect(response.body).toEqual({ states: [{ state: "KY", name: "Kentucky", district_count: 2, upcoming_election_count: 5 }] });
      expect(options.resolveAddress).not.toHaveBeenCalled();
    });

    it("serves one state's districts, upper-casing the code", async () => {
      const options = browse();
      const response = await invokeExpressApp(createApiApp(options), { method: "GET", path: "/api/browse/states/ky" });

      expect(response.statusCode).toBe(200);
      expect(options.getBrowseState).toHaveBeenCalledWith("KY");
      expect(response.body).toEqual({ state: "KY", name: "Kentucky", districts: [] });
    });

    it("answers 404 for a state with nothing researched and 400 for a malformed code", async () => {
      const options = browse();
      options.getBrowseState.mockResolvedValue(null);
      const missing = await invokeExpressApp(createApiApp(options), { method: "GET", path: "/api/browse/states/pr" });
      expect(missing.statusCode).toBe(404);

      const malformed = await invokeExpressApp(createApiApp(options), { method: "GET", path: "/api/browse/states/kentucky" });
      expect(malformed.statusCode).toBe(400);
      expect(options.getBrowseState).toHaveBeenCalledTimes(1);
    });

    it("serves one district's elections and 404s an unknown district", async () => {
      const options = browse();
      const found = await invokeExpressApp(createApiApp(options), {
        method: "GET",
        path: "/api/browse/districts/dddddddd-1111-4111-8111-111111111111",
      });
      expect(found.statusCode).toBe(200);
      expect(found.headers["cache-control"]).toBe("public, max-age=3600");
      expect(options.getBrowseDistrict).toHaveBeenCalledWith("dddddddd-1111-4111-8111-111111111111");

      options.getBrowseDistrict.mockResolvedValue(null);
      const missing = await invokeExpressApp(createApiApp(options), {
        method: "GET",
        path: "/api/browse/districts/dddddddd-1111-4111-8111-111111111112",
      });
      expect(missing.statusCode).toBe(404);

      const malformed = await invokeExpressApp(createApiApp(options), { method: "GET", path: "/api/browse/districts/not-a-uuid" });
      expect(malformed.statusCode).toBe(400);
    });

    it("rejects non-GET methods and reports an unconfigured catalog", async () => {
      const options = browse();
      const post = await invokeExpressApp(createApiApp(options), {
        method: "POST",
        path: "/api/browse/states",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      expect(post.statusCode).toBe(405);
      expect(post.headers.allow).toBe("GET");

      const dark = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn() }), { method: "GET", path: "/api/browse/states" });
      expect(dark.statusCode).toBe(500);
    });
  });

  it("rejects a malformed state-resources state parameter", async () => {
    const resolveAddress = vi.fn();
    const getStateVotingResources = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, getStateVotingResources }), {
      method: "GET",
      path: "/api/state-resources?state=California",
    });

    expect(response.statusCode).toBe(400);
    expect(getStateVotingResources).not.toHaveBeenCalled();
  });

  it("returns 404 for a state without voting resources", async () => {
    const resolveAddress = vi.fn();
    const getStateVotingResources = vi.fn().mockResolvedValue(null);

    const response = await invokeExpressApp(createApiApp({ resolveAddress, getStateVotingResources }), {
      method: "GET",
      path: "/api/state-resources?state=PR",
    });

    expect(response.statusCode).toBe(404);
    expect(getStateVotingResources).toHaveBeenCalledWith("PR");
  });

  it("rejects non-GET state-resources requests", async () => {
    const resolveAddress = vi.fn();
    const getStateVotingResources = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, getStateVotingResources }), {
      method: "POST",
      path: "/api/state-resources?state=WA",
    });

    expect(response.statusCode).toBe(405);
    expect(getStateVotingResources).not.toHaveBeenCalled();
  });

  it("returns 500 when the state voting resources lookup is not configured", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "GET",
      path: "/api/state-resources?state=WA",
    });

    expect(response.statusCode).toBe(500);
  });

  it("returns 500 when the research area catalog lookup is not configured", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "GET",
      path: "/api/research-areas",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Research area catalog lookup is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves authenticated ballot summaries for the current user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries }),
      {
        method: "GET",
        path: "/api/me/ballot",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(lookupAuthenticatedBallotSummaries).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {});
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("passes sort and followed_first query params through to authenticated ballot summaries", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [],
      districts: [],
      elections: [],
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries }),
      {
        method: "GET",
        path: "/api/me/ballot?sort=district_size_smallest&followed_first=true",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(lookupAuthenticatedBallotSummaries).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {
      sort: "district_size_smallest",
      followedFirst: true,
    });
  });

  it("falls back to saved ballot preferences for omitted params, letting explicit params win", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [],
      districts: [],
      elections: [],
    });
    const getAuthenticatedBallotPreferences = vi
      .fn()
      .mockResolvedValue({ sort: "district_size", followed_first: false });

    // No params: both come from the saved preferences.
    await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries, getAuthenticatedBallotPreferences }),
      {
        method: "GET",
        path: "/api/me/ballot",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );
    expect(lookupAuthenticatedBallotSummaries).toHaveBeenLastCalledWith("99999999-9999-4999-8999-999999999999", {
      sort: "district_size",
      followedFirst: false,
    });

    // Explicit sort overrides the saved one; followed_first still comes from prefs.
    await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries, getAuthenticatedBallotPreferences }),
      {
        method: "GET",
        path: "/api/me/ballot?sort=district_size_smallest",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );
    expect(lookupAuthenticatedBallotSummaries).toHaveBeenLastCalledWith("99999999-9999-4999-8999-999999999999", {
      sort: "district_size_smallest",
      followedFirst: false,
    });
  });

  it("serves and stores ballot preferences via GET and PUT /api/me/ballot-preferences", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const getAuthenticatedBallotPreferences = vi.fn().mockResolvedValue({ sort: "vote_power", followed_first: true });
    const setAuthenticatedBallotPreferences = vi.fn().mockResolvedValue({ sort: "district_size_smallest", followed_first: false });
    const app = createApiApp({
      resolveAuthenticatedUserId,
      getAuthenticatedBallotPreferences,
      setAuthenticatedBallotPreferences,
    });

    const getResponse = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/me/ballot-preferences",
      headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body).toEqual({ sort: "vote_power", followed_first: true });

    const putResponse = await invokeExpressApp(app, {
      method: "PUT",
      path: "/api/me/ballot-preferences",
      headers: {
        "x-user-id": "99999999-9999-4999-8999-999999999999",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sort: "district_size_smallest", followed_first: false }),
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.body).toEqual({ sort: "district_size_smallest", followed_first: false });
    expect(setAuthenticatedBallotPreferences).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {
      sort: "district_size_smallest",
      followed_first: false,
    });
  });

  it("rejects an invalid ballot preferences body with 400", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedBallotPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, setAuthenticatedBallotPreferences }),
      {
        method: "PUT",
        path: "/api/me/ballot-preferences",
        headers: {
          "x-user-id": "99999999-9999-4999-8999-999999999999",
          "content-type": "application/json",
        },
        body: JSON.stringify({ sort: "alphabetical", followed_first: false }),
      }
    );

    expect(response.statusCode).toBe(400);
    expect(setAuthenticatedBallotPreferences).not.toHaveBeenCalled();
  });

  it("rejects an invalid sort query param with 400", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [],
      districts: [],
      elections: [],
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries }),
      {
        method: "GET",
        path: "/api/me/ballot?sort=alphabetical",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "invalid_request" } });
    expect(lookupAuthenticatedBallotSummaries).not.toHaveBeenCalled();
  });

  it("passes the sort query param through to anonymous ballot summaries", async () => {
    const lookupBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });

    const response = await invokeExpressApp(createApiApp({ lookupBallotSummaries }), {
      method: "GET",
      path: `/api/ballot?district_ids=${districtId}&sort=vote_power`,
    });

    expect(response.statusCode).toBe(200);
    expect(lookupBallotSummaries).toHaveBeenCalledWith([districtId], { sort: "vote_power" });
  });

  it("accepts sort=district_size as a valid ballot sort", async () => {
    const lookupBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });

    const response = await invokeExpressApp(createApiApp({ lookupBallotSummaries }), {
      method: "GET",
      path: `/api/ballot?district_ids=${districtId}&sort=district_size`,
    });

    expect(response.statusCode).toBe(200);
    expect(lookupBallotSummaries).toHaveBeenCalledWith([districtId], { sort: "district_size" });
  });

  it("serves empty authenticated ballot summaries when the user has no saved districts", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [],
      districts: [],
      elections: [],
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries }),
      {
        method: "GET",
        path: "/api/me/ballot",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      district_ids: [],
      districts: [],
      elections: [],
    });
    expect(lookupAuthenticatedBallotSummaries).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {});
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated ballot lookup when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const lookupAuthenticatedBallotSummaries = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupAuthenticatedBallotSummaries }), {
      method: "GET",
      path: "/api/me/ballot",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(lookupAuthenticatedBallotSummaries).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticated ballot lookup is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "GET",
      path: "/api/me/ballot",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated ballot lookup is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated ballot lookup without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const lookupAuthenticatedBallotSummaries = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries }),
      {
        method: "GET",
        path: "/api/me/ballot",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(lookupAuthenticatedBallotSummaries).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps authenticated ballot user-district reader errors to unauthorized", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedBallotSummaries = vi
      .fn()
      .mockRejectedValue(new UserDistrictReaderError("user_not_found", "User not found"));

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, lookupAuthenticatedBallotSummaries }),
      {
        method: "GET",
        path: "/api/me/ballot",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(lookupAuthenticatedBallotSummaries).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {});
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves the authenticated user's district ids", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedDistrictIds = vi.fn().mockResolvedValue([districtId]);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedDistrictIds }),
      {
        method: "GET",
        path: "/api/me/districts",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ district_ids: [districtId] });
    expect(listAuthenticatedDistrictIds).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves empty district ids when the user has no saved address", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedDistrictIds = vi.fn().mockResolvedValue([]);

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedDistrictIds }),
      {
        method: "GET",
        path: "/api/me/districts",
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ district_ids: [] });
  });

  it("rejects authenticated district lookup when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const listAuthenticatedDistrictIds = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, listAuthenticatedDistrictIds }), {
      method: "GET",
      path: "/api/me/districts",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedDistrictIds).not.toHaveBeenCalled();
  });

  it("rejects authenticated district lookup without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const listAuthenticatedDistrictIds = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedDistrictIds }),
      {
        method: "GET",
        path: "/api/me/districts",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedDistrictIds).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticated district lookup is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "GET",
      path: "/api/me/districts",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated district lookup is not configured",
      },
    });
  });

  it("maps district lookup user-district reader errors to unauthorized", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedDistrictIds = vi
      .fn()
      .mockRejectedValue(new UserDistrictReaderError("user_not_found", "User not found"));

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedDistrictIds }),
      {
        method: "GET",
        path: "/api/me/districts",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedDistrictIds).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
  });

  it("updates authenticated address districts for the current user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedUserEmailVerified = vi.fn().mockResolvedValue(true);
    const updateAuthenticatedAddressDistricts = vi.fn().mockResolvedValue({
      matched_address: "123 MAIN ST, DENVER, CO, 80203",
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress,
        resolveAuthenticatedUserId,
        lookupAuthenticatedUserEmailVerified,
        updateAuthenticatedAddressDistricts,
      }),
      {
        method: "PUT",
        path: "/api/me/address",
        body: JSON.stringify({ address: "  123 Main St Denver CO 80203  " }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      matched_address: "123 MAIN ST, DENVER, CO, 80203",
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(lookupAuthenticatedUserEmailVerified).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
    expect(updateAuthenticatedAddressDistricts).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      "123 Main St Denver CO 80203"
    );
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated address updates when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const updateAuthenticatedAddressDistricts = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, updateAuthenticatedAddressDistricts }), {
      method: "PUT",
      path: "/api/me/address",
      body: JSON.stringify({ address: "123 Main St Denver CO 80203" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(updateAuthenticatedAddressDistricts).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "authenticated address updates",
      method: "PUT",
      path: "/api/me/address",
      body: JSON.stringify({ address: "123 Main St Denver CO 80203" }),
      handlerKey: "updateAuthenticatedAddressDistricts" as const,
    },
    {
      name: "authenticated candidate follow updates",
      method: "PUT",
      path: "/api/me/candidate-follows",
      body: JSON.stringify({
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: true,
      }),
      handlerKey: "setAuthenticatedCandidateFollow" as const,
    },
    {
      name: "authenticated research area preference updates",
      method: "PUT",
      path: "/api/me/research-area-preferences",
      body: JSON.stringify({ preferences: [] }),
      handlerKey: "replaceAuthenticatedResearchAreaPreferences" as const,
    },
    {
      name: "authenticated district initialization",
      method: "POST",
      path: "/api/me/districts/initialize",
      body: JSON.stringify({ district_ids: [districtId] }),
      handlerKey: "initializeUserDistricts" as const,
    },
    {
      name: "authenticated district lookup",
      method: "GET",
      path: "/api/me/districts",
      body: undefined,
      handlerKey: "listAuthenticatedDistrictIds" as const,
    },
  ])("rejects unverified users from $name", async ({ method, path, body, handlerKey }) => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedUserEmailVerified = vi.fn().mockResolvedValue(false);
    const handler = vi.fn();
    const app = createApiApp({
      resolveAddress,
      resolveAuthenticatedUserId,
      lookupAuthenticatedUserEmailVerified,
      [handlerKey]: handler,
    });

    const response = await invokeExpressApp(app, {
      method,
      path,
      body,
      headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: "forbidden",
        message: "Email verification is required",
      },
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(lookupAuthenticatedUserEmailVerified).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
    expect(handler).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticated address update storage is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "PUT",
      path: "/api/me/address",
      body: JSON.stringify({ address: "123 Main St Denver CO 80203" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated address update is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated address updates without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const updateAuthenticatedAddressDistricts = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, updateAuthenticatedAddressDistricts }),
      {
        method: "PUT",
        path: "/api/me/address",
        body: JSON.stringify({ address: "123 Main St Denver CO 80203" }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(updateAuthenticatedAddressDistricts).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects invalid authenticated address update payloads before calling the handler", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const updateAuthenticatedAddressDistricts = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, updateAuthenticatedAddressDistricts }),
      {
        method: "PUT",
        path: "/api/me/address",
        body: JSON.stringify({ address: "   " }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must include non-empty string field: address",
      },
    });
    expect(updateAuthenticatedAddressDistricts).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content types before parsing authenticated address update bodies", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const updateAuthenticatedAddressDistricts = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, updateAuthenticatedAddressDistricts }),
      {
        method: "PUT",
        path: "/api/me/address",
        body: JSON.stringify({ address: "123 Main St Denver CO 80203" }),
        headers: { "content-type": "text/plain" },
      }
    );

    expect(response.statusCode).toBe(415);
    expect(response.body).toEqual({
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      },
    });
    expect(resolveAuthenticatedUserId).not.toHaveBeenCalled();
    expect(updateAuthenticatedAddressDistricts).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps authenticated address replacement errors to API errors", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const updateAuthenticatedAddressDistricts = vi
      .fn()
      .mockRejectedValue(new ReplaceUserDistrictsError("unknown_district_ids", `Unknown district IDs: ${districtId}`));

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, updateAuthenticatedAddressDistricts }),
      {
        method: "PUT",
        path: "/api/me/address",
        body: JSON.stringify({ address: "123 Main St Denver CO 80203" }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Address could not be matched to saved districts",
      },
    });
    expect(updateAuthenticatedAddressDistricts).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      "123 Main St Denver CO 80203"
    );
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves authenticated candidate follows for the current user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedCandidateFollows = vi.fn().mockResolvedValue({
      follows: [
        {
          candidate_id: "22222222-2222-4222-8222-222222222222",
          display_name: "Jane Smith",
          party: "Democratic",
          state: "CA",
          current_office: null,
          latest_record: {
            description: "Sponsored a housing affordability bill.",
            event_date: "2026-01-15",
          },
          active_election: {
            election_id: "33333333-3333-4333-8333-333333333333",
            official_ballot_title: "Mayor",
            election_date: "2026-11-03",
          },
          notify_elections: true,
          notify_updates: false,
          created_at: "2026-01-02T03:04:05.000Z",
        },
      ],
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedCandidateFollows }),
      {
        method: "GET",
        path: "/api/me/candidate-follows",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      follows: [
        {
          candidate_id: "22222222-2222-4222-8222-222222222222",
          display_name: "Jane Smith",
          party: "Democratic",
          state: "CA",
          current_office: null,
          latest_record: {
            description: "Sponsored a housing affordability bill.",
            event_date: "2026-01-15",
          },
          active_election: {
            election_id: "33333333-3333-4333-8333-333333333333",
            official_ballot_title: "Mayor",
            election_date: "2026-11-03",
          },
          notify_elections: true,
          notify_updates: false,
          created_at: "2026-01-02T03:04:05.000Z",
        },
      ],
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(response.body.follows[0]).not.toHaveProperty("records");
    expect(listAuthenticatedCandidateFollows).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("updates authenticated candidate follows for the current user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedCandidateFollow = vi.fn().mockResolvedValue({
      follow: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: true,
        notify_elections: false,
        notify_updates: true,
        created_at: "2026-01-02T03:04:05.000Z",
      },
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedCandidateFollow }),
      {
        method: "PUT",
        path: "/api/me/candidate-follows",
        body: JSON.stringify({
          candidate_id: "22222222-2222-4222-8222-222222222222",
          following: true,
          notify_elections: false,
          notify_updates: true,
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      follow: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: true,
        notify_elections: false,
        notify_updates: true,
        created_at: "2026-01-02T03:04:05.000Z",
      },
    });
    expect(setAuthenticatedCandidateFollow).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {
      candidateId: "22222222-2222-4222-8222-222222222222",
      following: true,
      notifyElections: false,
      notifyUpdates: true,
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("unfollows authenticated candidates for the current user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedCandidateFollow = vi.fn().mockResolvedValue({
      follow: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: false,
        notify_elections: false,
        notify_updates: false,
        created_at: null,
      },
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedCandidateFollow }),
      {
        method: "PUT",
        path: "/api/me/candidate-follows",
        body: JSON.stringify({
          candidate_id: "22222222-2222-4222-8222-222222222222",
          following: false,
          notify_elections: false,
          notify_updates: false,
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      follow: {
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: false,
        notify_elections: false,
        notify_updates: false,
        created_at: null,
      },
    });
    expect(setAuthenticatedCandidateFollow).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {
      candidateId: "22222222-2222-4222-8222-222222222222",
      following: false,
      notifyElections: false,
      notifyUpdates: false,
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves authenticated election choices without requiring email verification", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    // Unverified inbox: follows would 403 here, election choices must not.
    const lookupAuthenticatedUserEmailVerified = vi.fn().mockResolvedValue(false);
    const listAuthenticatedElectionChoices = vi.fn().mockResolvedValue({
      choices: [
        {
          election_id: "33333333-3333-4333-8333-333333333333",
          race_type: "office",
          official_ballot_title: "Mayor",
          election_date: "2026-11-03",
          seats_to_fill: null,
          picks: [
            {
              candidate_id: "22222222-2222-4222-8222-222222222222",
              display_name: "Jane Smith",
              candidacy_status: "declared",
            },
          ],
          measure_position: null,
          updated_at: "2026-01-02T03:04:05.000Z",
        },
      ],
    });

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress,
        resolveAuthenticatedUserId,
        lookupAuthenticatedUserEmailVerified,
        listAuthenticatedElectionChoices,
      }),
      {
        method: "GET",
        path: "/api/me/election-choices",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.choices).toHaveLength(1);
    expect(response.body.choices[0].picks[0].display_name).toBe("Jane Smith");
    expect(lookupAuthenticatedUserEmailVerified).not.toHaveBeenCalled();
    expect(listAuthenticatedElectionChoices).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("updates an authenticated candidate election choice", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedElectionChoice = vi.fn().mockResolvedValue({
      choice: {
        election_id: "33333333-3333-4333-8333-333333333333",
        race_type: "office",
        official_ballot_title: "Mayor",
        election_date: "2026-11-03",
        seats_to_fill: null,
        picks: [
          {
            candidate_id: "22222222-2222-4222-8222-222222222222",
            display_name: "Jane Smith",
            candidacy_status: "declared",
          },
        ],
        measure_position: null,
        updated_at: "2026-01-02T03:04:05.000Z",
      },
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedElectionChoice }),
      {
        method: "PUT",
        path: "/api/me/election-choices",
        body: JSON.stringify({
          election_id: "33333333-3333-4333-8333-333333333333",
          candidate_id: "22222222-2222-4222-8222-222222222222",
          chosen: true,
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.choice.picks).toHaveLength(1);
    expect(setAuthenticatedElectionChoice).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {
      electionId: "33333333-3333-4333-8333-333333333333",
      candidateId: "22222222-2222-4222-8222-222222222222",
      chosen: true,
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("updates an authenticated ballot-measure position", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedElectionChoice = vi.fn().mockResolvedValue({
      choice: {
        election_id: "33333333-3333-4333-8333-333333333333",
        race_type: "ballot_measure",
        official_ballot_title: "Measure A",
        election_date: "2026-11-03",
        seats_to_fill: null,
        picks: [],
        measure_position: "yes",
        updated_at: "2026-01-02T03:04:05.000Z",
      },
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedElectionChoice }),
      {
        method: "PUT",
        path: "/api/me/election-choices",
        body: JSON.stringify({
          election_id: "33333333-3333-4333-8333-333333333333",
          measure_position: "yes",
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.choice.measure_position).toBe("yes");
    expect(setAuthenticatedElectionChoice).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {
      electionId: "33333333-3333-4333-8333-333333333333",
      measurePosition: "yes",
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects election choice bodies that mix candidate and measure fields", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedElectionChoice = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedElectionChoice }),
      {
        method: "PUT",
        path: "/api/me/election-choices",
        body: JSON.stringify({
          election_id: "33333333-3333-4333-8333-333333333333",
          candidate_id: "22222222-2222-4222-8222-222222222222",
          chosen: true,
          measure_position: "yes",
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    expect(setAuthenticatedElectionChoice).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects non-GET/PUT election choice requests with 405 and an allow header", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedElectionChoices = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedElectionChoices }),
      {
        method: "DELETE",
        path: "/api/me/election-choices",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(405);
    expect(response.headers).toMatchObject({ allow: "GET, PUT" });
    expect(response.body.error.code).toBe("method_not_allowed");
    expect(listAuthenticatedElectionChoices).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when election choice handlers are not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const listResponse = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "GET",
      path: "/api/me/election-choices",
      headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
    });
    expect(listResponse.statusCode).toBe(500);
    expect(listResponse.body.error.code).toBe("internal_error");

    const putResponse = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "PUT",
      path: "/api/me/election-choices",
      body: JSON.stringify({
        election_id: "33333333-3333-4333-8333-333333333333",
        candidate_id: "22222222-2222-4222-8222-222222222222",
        chosen: true,
      }),
      headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
    });
    expect(putResponse.statusCode).toBe(500);
    expect(putResponse.body.error.code).toBe("internal_error");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps election choice domain errors thrown by the handler", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedElectionChoice = vi
      .fn()
      .mockRejectedValue(
        new UserElectionChoicesError("candidacy_not_available", "Candidate is not an active candidate in this election")
      );

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedElectionChoice }),
      {
        method: "PUT",
        path: "/api/me/election-choices",
        body: JSON.stringify({
          election_id: "33333333-3333-4333-8333-333333333333",
          candidate_id: "22222222-2222-4222-8222-222222222222",
          chosen: true,
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "not_found",
        message: "Candidate is not an active candidate in this election",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("mints a pick card share without requiring email verification", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedUserEmailVerified = vi.fn().mockResolvedValue(false);
    const createAuthenticatedPickCardShare = vi.fn().mockResolvedValue({
      share: { token: "tok_abcdefghijklmnopqrstuvwxyz012345", election_date: "2026-11-03" },
    });

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress,
        resolveAuthenticatedUserId,
        lookupAuthenticatedUserEmailVerified,
        createAuthenticatedPickCardShare,
      }),
      {
        method: "POST",
        path: "/api/me/pick-card-shares",
        body: JSON.stringify({ election_date: "2026-11-03" }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.share.token).toBe("tok_abcdefghijklmnopqrstuvwxyz012345");
    expect(lookupAuthenticatedUserEmailVerified).not.toHaveBeenCalled();
    expect(createAuthenticatedPickCardShare).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      "2026-11-03"
    );
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects pick card share requests without a session or with a bad body", async () => {
    const resolveAddress = vi.fn();
    const createAuthenticatedPickCardShare = vi.fn();

    const unauthenticated = await invokeExpressApp(
      createApiApp({ resolveAddress, createAuthenticatedPickCardShare }),
      {
        method: "POST",
        path: "/api/me/pick-card-shares",
        body: JSON.stringify({ election_date: "2026-11-03" }),
        headers: { "content-type": "application/json" },
      }
    );
    expect(unauthenticated.statusCode).toBe(401);

    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const badDate = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, createAuthenticatedPickCardShare }),
      {
        method: "POST",
        path: "/api/me/pick-card-shares",
        body: JSON.stringify({ election_date: "November 3rd" }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );
    expect(badDate.statusCode).toBe(400);
    expect(createAuthenticatedPickCardShare).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("lists and revokes pick card shares for the session holder", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const lookupAuthenticatedUserEmailVerified = vi.fn().mockResolvedValue(false);
    const listAuthenticatedPickCardShares = vi.fn().mockResolvedValue({
      shares: [{ token: "tok_abcdefghijklmnopqrstuvwxyz012345", election_date: "2026-11-03" }],
    });
    const deleteAuthenticatedPickCardShare = vi.fn().mockResolvedValue({ deleted: true });
    const app = createApiApp({
      resolveAddress,
      resolveAuthenticatedUserId,
      lookupAuthenticatedUserEmailVerified,
      listAuthenticatedPickCardShares,
      deleteAuthenticatedPickCardShare,
    });
    const headers = { "x-user-id": "99999999-9999-4999-8999-999999999999" };

    const listed = await invokeExpressApp(app, { method: "GET", path: "/api/me/pick-card-shares", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.body.shares).toEqual([
      { token: "tok_abcdefghijklmnopqrstuvwxyz012345", election_date: "2026-11-03" },
    ]);
    expect(listAuthenticatedPickCardShares).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");

    // Body-less DELETE: no JSON content type required, the date rides in
    // the query, like DELETE /api/me/auto-picks.
    const revoked = await invokeExpressApp(app, {
      method: "DELETE",
      path: "/api/me/pick-card-shares?election_date=2026-11-03",
      headers,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.body).toEqual({ deleted: true });
    expect(deleteAuthenticatedPickCardShare).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      "2026-11-03"
    );

    const missingDate = await invokeExpressApp(app, { method: "DELETE", path: "/api/me/pick-card-shares", headers });
    expect(missingDate.statusCode).toBe(400);
    expect(deleteAuthenticatedPickCardShare).toHaveBeenCalledTimes(1);

    // Neither read nor revoke is verification-gated, and neither is open
    // to anonymous callers.
    expect(lookupAuthenticatedUserEmailVerified).not.toHaveBeenCalled();
    const anonymous = await invokeExpressApp(createApiApp({ resolveAddress, listAuthenticatedPickCardShares }), {
      method: "GET",
      path: "/api/me/pick-card-shares",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves a public pick card by token without any session", async () => {
    const resolveAddress = vi.fn();
    const lookupPublicPickCard = vi.fn().mockResolvedValue({
      first_name: "Ava",
      election_date: "2026-11-03",
      entries: [
        {
          election_id: "33333333-3333-4333-8333-333333333333",
          official_ballot_title: "Mayor",
          race_type: "office",
          district_name: "Springfield",
          picks: [
            {
              candidate_id: "22222222-2222-4222-8222-222222222222",
              display_name: "Jane Smith",
              candidacy_status: "declared",
            },
          ],
          measure_position: null,
        },
      ],
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupPublicPickCard }), {
      method: "GET",
      path: "/api/pick-cards/tok_abcdefghijklmnopqrstuvwxyz012345",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.election_date).toBe("2026-11-03");
    // The owner's first name rides the public payload — it is what lets the
    // page say whose card this is.
    expect(response.body.first_name).toBe("Ava");
    expect(response.body.entries[0].picks[0].display_name).toBe("Jane Smith");
    expect(lookupPublicPickCard).toHaveBeenCalledWith("tok_abcdefghijklmnopqrstuvwxyz012345");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("404s an unknown pick card token and 400s a malformed one", async () => {
    const resolveAddress = vi.fn();
    const lookupPublicPickCard = vi.fn().mockResolvedValue(null);

    const unknown = await invokeExpressApp(createApiApp({ resolveAddress, lookupPublicPickCard }), {
      method: "GET",
      path: "/api/pick-cards/tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body.error.code).toBe("not_found");

    const malformed = await invokeExpressApp(createApiApp({ resolveAddress, lookupPublicPickCard }), {
      method: "GET",
      path: "/api/pick-cards/short!",
    });
    expect(malformed.statusCode).toBe(400);
    expect(lookupPublicPickCard).toHaveBeenCalledTimes(1);
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves a pick card og image by token without any session", async () => {
    const resolveAddress = vi.fn();
    const lookupPublicPickCard = vi.fn().mockResolvedValue({
      first_name: "Ava",
      election_date: "2026-11-03",
      entries: [],
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupPublicPickCard }), {
      method: "GET",
      path: "/api/pick-cards/tok_abcdefghijklmnopqrstuvwxyz012345/og-image.png",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("public, max-age=86400");
    // The utf8 round-trip mangles binary, but the PNG tag survives.
    expect(response.rawBody).toContain("PNG");
    expect(lookupPublicPickCard).toHaveBeenCalledWith("tok_abcdefghijklmnopqrstuvwxyz012345");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("404s an unknown og-image token and 400s a malformed one", async () => {
    const resolveAddress = vi.fn();
    const lookupPublicPickCard = vi.fn().mockResolvedValue(null);

    const unknown = await invokeExpressApp(createApiApp({ resolveAddress, lookupPublicPickCard }), {
      method: "GET",
      path: "/api/pick-cards/tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/og-image.png",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body.error.code).toBe("not_found");

    const malformed = await invokeExpressApp(createApiApp({ resolveAddress, lookupPublicPickCard }), {
      method: "GET",
      path: "/api/pick-cards/short!/og-image.png",
    });
    expect(malformed.statusCode).toBe(400);
    expect(lookupPublicPickCard).toHaveBeenCalledTimes(1);
  });

  it("rejects authenticated election choices when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const listAuthenticatedElectionChoices = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, listAuthenticatedElectionChoices }), {
      method: "GET",
      path: "/api/me/election-choices",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedElectionChoices).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated candidate follows when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const listAuthenticatedCandidateFollows = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, listAuthenticatedCandidateFollows }), {
      method: "GET",
      path: "/api/me/candidate-follows",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedCandidateFollows).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated candidate follow updates when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const setAuthenticatedCandidateFollow = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, setAuthenticatedCandidateFollow }), {
      method: "PUT",
      path: "/api/me/candidate-follows",
      body: JSON.stringify({
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: true,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(setAuthenticatedCandidateFollow).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticated candidate follow lookup is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "GET",
      path: "/api/me/candidate-follows",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated candidate follow lookup is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticated candidate follow storage is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "PUT",
      path: "/api/me/candidate-follows",
      body: JSON.stringify({
        candidate_id: "22222222-2222-4222-8222-222222222222",
        following: true,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated candidate follow storage is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated candidate follows without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const listAuthenticatedCandidateFollows = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedCandidateFollows }),
      {
        method: "GET",
        path: "/api/me/candidate-follows",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedCandidateFollows).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated candidate follow updates without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const setAuthenticatedCandidateFollow = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedCandidateFollow }),
      {
        method: "PUT",
        path: "/api/me/candidate-follows",
        body: JSON.stringify({
          candidate_id: "22222222-2222-4222-8222-222222222222",
          following: true,
        }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(setAuthenticatedCandidateFollow).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects invalid authenticated candidate follow payloads before calling the handler", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedCandidateFollow = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedCandidateFollow }),
      {
        method: "PUT",
        path: "/api/me/candidate-follows",
        body: JSON.stringify({ candidate_id: "not-a-uuid", following: true }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "candidate_id must be a valid UUID: not-a-uuid",
      },
    });
    expect(setAuthenticatedCandidateFollow).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content types before parsing authenticated candidate follow bodies", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedCandidateFollow = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedCandidateFollow }),
      {
        method: "PUT",
        path: "/api/me/candidate-follows",
        body: JSON.stringify({
          candidate_id: "22222222-2222-4222-8222-222222222222",
          following: true,
        }),
        headers: { "content-type": "text/plain" },
      }
    );

    expect(response.statusCode).toBe(415);
    expect(response.body).toEqual({
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      },
    });
    expect(resolveAuthenticatedUserId).not.toHaveBeenCalled();
    expect(setAuthenticatedCandidateFollow).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects unsupported authenticated candidate follow methods", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedCandidateFollows = vi.fn();
    const setAuthenticatedCandidateFollow = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress,
        resolveAuthenticatedUserId,
        listAuthenticatedCandidateFollows,
        setAuthenticatedCandidateFollow,
      }),
      {
        method: "POST",
        path: "/api/me/candidate-follows",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET, PUT");
    expect(response.body).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Use GET or PUT /api/me/candidate-follows",
      },
    });
    expect(resolveAuthenticatedUserId).not.toHaveBeenCalled();
    expect(listAuthenticatedCandidateFollows).not.toHaveBeenCalled();
    expect(setAuthenticatedCandidateFollow).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps authenticated candidate follow user errors to unauthorized", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedCandidateFollows = vi
      .fn()
      .mockRejectedValue(new UserCandidateFollowsError("user_not_found", "User not found"));

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedCandidateFollows }),
      {
        method: "GET",
        path: "/api/me/candidate-follows",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedCandidateFollows).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps missing/deleted/merged candidate follow targets to not_found", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const setAuthenticatedCandidateFollow = vi
      .fn()
      .mockRejectedValue(new UserCandidateFollowsError("candidate_not_found", "Candidate not found"));

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, setAuthenticatedCandidateFollow }),
      {
        method: "PUT",
        path: "/api/me/candidate-follows",
        body: JSON.stringify({
          candidate_id: "22222222-2222-4222-8222-222222222222",
          following: true,
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "not_found",
        message: "Candidate not found",
      },
    });
    expect(setAuthenticatedCandidateFollow).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999", {
      candidateId: "22222222-2222-4222-8222-222222222222",
      following: true,
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves authenticated research area preferences for the current user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedResearchAreaPreferences = vi.fn().mockResolvedValue({
      preferences: [
        {
          research_area_id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: null,
          rank: 1,
        },
      ],
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedResearchAreaPreferences }),
      {
        method: "GET",
        path: "/api/me/research-area-preferences",
        headers: { "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      preferences: [
        {
          research_area_id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: null,
          rank: 1,
        },
      ],
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(listAuthenticatedResearchAreaPreferences).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999");
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated research area preferences lookup when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const listAuthenticatedResearchAreaPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, listAuthenticatedResearchAreaPreferences }),
      {
        method: "GET",
        path: "/api/me/research-area-preferences",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticated research area preferences lookup is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "GET",
      path: "/api/me/research-area-preferences",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated research area preferences lookup is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated research area preferences lookup without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const listAuthenticatedResearchAreaPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedResearchAreaPreferences }),
      {
        method: "GET",
        path: "/api/me/research-area-preferences",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("maps authenticated research area preference reader errors to unauthorized", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const listAuthenticatedResearchAreaPreferences = vi
      .fn()
      .mockRejectedValue(new UserResearchAreaPreferencesError("user_not_found", "User not found"));

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, listAuthenticatedResearchAreaPreferences }),
      {
        method: "GET",
        path: "/api/me/research-area-preferences",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedResearchAreaPreferences).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999"
    );
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("replaces authenticated research area preferences for the current user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const replaceAuthenticatedResearchAreaPreferences = vi.fn().mockResolvedValue({
      preferences: [
        {
          research_area_id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: null,
          rank: 1,
        },
        {
          research_area_id: "33333333-3333-4333-8333-333333333333",
          slug: "healthcare_affordability",
          name: "Healthcare Affordability",
          description: null,
          rank: null,
        },
      ],
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, replaceAuthenticatedResearchAreaPreferences }),
      {
        method: "PUT",
        path: "/api/me/research-area-preferences",
        body: JSON.stringify({
          preferences: [
            { research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1 },
            { research_area_id: "33333333-3333-4333-8333-333333333333", rank: null },
          ],
        }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      preferences: [
        {
          research_area_id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: null,
          rank: 1,
        },
        {
          research_area_id: "33333333-3333-4333-8333-333333333333",
          slug: "healthcare_affordability",
          name: "Healthcare Affordability",
          description: null,
          rank: null,
        },
      ],
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(replaceAuthenticatedResearchAreaPreferences).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      [
        { researchAreaId: "22222222-2222-4222-8222-222222222222", rank: 1 },
        { researchAreaId: "33333333-3333-4333-8333-333333333333", rank: null },
      ]
    );
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("clears authenticated research area preferences", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const replaceAuthenticatedResearchAreaPreferences = vi.fn().mockResolvedValue({ preferences: [] });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, replaceAuthenticatedResearchAreaPreferences }),
      {
        method: "PUT",
        path: "/api/me/research-area-preferences",
        body: JSON.stringify({ preferences: [] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ preferences: [] });
    expect(replaceAuthenticatedResearchAreaPreferences).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      []
    );
  });

  it("rejects authenticated research area preference replacement when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const replaceAuthenticatedResearchAreaPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, replaceAuthenticatedResearchAreaPreferences }),
      {
        method: "PUT",
        path: "/api/me/research-area-preferences",
        body: JSON.stringify({ preferences: [] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticated research area preference storage is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "PUT",
      path: "/api/me/research-area-preferences",
      body: JSON.stringify({ preferences: [] }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated research area preference storage is not configured",
      },
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects authenticated research area preference replacement without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const replaceAuthenticatedResearchAreaPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, replaceAuthenticatedResearchAreaPreferences }),
      {
        method: "PUT",
        path: "/api/me/research-area-preferences",
        body: JSON.stringify({ preferences: [] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
  });

  it("rejects invalid research area preference payloads before calling storage", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const replaceAuthenticatedResearchAreaPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, replaceAuthenticatedResearchAreaPreferences }),
      {
        method: "PUT",
        path: "/api/me/research-area-preferences",
        body: JSON.stringify({ preferences: [{ research_area_id: "not-a-uuid" }] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "preferences contains invalid research_area_id: not-a-uuid",
      },
    });
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content types before parsing research area preference replacement bodies", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const replaceAuthenticatedResearchAreaPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, replaceAuthenticatedResearchAreaPreferences }),
      {
        method: "PUT",
        path: "/api/me/research-area-preferences",
        body: JSON.stringify({ preferences: [] }),
        headers: { "content-type": "text/plain" },
      }
    );

    expect(response.statusCode).toBe(415);
    expect(response.body).toEqual({
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      },
    });
    expect(resolveAuthenticatedUserId).not.toHaveBeenCalled();
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
  });

  it("maps authenticated research area preference replacement errors to API errors", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const replaceAuthenticatedResearchAreaPreferences = vi
      .fn()
      .mockRejectedValue(
        new UserResearchAreaPreferencesError("unselectable_research_area_ids", "Research area cannot be selected")
      );

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, replaceAuthenticatedResearchAreaPreferences }),
      {
        method: "PUT",
        path: "/api/me/research-area-preferences",
        body: JSON.stringify({ preferences: [{ research_area_id: "22222222-2222-4222-8222-222222222222" }] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Research area cannot be selected",
      },
    });
    expect(replaceAuthenticatedResearchAreaPreferences).toHaveBeenCalledOnce();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("initializes authenticated user districts", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi.fn().mockResolvedValue({
      status: "initialized",
      districtCount: 1,
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/me/districts/initialize",
        body: JSON.stringify({ district_ids: [districtId, districtId.toUpperCase()] }),
        headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: "initialized",
      district_count: 1,
    });
    expect(resolveAuthenticatedUserId).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-user-id": "99999999-9999-4999-8999-999999999999" }),
    });
    expect(initializeUserDistricts).toHaveBeenCalledWith({
      userId: "99999999-9999-4999-8999-999999999999",
      districtIds: [districtId],
    });
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("supports anonymous resolve followed by post-signup district initialization", async () => {
    const resolvedAddressWithUuidDistrict = {
      ...resolvedAddress,
      districts: resolvedAddress.districts.map((district) => ({ ...district, id: districtId })),
    };
    const resolveAddress = vi.fn().mockResolvedValue(resolvedAddressWithUuidDistrict);
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi.fn().mockResolvedValue({
      status: "initialized",
      districtCount: 1,
    });
    const app = createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts });

    const resolveResponse = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/address/resolve",
      body: JSON.stringify({ address: "3921 Harlan Ave Baldwin Park CA 91706", accepted_terms_version: CURRENT_TERMS_VERSION }),
      headers: { "content-type": "application/json" },
    });
    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.body).toEqual({
      matched_address: resolvedAddressWithUuidDistrict.matched_address,
      address_match_count: resolvedAddressWithUuidDistrict.address_match_count,
      districts: resolvedAddressWithUuidDistrict.districts,
      scope: "exact",
    });
    expect(initializeUserDistricts).not.toHaveBeenCalled();

    const returnedDistrictIds = (resolveResponse.body as { districts: Array<{ id: string }> }).districts.map(
      (district) => district.id
    );
    const initializeResponse = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/me/districts/initialize",
      body: JSON.stringify({ district_ids: returnedDistrictIds }),
      headers: { "content-type": "application/json", "x-user-id": "99999999-9999-4999-8999-999999999999" },
    });

    expect(initializeResponse.statusCode).toBe(200);
    expect(initializeResponse.body).toEqual({
      status: "initialized",
      district_count: 1,
    });
    expect(initializeUserDistricts).toHaveBeenCalledWith({
      userId: "99999999-9999-4999-8999-999999999999",
      districtIds: [districtId],
    });
  });

  it("returns already_initialized for users with existing saved districts", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi.fn().mockResolvedValue({
      status: "already_initialized",
      districtCount: 7,
    });

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/me/districts/initialize",
        body: JSON.stringify({ district_ids: [districtId] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: "already_initialized",
      district_count: 7,
    });
    expect(initializeUserDistricts).toHaveBeenCalledOnce();
  });

  it("rejects district initialization when authentication is not configured", async () => {
    const resolveAddress = vi.fn();
    const initializeUserDistricts = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, initializeUserDistricts }), {
      method: "POST",
      path: "/api/me/districts/initialize",
      body: JSON.stringify({ district_ids: [districtId] }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(initializeUserDistricts).not.toHaveBeenCalled();
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("returns 500 when district initialization storage is not configured", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, resolveAuthenticatedUserId }), {
      method: "POST",
      path: "/api/me/districts/initialize",
      body: JSON.stringify({ district_ids: [districtId] }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "User district initialization is not configured",
      },
    });
  });

  it("rejects district initialization without an authenticated user", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(null);
    const initializeUserDistricts = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/me/districts/initialize",
        body: JSON.stringify({ district_ids: [districtId] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(initializeUserDistricts).not.toHaveBeenCalled();
  });

  it("rejects invalid district initialization payloads before calling the store", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/me/districts/initialize",
        body: JSON.stringify({ district_ids: ["not-a-uuid"] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "district_ids contains invalid UUID: not-a-uuid",
      },
    });
    expect(initializeUserDistricts).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content types before parsing district initialization bodies", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/me/districts/initialize",
        body: JSON.stringify({ district_ids: [districtId] }),
        headers: { "content-type": "text/plain" },
      }
    );

    expect(response.statusCode).toBe(415);
    expect(response.body).toEqual({
      error: {
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      },
    });
    expect(resolveAuthenticatedUserId).not.toHaveBeenCalled();
    expect(initializeUserDistricts).not.toHaveBeenCalled();
  });

  it("rejects too many district IDs before calling the initialize store", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi.fn();
    const districtIds = Array.from({ length: MAX_INITIALIZE_DISTRICT_IDS + 1 }, (_value, index) =>
      makeDistrictId(index + 1)
    );

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/me/districts/initialize",
        body: JSON.stringify({ district_ids: districtIds }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: `district_ids supports at most ${MAX_INITIALIZE_DISTRICT_IDS} UUIDs`,
      },
    });
    expect(initializeUserDistricts).not.toHaveBeenCalled();
  });

  it("maps initialize store errors to API errors", async () => {
    const resolveAddress = vi.fn();
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999");
    const initializeUserDistricts = vi
      .fn()
      .mockRejectedValue(new InitializeUserDistrictsError("unknown_district_ids", `Unknown district IDs: ${districtId}`));

    const response = await invokeExpressApp(
      createApiApp({ resolveAddress, resolveAuthenticatedUserId, initializeUserDistricts }),
      {
        method: "POST",
        path: "/api/me/districts/initialize",
        body: JSON.stringify({ district_ids: [districtId] }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: `Unknown district IDs: ${districtId}`,
      },
    });
  });

  it("dispatches routes correctly when mounted under a path prefix", async () => {
    const resolveAddress = vi.fn();
    const lookupBallotSummaries = vi.fn().mockResolvedValue({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });
    const mountedApp = express();
    mountedApp.use("/v1", createApiApp({ resolveAddress, lookupBallotSummaries }));

    const response = await invokeExpressApp(mountedApp, {
      method: "GET",
      path: `/v1/api/ballot?district_ids=${districtId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      district_ids: [districtId],
      districts: [],
      elections: [],
    });
    expect(lookupBallotSummaries).toHaveBeenCalledWith([districtId], {});
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("rejects invalid ballot district IDs before lookup", async () => {
    const resolveAddress = vi.fn();
    const lookupBallotSummaries = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupBallotSummaries }), {
      method: "GET",
      path: "/api/ballot?district_ids=not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Query parameter district_ids contains invalid UUID: not-a-uuid",
      },
    });
    expect(lookupBallotSummaries).not.toHaveBeenCalled();
  });

  it("rejects missing ballot district IDs before lookup", async () => {
    const resolveAddress = vi.fn();
    const lookupBallotSummaries = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupBallotSummaries }), {
      method: "GET",
      path: "/api/ballot",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Query parameter district_ids must include at least one district UUID",
      },
    });
    expect(lookupBallotSummaries).not.toHaveBeenCalled();
  });

  it("rejects too many ballot district IDs before lookup", async () => {
    const resolveAddress = vi.fn();
    const lookupBallotSummaries = vi.fn();
    const tooManyDistrictIds = Array.from(
      { length: 51 },
      (_, index) => `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`
    ).join(",");

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupBallotSummaries }), {
      method: "GET",
      path: `/api/ballot?district_ids=${tooManyDistrictIds}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Query parameter district_ids supports at most 50 UUIDs",
      },
    });
    expect(lookupBallotSummaries).not.toHaveBeenCalled();
  });

  it("returns 500 when ballot summary lookup is not configured", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "GET",
      path: `/api/ballot?district_ids=${districtId}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Ballot lookup is not configured",
      },
    });
  });

  it("returns 404 when election detail is missing", async () => {
    const resolveAddress = vi.fn();
    const lookupElectionDetail = vi.fn().mockResolvedValue(null);

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupElectionDetail }), {
      method: "GET",
      path: `/api/elections/${electionId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "not_found",
        message: "Election not found",
      },
    });
    expect(lookupElectionDetail).toHaveBeenCalledWith(electionId);
  });

  it("rejects invalid election detail IDs before lookup", async () => {
    const resolveAddress = vi.fn();
    const lookupElectionDetail = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupElectionDetail }), {
      method: "GET",
      path: "/api/elections/not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Election detail path contains invalid UUID: not-a-uuid",
      },
    });
    expect(lookupElectionDetail).not.toHaveBeenCalled();
  });

  it("rejects malformed election detail paths before lookup", async () => {
    const resolveAddress = vi.fn();
    const lookupElectionDetail = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupElectionDetail }), {
      method: "GET",
      path: `/api/elections/${electionId}/extra`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        message: "Election detail path must be /api/elections/:election_id",
      },
    });
    expect(lookupElectionDetail).not.toHaveBeenCalled();
  });

  it("returns 500 when election detail lookup is not configured", async () => {
    const resolveAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
      method: "GET",
      path: `/api/elections/${electionId}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Election detail lookup is not configured",
      },
    });
  });

  describe("GET /api/elections/:election_id/candidates/:candidate_id/finance", () => {
    const candidateId = "44444444-4444-4444-8444-444444444444";
    const financePath = `/api/elections/${electionId}/candidates/${candidateId}/finance`;

    it("serves one candidate's finance summary without touching the election detail lookup", async () => {
      const resolveAddress = vi.fn();
      const lookupElectionDetail = vi.fn();
      // satisfies pins the fixture to the real BallotLookupFinanceSummary
      // contract (editor/IDE-checked only — backend tsc does not cover
      // tests) so the route test cannot document a made-up shape.
      const financeResult = {
        finance_summary: {
          source: "FEC",
          cycle: 2026,
          fec_candidate_id: "S6CA00001",
          last_synced_at: "2026-07-01T00:00:00.000Z",
          direct_campaign: {
            total_raised: 1200,
            total_spent: 800,
            cash_on_hand: 400,
            debts_owed: null,
            top_occupations: [],
            top_industries: [],
          },
          outside_spending: {
            support_total: null,
            oppose_total: null,
            top_supporting_groups: [],
            top_opposing_groups: [],
            top_supporting_industries: [],
            top_opposing_industries: [],
          },
          backing_summary: {
            top_direct_donor_occupations: [],
            top_outside_supporting_industries: [],
          },
        },
      } satisfies CandidateElectionFinanceResult;
      const lookupCandidateElectionFinance = vi.fn().mockResolvedValue(financeResult);

      const response = await invokeExpressApp(
        createApiApp({ resolveAddress, lookupElectionDetail, lookupCandidateElectionFinance }),
        {
          method: "GET",
          path: financePath,
        }
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(financeResult);
      expect(lookupCandidateElectionFinance).toHaveBeenCalledWith(electionId, candidateId);
      expect(lookupElectionDetail).not.toHaveBeenCalled();
    });

    it("serves an explicit null finance summary for a covered pairing without finance data", async () => {
      const resolveAddress = vi.fn();
      const lookupCandidateElectionFinance = vi.fn().mockResolvedValue({ finance_summary: null });

      const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateElectionFinance }), {
        method: "GET",
        path: financePath,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ finance_summary: null });
    });

    it("returns 404 when the candidate/election pairing is missing", async () => {
      const resolveAddress = vi.fn();
      const lookupCandidateElectionFinance = vi.fn().mockResolvedValue(null);

      const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateElectionFinance }), {
        method: "GET",
        path: financePath,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: "not_found",
          message: "Candidate election not found",
        },
      });
      expect(lookupCandidateElectionFinance).toHaveBeenCalledWith(electionId, candidateId);
    });

    it("keeps wrong methods as 405 responses", async () => {
      const resolveAddress = vi.fn();
      const lookupCandidateElectionFinance = vi.fn();

      const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateElectionFinance }), {
        method: "POST",
        path: financePath,
      });

      expect(response.statusCode).toBe(405);
      expect(response.headers).toMatchObject({ allow: "GET" });
      expect(response.body).toEqual({
        error: {
          code: "method_not_allowed",
          message: "Use GET /api/elections/:election_id/candidates/:candidate_id/finance",
        },
      });
      expect(lookupCandidateElectionFinance).not.toHaveBeenCalled();
    });

    it("rejects invalid election UUIDs before lookup", async () => {
      const resolveAddress = vi.fn();
      const lookupCandidateElectionFinance = vi.fn();

      const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateElectionFinance }), {
        method: "GET",
        path: `/api/elections/not-a-uuid/candidates/${candidateId}/finance`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: "invalid_request",
          message: "Candidate election finance path contains invalid election UUID: not-a-uuid",
        },
      });
      expect(lookupCandidateElectionFinance).not.toHaveBeenCalled();
    });

    it("rejects invalid candidate UUIDs before lookup", async () => {
      const resolveAddress = vi.fn();
      const lookupCandidateElectionFinance = vi.fn();

      const response = await invokeExpressApp(createApiApp({ resolveAddress, lookupCandidateElectionFinance }), {
        method: "GET",
        path: `/api/elections/${electionId}/candidates/not-a-uuid/finance`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: "invalid_request",
          message: "Candidate election finance path contains invalid candidate UUID: not-a-uuid",
        },
      });
      expect(lookupCandidateElectionFinance).not.toHaveBeenCalled();
    });

    it("returns 500 when the finance lookup is not configured", async () => {
      const resolveAddress = vi.fn();

      const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
        method: "GET",
        path: financePath,
      });

      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: "internal_error",
          message: "Candidate election finance lookup is not configured",
        },
      });
    });
  });
});

describe("GET /api/me", () => {
  const userId = "99999999-9999-4999-8999-999999999999";
  const identity = { email: "voter@example.com", first_name: "Val", email_verified: false, has_password: true };

  it("returns the session holder's identity", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const getAuthenticatedUser = vi.fn().mockResolvedValue(identity);

    const response = await invokeExpressApp(createApiApp({ resolveAuthenticatedUserId, getAuthenticatedUser }), {
      method: "GET",
      path: "/api/me",
      headers: { "x-user-id": userId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ user: identity });
    expect(getAuthenticatedUser).toHaveBeenCalledWith(userId);
  });

  it("is not gated on email verification", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const getAuthenticatedUser = vi.fn().mockResolvedValue(identity);
    // Other /api/me routes 403 on this; /api/me must not — the frontend
    // reads email_verified from it to render the unverified state.
    const lookupAuthenticatedUserEmailVerified = vi.fn().mockResolvedValue(false);

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, getAuthenticatedUser, lookupAuthenticatedUserEmailVerified }),
      {
        method: "GET",
        path: "/api/me",
        headers: { "x-user-id": userId },
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ user: identity });
  });

  it("returns 401 without a session", async () => {
    const getAuthenticatedUser = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId: () => null, getAuthenticatedUser }),
      {
        method: "GET",
        path: "/api/me",
      }
    );

    expect(response.statusCode).toBe(401);
    expect(getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("returns 401 when the session's user row is gone", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const getAuthenticatedUser = vi
      .fn()
      .mockRejectedValue(new UserIdentityError("user_not_found", "User not found"));

    const response = await invokeExpressApp(createApiApp({ resolveAuthenticatedUserId, getAuthenticatedUser }), {
      method: "GET",
      path: "/api/me",
      headers: { "x-user-id": userId },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects non-GET methods with 405", async () => {
    const response = await invokeExpressApp(createApiApp({}), {
      method: "POST",
      path: "/api/me",
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET, PUT, DELETE");
  });

  it("returns 500 when the user lookup is not configured", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);

    const response = await invokeExpressApp(createApiApp({ resolveAuthenticatedUserId }), {
      method: "GET",
      path: "/api/me",
      headers: { "x-user-id": userId },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Authenticated user lookup is not configured",
      },
    });
  });
});

describe("POST /api/me/terms-acceptance", () => {
  const userId = "99999999-9999-4999-8999-999999999999";
  const identity = {
    email: "voter@example.com",
    first_name: "Val",
    email_verified: false,
    accepted_terms_version: CURRENT_TERMS_VERSION,
    has_password: true,
  };

  it("records acceptance of the current version and returns the identity", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const acceptAuthenticatedUserTerms = vi.fn().mockResolvedValue(identity);

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, acceptAuthenticatedUserTerms }),
      {
        method: "POST",
        path: "/api/me/terms-acceptance",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ accepted_terms_version: CURRENT_TERMS_VERSION }),
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ user: identity });
    expect(acceptAuthenticatedUserTerms).toHaveBeenCalledWith(userId, CURRENT_TERMS_VERSION);
  });

  it("rejects any version other than the current one", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const acceptAuthenticatedUserTerms = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, acceptAuthenticatedUserTerms }),
      {
        method: "POST",
        path: "/api/me/terms-acceptance",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ accepted_terms_version: "0.9" }),
      }
    );

    expect(response.statusCode).toBe(422);
    expect(acceptAuthenticatedUserTerms).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const acceptAuthenticatedUserTerms = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId: () => null, acceptAuthenticatedUserTerms }),
      {
        method: "POST",
        path: "/api/me/terms-acceptance",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accepted_terms_version: CURRENT_TERMS_VERSION }),
      }
    );

    expect(response.statusCode).toBe(401);
    expect(acceptAuthenticatedUserTerms).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods with 405", async () => {
    const response = await invokeExpressApp(createApiApp({}), {
      method: "GET",
      path: "/api/me/terms-acceptance",
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });
});

describe("email preferences and unsubscribe endpoints", () => {
  const userId = "99999999-9999-4999-8999-999999999999";
  const prefs = {
    email_digest: true,
    email_election_reminders: true,
    email_new_election_alerts: false,
    email_issue_updates: true,
    email_member_newsletter: true,
  };

  it("serves and stores email preferences via GET and PUT /api/me/email-preferences", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const getAuthenticatedEmailPreferences = vi.fn().mockResolvedValue(prefs);
    const setAuthenticatedEmailPreferences = vi.fn().mockResolvedValue({ ...prefs, email_digest: false });
    const app = createApiApp({
      resolveAuthenticatedUserId,
      getAuthenticatedEmailPreferences,
      setAuthenticatedEmailPreferences,
    });

    const getResponse = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/me/email-preferences",
      headers: { "x-user-id": userId },
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body).toEqual(prefs);

    const putResponse = await invokeExpressApp(app, {
      method: "PUT",
      path: "/api/me/email-preferences",
      headers: { "x-user-id": userId, "content-type": "application/json" },
      body: JSON.stringify({ ...prefs, email_digest: false }),
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.body).toEqual({ ...prefs, email_digest: false });
    expect(setAuthenticatedEmailPreferences).toHaveBeenCalledWith(userId, { ...prefs, email_digest: false });
  });

  it("rejects a non-boolean email preference with 400", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const setAuthenticatedEmailPreferences = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, setAuthenticatedEmailPreferences }),
      {
        method: "PUT",
        path: "/api/me/email-preferences",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ ...prefs, email_digest: "yes" }),
      }
    );

    expect(response.statusCode).toBe(400);
    expect(setAuthenticatedEmailPreferences).not.toHaveBeenCalled();
  });

  it("requires auth for email preferences", async () => {
    const response = await invokeExpressApp(createApiApp({}), {
      method: "GET",
      path: "/api/me/email-preferences",
    });
    expect(response.statusCode).toBe(401);
  });

  it("GET renders a confirmation form without mutating (mail scanners GET links)", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");

    const response = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def",
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/html");
    // Confirmation form, not a completed unsubscribe.
    expect(String(response.rawBody)).toContain("<form method=\"post\"");
    expect(String(response.rawBody)).not.toContain("You have been unsubscribed");
    // The advertised opt-in is pre-checked; the others are offered unchecked.
    expect(String(response.rawBody)).toContain('name="pref" value="digest" checked');
    expect(String(response.rawBody)).toContain('name="pref" value="election_reminders">');
    expect(String(response.rawBody)).toContain('name="pref" value="all">');
    expect(String(response.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "confirm", ["digest"]);
  });

  it("POST (RFC 8058 one-click and the confirmation form) performs the unsubscribe", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");

    const response = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def",
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.rawBody)).toContain("You have been unsubscribed");
    expect(String(response.rawBody)).toContain("candidate update digest emails");
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "execute", ["digest"]);
  });

  it("scopes the unsubscribe to new-election alerts via the pref param", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");
    const app = createApiApp({ unsubscribeFromEmailNotifications });

    const confirm = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=new_election_alerts",
    });
    expect(confirm.statusCode).toBe(200);
    expect(String(confirm.rawBody)).toContain("New elections in your districts");
    // The confirmation form pre-checks the same scope.
    expect(String(confirm.rawBody)).toContain('name="pref" value="new_election_alerts" checked');
    expect(String(confirm.rawBody)).not.toContain('value="digest" checked');
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "confirm", ["new_election_alerts"]);

    const execute = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=new_election_alerts",
    });
    expect(execute.statusCode).toBe(200);
    expect(String(execute.rawBody)).toContain("unsubscribed from new election alert emails");
    expect(unsubscribeFromEmailNotifications).toHaveBeenLastCalledWith("v1.abc.def", "execute", [
      "new_election_alerts",
    ]);
  });

  it("scopes the unsubscribe to election reminders via the pref param", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");
    const app = createApiApp({ unsubscribeFromEmailNotifications });

    const confirm = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=election_reminders",
    });
    expect(confirm.statusCode).toBe(200);
    expect(String(confirm.rawBody)).toContain("Election-day reminder");
    // The confirmation form pre-checks the same scope.
    expect(String(confirm.rawBody)).toContain('name="pref" value="election_reminders" checked');
    expect(String(confirm.rawBody)).not.toContain('value="digest" checked');
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "confirm", ["election_reminders"]);

    const execute = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=election_reminders",
    });
    expect(execute.statusCode).toBe(200);
    expect(String(execute.rawBody)).toContain("unsubscribed from election reminder emails");
    expect(unsubscribeFromEmailNotifications).toHaveBeenLastCalledWith("v1.abc.def", "execute", [
      "election_reminders",
    ]);
  });

  it("scopes the unsubscribe to issue updates via the pref param", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");
    const app = createApiApp({ unsubscribeFromEmailNotifications });

    const confirm = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=issue_updates",
    });
    expect(confirm.statusCode).toBe(200);
    expect(String(confirm.rawBody)).toContain("Updates about the issues you saved");
    // The confirmation form pre-checks the same scope.
    expect(String(confirm.rawBody)).toContain('name="pref" value="issue_updates" checked');
    expect(String(confirm.rawBody)).not.toContain('value="digest" checked');
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "confirm", ["issue_updates"]);

    const execute = await invokeExpressApp(app, {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=issue_updates",
    });
    expect(execute.statusCode).toBe(200);
    expect(String(execute.rawBody)).toContain("unsubscribed from emails about your saved issues");
    expect(unsubscribeFromEmailNotifications).toHaveBeenLastCalledWith("v1.abc.def", "execute", ["issue_updates"]);
  });

  it("confirmation form POST unsubscribes exactly the checked opt-ins", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");

    const response = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=digest",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "form=1&pref=election_reminders&pref=member_newsletter",
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.rawBody)).toContain(
      "unsubscribed from election reminder emails and member newsletter emails"
    );
    // The link's own opt-in was unchecked, so it stays on.
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "execute", [
      "election_reminders",
      "member_newsletter",
    ]);
  });

  it("confirmation form 'all' expands to every opt-in", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");

    const response = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "form=1&pref=digest&pref=all",
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.rawBody)).toContain("unsubscribed from all Elections Simplified notification emails");
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "execute", [
      "digest",
      "new_election_alerts",
      "election_reminders",
      "issue_updates",
      "member_newsletter",
    ]);
  });

  it("confirmation form with nothing checked changes nothing and asks again with the same scope", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");
    const app = createApiApp({ unsubscribeFromEmailNotifications });

    // Drive the real chain: the retry POST goes to whatever action the
    // rendered form carries, not to a hand-built URL.
    const confirm = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=member_newsletter",
    });
    const action = String(confirm.rawBody).match(/<form method="post" action="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(action).toBe("/api/email/unsubscribe?token=v1.abc.def&pref=member_newsletter");

    const response = await invokeExpressApp(app, {
      method: "POST",
      path: action ?? "",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "form=1",
    });

    expect(response.statusCode).toBe(400);
    expect(String(response.rawBody)).toContain("Choose at least one kind of email");
    expect(String(response.rawBody)).toContain("<form method=\"post\"");
    expect(String(response.rawBody)).not.toContain("You have been unsubscribed");
    // The retry page pre-checks the link's own opt-in, not the digest default.
    expect(String(response.rawBody)).toContain('value="member_newsletter" checked');
    expect(String(response.rawBody)).not.toContain('value="digest" checked');
    // Only token checks ran; nothing was executed.
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledTimes(2);
    expect(unsubscribeFromEmailNotifications).toHaveBeenLastCalledWith("v1.abc.def", "confirm", ["member_newsletter"]);
  });

  it("confirmation form rejects an unrecognized checkbox value", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");

    const response = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "form=1&pref=digest&pref=everything",
    });

    expect(response.statusCode).toBe(400);
    expect(unsubscribeFromEmailNotifications).not.toHaveBeenCalled();
  });

  it("RFC 8058 one-click POST bodies keep the link's own scope", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");

    const response = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=member_newsletter",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });

    expect(response.statusCode).toBe(200);
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledWith("v1.abc.def", "execute", ["member_newsletter"]);
  });

  it("links the pages to /me/settings when the public site origin is configured", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");
    const app = createApiApp({ unsubscribeFromEmailNotifications, publicSiteOrigin: "https://example.com/" });

    const confirm = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def",
    });
    // The page URL carries the token; the same-origin settings link must not
    // forward it as Referer.
    expect(String(confirm.rawBody)).toContain(
      'href="https://example.com/me/settings" referrerpolicy="no-referrer"'
    );

    const withoutOrigin = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def",
    });
    expect(String(withoutOrigin.rawBody)).not.toContain("href=");
    expect(String(withoutOrigin.rawBody)).toContain("account settings");
  });

  it("rejects an unrecognized pref value instead of flipping a different opt-in", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("ok");

    const response = await invokeExpressApp(createApiApp({ unsubscribeFromEmailNotifications }), {
      method: "POST",
      path: "/api/email/unsubscribe?token=v1.abc.def&pref=everything",
    });

    expect(response.statusCode).toBe(400);
    expect(unsubscribeFromEmailNotifications).not.toHaveBeenCalled();
  });

  it("returns a 400 HTML page for invalid or missing tokens", async () => {
    const unsubscribeFromEmailNotifications = vi.fn().mockResolvedValue("invalid_token");
    const app = createApiApp({ unsubscribeFromEmailNotifications });

    const badToken = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/email/unsubscribe?token=garbage",
    });
    expect(badToken.statusCode).toBe(400);
    expect(String(badToken.rawBody)).toContain("invalid");

    const missingToken = await invokeExpressApp(app, {
      method: "GET",
      path: "/api/email/unsubscribe",
    });
    expect(missingToken.statusCode).toBe(400);
    expect(unsubscribeFromEmailNotifications).toHaveBeenCalledTimes(1);
  });

  it("reports 500 when unsubscribe is not configured", async () => {
    const response = await invokeExpressApp(createApiApp({}), {
      method: "GET",
      path: "/api/email/unsubscribe?token=v1.abc.def",
    });
    expect(response.statusCode).toBe(500);
  });
});

describe("push token endpoints", () => {
  const userId = "99999999-9999-4999-8999-999999999999";
  const token = "ExponentPushToken[abc123]";

  it("registers a device token via POST /api/me/push-tokens", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const registerAuthenticatedPushToken = vi.fn().mockResolvedValue(undefined);

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, registerAuthenticatedPushToken }),
      {
        method: "POST",
        path: "/api/me/push-tokens",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ expo_push_token: token, native_token: "fcm-native", platform: "android" }),
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "registered" });
    expect(registerAuthenticatedPushToken).toHaveBeenCalledWith(userId, {
      expoPushToken: token,
      nativeToken: "fcm-native",
      platform: "android",
    });
  });

  it("registers without a native token (Expo Go / unavailable native token)", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const registerAuthenticatedPushToken = vi.fn().mockResolvedValue(undefined);

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, registerAuthenticatedPushToken }),
      {
        method: "POST",
        path: "/api/me/push-tokens",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ expo_push_token: token, platform: "ios" }),
      }
    );

    expect(response.statusCode).toBe(200);
    expect(registerAuthenticatedPushToken).toHaveBeenCalledWith(userId, {
      expoPushToken: token,
      nativeToken: null,
      platform: "ios",
    });
  });

  it("rejects a registration with a bad platform with 400", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const registerAuthenticatedPushToken = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, registerAuthenticatedPushToken }),
      {
        method: "POST",
        path: "/api/me/push-tokens",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ expo_push_token: token, platform: "web" }),
      }
    );

    expect(response.statusCode).toBe(400);
    expect(registerAuthenticatedPushToken).not.toHaveBeenCalled();
  });

  it("rejects a registration without a token with 400", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const registerAuthenticatedPushToken = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, registerAuthenticatedPushToken }),
      {
        method: "POST",
        path: "/api/me/push-tokens",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ platform: "ios" }),
      }
    );

    expect(response.statusCode).toBe(400);
    expect(registerAuthenticatedPushToken).not.toHaveBeenCalled();
  });

  it("revokes a device token via DELETE /api/me/push-tokens", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const revokeAuthenticatedPushToken = vi.fn().mockResolvedValue(undefined);

    const response = await invokeExpressApp(
      createApiApp({ resolveAuthenticatedUserId, revokeAuthenticatedPushToken }),
      {
        method: "DELETE",
        path: "/api/me/push-tokens",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ expo_push_token: token }),
      }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "revoked" });
    expect(revokeAuthenticatedPushToken).toHaveBeenCalledWith(userId, token);
  });

  it("rejects unverified users with 403 (senders only deliver to verified accounts)", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);
    const lookupAuthenticatedUserEmailVerified = vi.fn().mockResolvedValue(false);
    const registerAuthenticatedPushToken = vi.fn();

    const response = await invokeExpressApp(
      createApiApp({
        resolveAuthenticatedUserId,
        lookupAuthenticatedUserEmailVerified,
        registerAuthenticatedPushToken,
      }),
      {
        method: "POST",
        path: "/api/me/push-tokens",
        headers: { "x-user-id": userId, "content-type": "application/json" },
        body: JSON.stringify({ expo_push_token: token, platform: "ios" }),
      }
    );

    expect(response.statusCode).toBe(403);
    expect(registerAuthenticatedPushToken).not.toHaveBeenCalled();
  });

  it("requires auth for push token registration", async () => {
    const response = await invokeExpressApp(createApiApp({}), {
      method: "POST",
      path: "/api/me/push-tokens",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expo_push_token: token, platform: "ios" }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects non-POST/DELETE methods with 405", async () => {
    const response = await invokeExpressApp(createApiApp({}), {
      method: "GET",
      path: "/api/me/push-tokens",
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST, DELETE");
  });

  it("returns 500 when registration is not configured", async () => {
    const resolveAuthenticatedUserId = vi.fn().mockReturnValue(userId);

    const response = await invokeExpressApp(createApiApp({ resolveAuthenticatedUserId }), {
      method: "POST",
      path: "/api/me/push-tokens",
      headers: { "x-user-id": userId, "content-type": "application/json" },
      body: JSON.stringify({ expo_push_token: token, platform: "ios" }),
    });
    expect(response.statusCode).toBe(500);
  });
});

describe("content report API", () => {
  it("serves anonymous POST /api/content-reports and echoes only the report id", async () => {
    const createContentReport = vi.fn().mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999" });

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn().mockResolvedValue(resolvedAddress), createContentReport }), {
      method: "POST",
      path: "/api/content-reports",
      body: JSON.stringify({
        entity_type: "candidate_record",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "This record seems wrong",
        suggested_source_url: "https://example.org/source",
        reporter_email: "reader@example.com",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({ report: { id: "99999999-9999-4999-8999-999999999999" } });
    expect(createContentReport).toHaveBeenCalledWith({
      entityType: "candidate_record",
      entityId: "22222222-2222-4222-8222-222222222222",
      message: "This record seems wrong",
      suggestedSourceUrl: "https://example.org/source",
      reporterEmail: "reader@example.com",
      userId: null,
    });
  });

  it("rejects a NUL character anywhere in the JSON body with 400 before the writer runs", async () => {
    const createContentReport = vi.fn().mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999" });

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn().mockResolvedValue(resolvedAddress), createContentReport }), {
      method: "POST",
      path: "/api/content-reports",
      body: JSON.stringify({
        entity_type: "candidate_record",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "This record seems wrong\u0000",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: { code: "invalid_request", message: "Request body must not contain NUL characters" },
    });
    expect(createContentReport).not.toHaveBeenCalled();
  });

  it("answers a deeply nested JSON body with 400 instead of overflowing the stack", async () => {
    const createContentReport = vi.fn().mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999" });
    // 7,000 nested arrays fit under the body-size limit and parse fine; a
    // recursive body walk would throw RangeError from body-parser's stream
    // callback and take the process down.
    const depth = 7000;

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn().mockResolvedValue(resolvedAddress), createContentReport }), {
      method: "POST",
      path: "/api/content-reports",
      body: "[".repeat(depth) + "]".repeat(depth),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: { code: "invalid_request", message: "Request body must be a JSON object" },
    });
    expect(createContentReport).not.toHaveBeenCalled();
  });

  it("attaches the trusted user id when a session is present", async () => {
    const createContentReport = vi.fn().mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999" });
    const resolveAuthenticatedUserId = vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111");

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress: vi.fn().mockResolvedValue(resolvedAddress),
        createContentReport,
        resolveAuthenticatedUserId,
      }),
      {
        method: "POST",
        path: "/api/content-reports",
        body: JSON.stringify({
          entity_type: "candidate",
          entity_id: "22222222-2222-4222-8222-222222222222",
          message: "Profile summary has a typo",
        }),
        headers: { "content-type": "application/json" },
      }
    );

    expect(response.statusCode).toBe(201);
    expect(createContentReport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "11111111-1111-4111-8111-111111111111" })
    );
  });

  it("requires JSON and configured storage", async () => {
    const missingJson = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn().mockResolvedValue(resolvedAddress) }), {
      method: "POST",
      path: "/api/content-reports",
      body: JSON.stringify({
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
      }),
    });
    expect(missingJson.statusCode).toBe(415);

    const missingHandler = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn().mockResolvedValue(resolvedAddress) }), {
      method: "POST",
      path: "/api/content-reports",
      body: JSON.stringify({
        entity_type: "candidate",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "wrong",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(missingHandler.statusCode).toBe(500);
    expect(missingHandler.body).toEqual({
      error: { code: "internal_error", message: "Content report storage is not configured" },
    });
  });

  it("maps unknown report entities to 404", async () => {
    const { ContentReportError } = await import("../../src/pipeline/reports/contentReports.js");
    const createContentReport = vi.fn().mockRejectedValue(new ContentReportError("entity_not_found", "missing"));

    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn().mockResolvedValue(resolvedAddress), createContentReport }), {
      method: "POST",
      path: "/api/content-reports",
      body: JSON.stringify({
        entity_type: "election",
        entity_id: "22222222-2222-4222-8222-222222222222",
        message: "Date is wrong",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: { code: "not_found", message: "Reported content not found" } });
  });

  it("applies the dedicated content report rate limit", async () => {
    const createContentReport = vi.fn();
    const contentReportRateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await invokeExpressApp(
      createApiApp({
        resolveAddress: vi.fn().mockResolvedValue(resolvedAddress),
        createContentReport,
        contentReportRateLimit,
      }),
      {
        method: "POST",
        path: "/api/content-reports",
        body: JSON.stringify({
          entity_type: "candidate",
          entity_id: "22222222-2222-4222-8222-222222222222",
          message: "wrong",
        }),
        headers: { "content-type": "application/json" },
        remoteAddress: "203.0.113.10",
      }
    );

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(contentReportRateLimit).toHaveBeenCalledWith({
      clientIp: "203.0.113.10",
      method: "POST",
      pathname: "/api/content-reports",
    });
    expect(createContentReport).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods", async () => {
    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn().mockResolvedValue(resolvedAddress) }), {
      method: "GET",
      path: "/api/content-reports",
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
    expect(response.body).toEqual({ error: { code: "method_not_allowed", message: "Use POST /api/content-reports" } });
  });
});

describe("chatbot feedback endpoint", () => {
  const userId = "99999999-9999-4999-8999-999999999999";

  function feedbackApp(overrides: Record<string, unknown> = {}) {
    return createApiApp({
      resolveAddress: vi.fn(),
      resolveAuthenticatedUserId: vi.fn().mockReturnValue(userId),
      lookupAuthenticatedUserEmailVerified: vi.fn().mockResolvedValue(true),
      submitChatbotFeedback: vi.fn().mockResolvedValue("ok"),
      ...overrides,
    });
  }

  it("404s (never 405) when the chatbot is not wired, hiding the feature", async () => {
    const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn() }), {
      method: "GET",
      path: "/api/chatbot/feedback",
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("rejects non-POST methods when wired", async () => {
    const response = await invokeExpressApp(feedbackApp(), { method: "GET", path: "/api/chatbot/feedback" });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });

  it("requires an authenticated, verified user", async () => {
    const submitChatbotFeedback = vi.fn();
    const anonymous = await invokeExpressApp(
      feedbackApp({ resolveAuthenticatedUserId: vi.fn().mockReturnValue(null), submitChatbotFeedback }),
      {
        method: "POST",
        path: "/api/chatbot/feedback",
        body: JSON.stringify({ token: "t.s", verdict: "up" }),
        headers: { "content-type": "application/json" },
      }
    );
    expect(anonymous.statusCode).toBe(401);

    const unverified = await invokeExpressApp(
      feedbackApp({ lookupAuthenticatedUserEmailVerified: vi.fn().mockResolvedValue(false), submitChatbotFeedback }),
      {
        method: "POST",
        path: "/api/chatbot/feedback",
        body: JSON.stringify({ token: "t.s", verdict: "up" }),
        headers: { "content-type": "application/json" },
      }
    );
    expect(unverified.statusCode).toBe(403);
    expect(submitChatbotFeedback).not.toHaveBeenCalled();
  });

  it("records a vote and answers ok", async () => {
    const submitChatbotFeedback = vi.fn().mockResolvedValue("ok");
    const response = await invokeExpressApp(feedbackApp({ submitChatbotFeedback }), {
      method: "POST",
      path: "/api/chatbot/feedback",
      body: JSON.stringify({ token: "payload.signature", verdict: "down" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(submitChatbotFeedback).toHaveBeenCalledWith("payload.signature", "down");
  });

  it("400s an invalid token and malformed bodies", async () => {
    const invalidToken = await invokeExpressApp(
      feedbackApp({ submitChatbotFeedback: vi.fn().mockResolvedValue("invalid_token") }),
      {
        method: "POST",
        path: "/api/chatbot/feedback",
        body: JSON.stringify({ token: "forged", verdict: "up" }),
        headers: { "content-type": "application/json" },
      }
    );
    expect(invalidToken.statusCode).toBe(400);
    expect(invalidToken.body).toEqual({ error: { code: "invalid_request", message: "Invalid feedback token" } });

    const badVerdict = await invokeExpressApp(feedbackApp(), {
      method: "POST",
      path: "/api/chatbot/feedback",
      body: JSON.stringify({ token: "t.s", verdict: "sideways" }),
      headers: { "content-type": "application/json" },
    });
    expect(badVerdict.statusCode).toBe(400);
  });
});

describe("GET /api/healthz", () => {
  it("answers 200 when the database probe resolves, without consulting the rate limiter", async () => {
    const checkDatabaseHealth = vi.fn().mockResolvedValue(undefined);
    const rateLimit = vi.fn(() => ({ allowed: false, retryAfterSeconds: 30 }));
    const response = await invokeExpressApp(
      createApiApp({ resolveAddress: vi.fn(), checkDatabaseHealth, rateLimit }),
      { method: "GET", path: "/api/healthz" }
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(checkDatabaseHealth).toHaveBeenCalledTimes(1);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("answers 503 when the probe rejects, without echoing the error", async () => {
    const checkDatabaseHealth = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await invokeExpressApp(createApiApp({ resolveAddress: vi.fn(), checkDatabaseHealth }), {
        method: "GET",
        path: "/api/healthz",
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).toEqual({ ok: false, reason: "database_unavailable" });
      expect(response.rawBody).not.toContain("ECONNREFUSED");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    } finally {
      warn.mockRestore();
    }
  });

  it("answers 503 when no database probe is configured, and 405 for non-GET", async () => {
    const app = createApiApp({ resolveAddress: vi.fn() });
    const unconfigured = await invokeExpressApp(app, { method: "GET", path: "/api/healthz" });
    expect(unconfigured.statusCode).toBe(503);
    expect(unconfigured.body).toEqual({ ok: false, reason: "database_check_not_configured" });

    const post = await invokeExpressApp(app, { method: "POST", path: "/api/healthz" });
    expect(post.statusCode).toBe(405);
    expect(post.headers.allow).toBe("GET");
  });
});
