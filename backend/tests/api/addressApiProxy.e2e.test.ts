import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrustedUserIdResolver } from "../../src/api/addressApiAuth.js";
import { createApiApp } from "../../src/api/apiServer.js";
import { CURRENT_TERMS_VERSION } from "../../src/constants/legal.js";
import type { AddressResolutionResult } from "../../src/pipeline/address/addressResolverService.js";

const e2eEnabled = process.env.ADDRESS_API_PROXY_E2E === "true";
const describeE2e = e2eEnabled ? describe : describe.skip;

const authenticatedUserId = "99999999-9999-4999-8999-999999999999";
const spoofedUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const districtId = "11111111-1111-4111-8111-111111111111";

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
      id: districtId,
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

type JsonResponse = {
  status: number;
  body: unknown;
};

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function writeProxyError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  response.statusCode = 502;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: { code: "proxy_error", message } }));
}

function createMockAuthProxy(apiBaseUrl: string): Server {
  const hopByHopHeaders = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);

  return createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      const targetUrl = new URL(request.url ?? "/", apiBaseUrl);
      const headers = new Headers();

      for (const [name, value] of Object.entries(request.headers)) {
        const lowerName = name.toLowerCase();
        if (hopByHopHeaders.has(lowerName) || lowerName === "x-user-id" || lowerName === "x-test-session") {
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            headers.append(name, item);
          }
        } else if (typeof value === "string") {
          headers.set(name, value);
        }
      }

      if (request.headers["x-test-session"] === "signed-in") {
        headers.set("x-user-id", authenticatedUserId);
      }

      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: body.length > 0 && request.method !== "GET" && request.method !== "HEAD" ? body : undefined,
        redirect: "manual",
      });

      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        response.setHeader(name, value);
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch((error) => writeProxyError(response, error));
  });
}

