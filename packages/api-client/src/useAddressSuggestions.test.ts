import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError } from "./client";

const apiRequestMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client")>();
  return {
    ...original,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

const { useAddressSuggestions, SUGGEST_DEBOUNCE_MS } = await import("./useAddressSuggestions");

const SUGGESTION = {
  place_id: "place-1",
  description: "200 N Spring St, Los Angeles, CA 90012, USA",
  main_text: "200 N Spring St",
  secondary_text: "Los Angeles, CA 90012, USA",
};

beforeEach(() => {
  vi.useFakeTimers();
  apiRequestMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAddressSuggestions", () => {
  it("requires 3 chars, fires the first suggest immediately, debounces the rest, one token per entry", async () => {
    apiRequestMock.mockResolvedValue({ suggestions: [SUGGESTION] });
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.onInputChanged("20");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    expect(apiRequestMock).not.toHaveBeenCalled();

    // Leading edge: the first eligible keystroke fires with no timer advance.
    act(() => {
      result.current.onInputChanged("200 N");
    });
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    const firstToken = (apiRequestMock.mock.calls[0][1] as { body: { session_token: string } }).body
      .session_token;
    expect(firstToken.length).toBeGreaterThan(8);

    // Subsequent keystrokes: two keystrokes, one debounced request.
    act(() => {
      result.current.onInputChanged("200 N Sp");
    });
    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
    expect(result.current.suggestions).toEqual([SUGGESTION]);
    const secondToken = (apiRequestMock.mock.calls[1][1] as { body: { session_token: string } }).body
      .session_token;
    // Same entry session: token must not change between keystrokes.
    expect(secondToken).toBe(firstToken);
  });

  it("renders a response for older input while newer input is still debouncing (intended)", async () => {
    // Deliberate design, same as Google's own widget: a keystroke schedules
    // the next request but does NOT abort the in-flight one, so during
    // continuous typing the dropdown shows the latest response that has
    // landed (trailing the input by <= one debounce) instead of staying
    // blank until the user pauses. The seq guard only prevents OLDER
    // responses from overwriting newer ones. Suggestions display their full
    // address text, so acting on one that trails the input is harmless —
    // retrieve uses the clicked suggestion's place_id.
    let resolveFirst!: (value: unknown) => void;
    apiRequestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const { result } = renderHook(() => useAddressSuggestions());

    // Leading-edge request for "200 N" goes out and hangs.
    act(() => {
      result.current.onInputChanged("200 N");
    });
    // User keeps typing; the new request is debouncing, the old one is live.
    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      resolveFirst({ suggestions: [SUGGESTION] });
    });
    expect(result.current.suggestions).toEqual([SUGGESTION]);

    // The debounced request for the newer text still fires and supersedes.
    apiRequestMock.mockResolvedValueOnce({ suggestions: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
    expect(result.current.suggestions).toEqual([]);
  });

  it("warmup fires one throwaway request, dedupes, and never creates a session token", async () => {
    apiRequestMock.mockRejectedValue(new ApiError(400, "invalid_request", "input too short"));
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.warmup();
    });
    act(() => {
      result.current.warmup();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // One request despite two focuses; the 400 is swallowed.
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock.mock.calls[0][0]).toBe("/api/address/autocomplete");
    expect((apiRequestMock.mock.calls[0][1] as { body: unknown }).body).toEqual({
      input: "",
      session_token: "",
    });
    expect(result.current.enabled).toBe(true);

    // A real entry after warmup still starts its own fresh session.
    apiRequestMock.mockResolvedValue({ suggestions: [SUGGESTION] });
    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const token = (apiRequestMock.mock.calls[1][1] as { body: { session_token: string } }).body
      .session_token;
    expect(token.length).toBeGreaterThan(8);
  });

  it("warmup hitting the not-configured 500 disables autocomplete before any keystroke", async () => {
    apiRequestMock.mockRejectedValueOnce(
      new ApiError(500, "internal_error", "Address autocomplete is not configured")
    );
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.warmup();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.enabled).toBe(false);

    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    // No suggest request once disabled.
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed 200 (no suggestions array) as no suggestions, never undefined", async () => {
    // Autocomplete failing must never block the form — that includes a
    // body without a suggestions array, which once crashed the landing
    // page at suggestions.length.
    apiRequestMock.mockResolvedValue({ user: null });
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(result.current.suggestions).toEqual([]);
  });

  it("sends the same token on retrieve, then kills the session (billing rule)", async () => {
    apiRequestMock.mockResolvedValueOnce({ suggestions: [SUGGESTION] });
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    const suggestToken = (apiRequestMock.mock.calls[0][1] as { body: { session_token: string } }).body
      .session_token;

    apiRequestMock.mockResolvedValueOnce({
      address: "200 N Spring St, Los Angeles, CA 90012, USA",
      location: { lat: 34.0537, lng: -118.2427 },
    });
    let retrieved: Awaited<ReturnType<typeof result.current.selectSuggestion>> = null;
    await act(async () => {
      retrieved = await result.current.selectSuggestion(SUGGESTION);
    });
    // No granularity in the response (stale API) reads as "address".
    expect(retrieved).toEqual({
      address: "200 N Spring St, Los Angeles, CA 90012, USA",
      location: { lat: 34.0537, lng: -118.2427 },
      granularity: "address",
      postal_code: null,
      state: null,
      locality: null,
    });
    const retrieveCall = apiRequestMock.mock.calls[1];
    expect(retrieveCall[0]).toBe("/api/address/autocomplete/retrieve");
    expect((retrieveCall[1] as { body: { session_token: string } }).body.session_token).toBe(suggestToken);

    // Next entry must start a NEW session token.
    apiRequestMock.mockResolvedValueOnce({ suggestions: [] });
    act(() => {
      result.current.onInputChanged("500 Main St");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    const nextToken = (apiRequestMock.mock.calls[2][1] as { body: { session_token: string } }).body
      .session_token;
    expect(nextToken).not.toBe(suggestToken);
  });

  it("passes granularity through and strips coordinates from coarse selections", async () => {
    for (const [response, expected] of [
      [
        { address: "Austin, TX 78701, USA", location: null, granularity: "zip", postal_code: "78701" },
        {
          address: "Austin, TX 78701, USA",
          location: null,
          granularity: "zip",
          postal_code: "78701",
          state: null,
          locality: null,
        },
      ],
      [
        // Defensive belt-and-braces: even if a server ever leaked a coarse
        // location, the hook must drop it. Region fields pass through.
        {
          address: "Austin, TX, USA",
          location: { lat: 30.27, lng: -97.74 },
          granularity: "region",
          state: "TX",
          locality: "Austin",
        },
        {
          address: "Austin, TX, USA",
          location: null,
          granularity: "region",
          postal_code: null,
          state: "TX",
          locality: "Austin",
        },
      ],
    ] as const) {
      apiRequestMock.mockResolvedValueOnce({ suggestions: [SUGGESTION] });
      const { result } = renderHook(() => useAddressSuggestions());
      act(() => {
        result.current.onInputChanged("Austin");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
      });

      apiRequestMock.mockResolvedValueOnce(response);
      let retrieved: Awaited<ReturnType<typeof result.current.selectSuggestion>> = null;
      await act(async () => {
        retrieved = await result.current.selectSuggestion(SUGGESTION);
      });
      expect(retrieved).toEqual(expected);
      apiRequestMock.mockClear();
    }
  });

  it("clears the token before the retrieve settles: typing mid-retrieve gets a fresh session", async () => {
    apiRequestMock.mockResolvedValueOnce({ suggestions: [SUGGESTION] });
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    const firstToken = (apiRequestMock.mock.calls[0][1] as { body: { session_token: string } }).body
      .session_token;

    // Retrieve hangs; user keeps typing while it is in flight.
    let resolveRetrieve!: (value: unknown) => void;
    apiRequestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetrieve = resolve;
        })
    );
    let selectPromise!: ReturnType<typeof result.current.selectSuggestion>;
    act(() => {
      selectPromise = result.current.selectSuggestion(SUGGESTION);
    });

    apiRequestMock.mockResolvedValueOnce({ suggestions: [] });
    act(() => {
      result.current.onInputChanged("200 N Spring St Apt 4");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    const midRetrieveToken = (apiRequestMock.mock.calls[2][1] as { body: { session_token: string } }).body
      .session_token;
    expect(midRetrieveToken).not.toBe(firstToken);

    // The mid-retrieve typing superseded the selection, so the late result
    // must be dropped instead of reverting the newer input.
    await act(async () => {
      resolveRetrieve({ address: "200 N Spring St, Los Angeles, CA 90012, USA" });
      await expect(selectPromise).resolves.toBeNull();
    });
  });

  it("kills the session token when retrieve fails (indeterminate session state)", async () => {
    apiRequestMock.mockResolvedValueOnce({ suggestions: [SUGGESTION] });
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    const firstToken = (apiRequestMock.mock.calls[0][1] as { body: { session_token: string } }).body
      .session_token;

    apiRequestMock.mockRejectedValueOnce(new ApiError(503, "upstream_unavailable", "Google hiccup"));
    let retrieved: Awaited<ReturnType<typeof result.current.selectSuggestion>> | "sentinel" = "sentinel";
    await act(async () => {
      retrieved = await result.current.selectSuggestion(SUGGESTION);
    });
    expect(retrieved).toBeNull();

    // Next entry must NOT reuse the token from the failed-retrieve session.
    apiRequestMock.mockResolvedValueOnce({ suggestions: [] });
    act(() => {
      result.current.onInputChanged("500 Main St");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    const nextToken = (apiRequestMock.mock.calls[2][1] as { body: { session_token: string } }).body
      .session_token;
    expect(nextToken).not.toBe(firstToken);
  });

  it("disables autocomplete for the session on the not-configured 500", async () => {
    apiRequestMock.mockRejectedValueOnce(
      new ApiError(500, "internal_error", "Address autocomplete is not configured")
    );
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    expect(result.current.enabled).toBe(false);

    act(() => {
      result.current.onInputChanged("200 N Spring St");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    // No further requests once disabled.
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it("swallows transient errors without disabling (429, network)", async () => {
    apiRequestMock.mockRejectedValueOnce(new ApiError(429, "rate_limited", "Too many requests"));
    const { result } = renderHook(() => useAddressSuggestions());

    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.suggestions).toEqual([]);
  });
it("aborts an in-flight retrieve when the user types again, resolving null", async () => {
    apiRequestMock.mockResolvedValueOnce({ suggestions: [SUGGESTION] });
    const { result } = renderHook(() => useAddressSuggestions());
    act(() => {
      result.current.onInputChanged("200 N Spring");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 10);
    });

    // A retrieve that only settles when its signal aborts — the slow-network
    // case. Without the abort, a caller holding Search on retrieve-pending
    // would stay frozen for the whole round trip after the user typed on.
    let retrieveSignal: AbortSignal | undefined;
    apiRequestMock.mockImplementationOnce((_path: string, options: { signal?: AbortSignal }) => {
      retrieveSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    let retrievedPromise!: Promise<unknown>;
    act(() => {
      retrievedPromise = result.current.selectSuggestion(SUGGESTION);
    });
    expect(retrieveSignal?.aborted).toBe(false);

    act(() => {
      result.current.onInputChanged("500 Main St, typed manually");
    });
    expect(retrieveSignal?.aborted).toBe(true);
    await expect(retrievedPromise).resolves.toBeNull();
  });
});
