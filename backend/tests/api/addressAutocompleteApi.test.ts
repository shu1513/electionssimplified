import { type IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import type { Express } from "express";
import { describe, expect, it, vi } from "vitest";

import { createApiApp } from "../../src/api/apiServer.js";
import { GooglePlacesAutocompleteError } from "../../src/pipeline/address/googlePlacesAutocomplete.js";

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

const SESSION_TOKEN = "0aa2ee7a-8f0f-4b3f-9c53-1b6f9d6a2f11";

const SUGGESTION = {
  place_id: "place-1",
  description: "1600 Pennsylvania Avenue NW, Washington, DC 20500, USA",
  main_text: "1600 Pennsylvania Avenue NW",
  secondary_text: "Washington, DC 20500, USA",
};

describe("address autocomplete API endpoints", () => {
  it("returns suggestions from the injected suggest function", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi.fn().mockResolvedValue([SUGGESTION]);

    const response = await invokeExpressApp(createApiApp({ resolveAddress, suggestAddresses }), {
      method: "POST",
      path: "/api/address/autocomplete",
      body: JSON.stringify({ input: "1600 Penn", session_token: SESSION_TOKEN }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ suggestions: [SUGGESTION] });
    expect(suggestAddresses).toHaveBeenCalledWith({
      input: "1600 Penn",
      sessionToken: SESSION_TOKEN,
    });
  });

  it("returns the full retrieve classification, not just address and location", async () => {
    // Regression: the handler once serialized only address/location/
    // granularity/postal_code, silently dropping the region fields — city
    // selections then never reached the region resolver through the real
    // API even though the Google client computed them.
    const resolveAddress = vi.fn();
    const retrieveSuggestedAddress = vi.fn().mockResolvedValue({
      address: "Los Angeles, CA, USA",
      location: null,
      granularity: "region",
      postal_code: null,
      state: "CA",
      locality: "Los Angeles",
    });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, retrieveSuggestedAddress }), {
      method: "POST",
      path: "/api/address/autocomplete/retrieve",
      body: JSON.stringify({ place_id: SUGGESTION.place_id, session_token: SESSION_TOKEN }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      address: "Los Angeles, CA, USA",
      location: null,
      granularity: "region",
      postal_code: null,
      state: "CA",
      locality: "Los Angeles",
    });
    expect(retrieveSuggestedAddress).toHaveBeenCalledWith({
      placeId: SUGGESTION.place_id,
      sessionToken: SESSION_TOKEN,
    });
  });

  it("answers a PO Box input with no suggestions instead of asking Google", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, suggestAddresses }), {
      method: "POST",
      path: "/api/address/autocomplete",
      body: JSON.stringify({ input: "P.O. Box 211, Gustavus", session_token: SESSION_TOKEN }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ suggestions: [] });
    expect(suggestAddresses).not.toHaveBeenCalled();
  });

  it("rejects suggest input shorter than 3 characters", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, suggestAddresses }), {
      method: "POST",
      path: "/api/address/autocomplete",
      body: JSON.stringify({ input: "16", session_token: SESSION_TOKEN }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(suggestAddresses).not.toHaveBeenCalled();
  });

  it("rejects session tokens with invalid characters", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, suggestAddresses }), {
      method: "POST",
      path: "/api/address/autocomplete",
      body: JSON.stringify({ input: "1600 Penn", session_token: "bad token!" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(suggestAddresses).not.toHaveBeenCalled();
  });

  it("rejects place ids with invalid characters", async () => {
    const resolveAddress = vi.fn();
    const retrieveSuggestedAddress = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, retrieveSuggestedAddress }), {
      method: "POST",
      path: "/api/address/autocomplete/retrieve",
      body: JSON.stringify({ place_id: "id with spaces", session_token: SESSION_TOKEN }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(400);
    expect(retrieveSuggestedAddress).not.toHaveBeenCalled();
  });

  it("requires a JSON content type", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, suggestAddresses }), {
      method: "POST",
      path: "/api/address/autocomplete",
      body: "input=1600+Penn",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.statusCode).toBe(415);
    expect(suggestAddresses).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods with 405", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi.fn();

    const response = await invokeExpressApp(createApiApp({ resolveAddress, suggestAddresses }), {
      method: "GET",
      path: "/api/address/autocomplete",
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });

  it("returns 500 when autocomplete is not configured", async () => {
    const resolveAddress = vi.fn();

    for (const path of ["/api/address/autocomplete", "/api/address/autocomplete/retrieve"]) {
      const response = await invokeExpressApp(createApiApp({ resolveAddress }), {
        method: "POST",
        path,
        body: JSON.stringify({ input: "1600 Penn", place_id: "place-1", session_token: SESSION_TOKEN }),
        headers: { "content-type": "application/json" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: "internal_error",
          message: "Address autocomplete is not configured",
        },
      });
    }
  });

  it("maps Google upstream failures to 503 and bad responses to 502", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi
      .fn()
      .mockRejectedValueOnce(new GooglePlacesAutocompleteError("timeout", "Google Places request timed out after 8000ms"))
      .mockRejectedValueOnce(new GooglePlacesAutocompleteError("bad_response", "Google Places returned non-JSON response"))
      .mockRejectedValueOnce(new GooglePlacesAutocompleteError("network_error", "Google Places request failed: fetch failed"));

    const app = createApiApp({ resolveAddress, suggestAddresses });
    const request = {
      method: "POST",
      path: "/api/address/autocomplete",
      body: JSON.stringify({ input: "1600 Penn", session_token: SESSION_TOKEN }),
      headers: { "content-type": "application/json" },
    };

    const timeoutResponse = await invokeExpressApp(app, request);
    expect(timeoutResponse.statusCode).toBe(503);
    expect((timeoutResponse.body as { error: { code: string } }).error.code).toBe("upstream_unavailable");

    const badResponse = await invokeExpressApp(app, request);
    expect(badResponse.statusCode).toBe(502);
    expect((badResponse.body as { error: { code: string } }).error.code).toBe("bad_upstream_response");

    const networkResponse = await invokeExpressApp(app, request);
    expect(networkResponse.statusCode).toBe(503);
    expect((networkResponse.body as { error: { code: string } }).error.code).toBe("upstream_unavailable");
  });

  it("applies the shared rate limiter to autocomplete requests", async () => {
    const resolveAddress = vi.fn();
    const suggestAddresses = vi.fn();
    const rateLimit = vi.fn().mockReturnValue({ allowed: false, retryAfterSeconds: 9 });

    const response = await invokeExpressApp(createApiApp({ resolveAddress, suggestAddresses, rateLimit }), {
      method: "POST",
      path: "/api/address/autocomplete",
      body: JSON.stringify({ input: "1600 Penn", session_token: SESSION_TOKEN }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("9");
    expect(suggestAddresses).not.toHaveBeenCalled();
  });
});