async function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function putJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function getJson(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

describeE2e("address API auth proxy E2E", () => {
  const resolveAddress = vi.fn();
  const initializeUserDistricts = vi.fn();
  const lookupAuthenticatedBallotSummaries = vi.fn();
  const updateAuthenticatedAddressDistricts = vi.fn();
  const listResearchAreas = vi.fn();
  const listAuthenticatedResearchAreaPreferences = vi.fn();
  const replaceAuthenticatedResearchAreaPreferences = vi.fn();
  let apiServer: Server | undefined;
  let proxyServer: Server | undefined;
  let proxyBaseUrl: string;

  beforeAll(async () => {
    const app = createApiApp({
      resolveAddress,
      resolveAuthenticatedUserId: createTrustedUserIdResolver("X-User-Id"),
      initializeUserDistricts,
      lookupAuthenticatedBallotSummaries,
      updateAuthenticatedAddressDistricts,
      listResearchAreas,
      listAuthenticatedResearchAreaPreferences,
      replaceAuthenticatedResearchAreaPreferences,
    });
    apiServer = createServer(app);
    const apiBaseUrl = await listen(apiServer);
    proxyServer = createMockAuthProxy(apiBaseUrl);
    proxyBaseUrl = await listen(proxyServer);
  });

  beforeEach(() => {
    resolveAddress.mockReset();
    resolveAddress.mockResolvedValue(resolvedAddress);
    initializeUserDistricts.mockReset();
    initializeUserDistricts.mockResolvedValue({ status: "initialized", districtCount: 1 });
    lookupAuthenticatedBallotSummaries.mockReset();
    lookupAuthenticatedBallotSummaries.mockResolvedValue({
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });
    updateAuthenticatedAddressDistricts.mockReset();
    updateAuthenticatedAddressDistricts.mockResolvedValue({
      matched_address: resolvedAddress.matched_address,
      address_match_count: resolvedAddress.address_match_count,
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });
    listResearchAreas.mockReset();
    listResearchAreas.mockResolvedValue({
      research_areas: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: null,
        },
      ],
    });
    listAuthenticatedResearchAreaPreferences.mockReset();
    listAuthenticatedResearchAreaPreferences.mockResolvedValue({
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
    replaceAuthenticatedResearchAreaPreferences.mockReset();
    replaceAuthenticatedResearchAreaPreferences.mockResolvedValue({
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
  });

  afterAll(async () => {
    await closeServer(proxyServer);
    await closeServer(apiServer);
  });

  it("resolves an address through a real proxy and keeps the address route read-only", async () => {
    const response = await postJson(proxyBaseUrl, "/api/address/resolve", {
      address: "3921 Harlan Ave Baldwin Park CA 91706",
      accepted_terms_version: CURRENT_TERMS_VERSION,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      matched_address: resolvedAddress.matched_address,
      address_match_count: resolvedAddress.address_match_count,
      districts: resolvedAddress.districts,
      scope: "exact",
    });
    expect(resolveAddress).toHaveBeenCalledWith(
      "3921 Harlan Ave Baldwin Park CA 91706",
      undefined,
      false,
      undefined,
      undefined
    );
    expect(initializeUserDistricts).not.toHaveBeenCalled();
  });

  it("strips client-supplied user IDs and initializes with the proxy-injected user ID", async () => {
    const response = await postJson(
      proxyBaseUrl,
      "/api/me/districts/initialize",
      { district_ids: [districtId] },
      {
        "x-test-session": "signed-in",
        "x-user-id": spoofedUserId,
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "initialized",
      district_count: 1,
    });
    expect(initializeUserDistricts).toHaveBeenCalledWith({
      userId: authenticatedUserId,
      districtIds: [districtId],
    });
    expect(initializeUserDistricts).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: spoofedUserId })
    );
  });

  it("strips client-supplied user IDs and loads the logged-in user's saved ballot", async () => {
    const response = await getJson(proxyBaseUrl, "/api/me/ballot", {
      "x-test-session": "signed-in",
      "x-user-id": spoofedUserId,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });
    // [ballot-personalized-ordering]: the handler forwards parsed sort options
    // ({} for a bare request) alongside the proxy-verified user id.
    expect(lookupAuthenticatedBallotSummaries).toHaveBeenCalledWith(authenticatedUserId, {});
    expect(lookupAuthenticatedBallotSummaries.mock.calls.every((call) => call[0] === authenticatedUserId)).toBe(true);
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("strips client-supplied user IDs and updates the logged-in user's saved address districts", async () => {
    const response = await putJson(
      proxyBaseUrl,
      "/api/me/address",
      { address: "3921 Harlan Ave Baldwin Park CA 91706" },
      {
        "x-test-session": "signed-in",
        "x-user-id": spoofedUserId,
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      matched_address: resolvedAddress.matched_address,
      address_match_count: resolvedAddress.address_match_count,
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });
    expect(updateAuthenticatedAddressDistricts).toHaveBeenCalledWith(
      authenticatedUserId,
      "3921 Harlan Ave Baldwin Park CA 91706",
      undefined
    );
    expect(updateAuthenticatedAddressDistricts).not.toHaveBeenCalledWith(spoofedUserId, expect.anything());
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("serves the public research area catalog without requiring an authenticated user", async () => {
    const response = await getJson(proxyBaseUrl, "/api/research-areas", {
      "x-user-id": spoofedUserId,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      research_areas: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          slug: "housing_affordability",
          name: "Housing Affordability",
          description: null,
        },
      ],
    });
    expect(listResearchAreas).toHaveBeenCalledOnce();
    expect(listAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
  });

  it("strips client-supplied user IDs and loads the logged-in user's research area preferences", async () => {
    const response = await getJson(proxyBaseUrl, "/api/me/research-area-preferences", {
      "x-test-session": "signed-in",
      "x-user-id": spoofedUserId,
    });

    expect(response.status).toBe(200);
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
    expect(listAuthenticatedResearchAreaPreferences).toHaveBeenCalledWith(authenticatedUserId);
    expect(listAuthenticatedResearchAreaPreferences).not.toHaveBeenCalledWith(spoofedUserId);
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("strips client-supplied user IDs and replaces the logged-in user's research area preferences", async () => {
    const response = await putJson(
      proxyBaseUrl,
      "/api/me/research-area-preferences",
      {
        preferences: [{ research_area_id: "22222222-2222-4222-8222-222222222222", rank: 1 }],
      },
      {
        "x-test-session": "signed-in",
        "x-user-id": spoofedUserId,
      }
    );

    expect(response.status).toBe(200);
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
    expect(replaceAuthenticatedResearchAreaPreferences).toHaveBeenCalledWith(authenticatedUserId, [
      { researchAreaId: "22222222-2222-4222-8222-222222222222", rank: 1 },
    ]);
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalledWith(spoofedUserId, expect.anything());
    expect(resolveAddress).not.toHaveBeenCalled();
  });

  it("fails closed when loading preferences and the proxy does not inject an authenticated user ID", async () => {
    const response = await getJson(proxyBaseUrl, "/api/me/research-area-preferences", {
      "x-user-id": spoofedUserId,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(listAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
  });

  it("fails closed when saving preferences and the proxy does not inject an authenticated user ID", async () => {
    const response = await putJson(
      proxyBaseUrl,
      "/api/me/research-area-preferences",
      { preferences: [] },
      { "x-user-id": spoofedUserId }
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(replaceAuthenticatedResearchAreaPreferences).not.toHaveBeenCalled();
  });

  it("fails closed when updating address districts and the proxy does not inject an authenticated user ID", async () => {
    const response = await putJson(
      proxyBaseUrl,
      "/api/me/address",
      { address: "3921 Harlan Ave Baldwin Park CA 91706" },
      { "x-user-id": spoofedUserId }
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(updateAuthenticatedAddressDistricts).not.toHaveBeenCalled();
  });

  it("fails closed when the proxy does not inject an authenticated user ID", async () => {
    const response = await postJson(
      proxyBaseUrl,
      "/api/me/districts/initialize",
      { district_ids: [districtId] },
      { "x-user-id": spoofedUserId }
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(initializeUserDistricts).not.toHaveBeenCalled();
  });
});
