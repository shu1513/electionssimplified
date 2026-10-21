import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const apiRequestMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client")>();
  return {
    ...original,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

const { useCandidateSearch, CANDIDATE_SEARCH_DEBOUNCE_MS } = await import("./useCandidateSearch");

const MATCH = {
  candidate_id: "33333333-3333-4333-8333-333333333333",
  display_name: "Hilary Brown",
  party: "Independent",
  state: "CA",
  current_office: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  apiRequestMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCandidateSearch", () => {
  it("debounces, requires 2 chars, and URL-encodes the query", async () => {
    apiRequestMock.mockResolvedValue({ candidates: [MATCH] });
    const { result } = renderHook(() => useCandidateSearch());

    act(() => {
      result.current.onInputChanged("h");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_SEARCH_DEBOUNCE_MS + 10);
    });
    expect(apiRequestMock).not.toHaveBeenCalled();

    act(() => {
      result.current.onInputChanged("hil");
    });
    act(() => {
      result.current.onInputChanged("hilar & co");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_SEARCH_DEBOUNCE_MS + 10);
    });
    // Two keystrokes, one debounced request.
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock.mock.calls[0][0]).toBe("/api/candidates/search?q=hilar%20%26%20co");
    expect(result.current.matches).toEqual([MATCH]);
  });

  it("sends the ballot's district ids so its candidates rank first", async () => {
    apiRequestMock.mockResolvedValue({ candidates: [MATCH] });
    const { result } = renderHook(() => useCandidateSearch(["d-1", "d-2"]));

    act(() => {
      result.current.onInputChanged("hilar");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_SEARCH_DEBOUNCE_MS + 10);
    });
    expect(apiRequestMock.mock.calls[0][0]).toBe("/api/candidates/search?q=hilar&district_ids=d-1%2Cd-2");
  });

  it("clears matches and drops in-flight results on clearMatches", async () => {
    apiRequestMock.mockResolvedValue({ candidates: [MATCH] });
    const { result } = renderHook(() => useCandidateSearch());

    act(() => {
      result.current.onInputChanged("hilar");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_SEARCH_DEBOUNCE_MS + 10);
    });
    expect(result.current.matches).toEqual([MATCH]);

    act(() => {
      result.current.clearMatches();
    });
    expect(result.current.matches).toEqual([]);
  });

  it("drops already-loaded suggestions the moment the input changes", async () => {
    apiRequestMock.mockResolvedValue({ candidates: [MATCH] });
    const { result } = renderHook(() => useCandidateSearch());

    act(() => {
      result.current.onInputChanged("jo");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_SEARCH_DEBOUNCE_MS + 10);
    });
    expect(result.current.matches).toEqual([MATCH]);

    // Loaded "jo" results must not stay selectable under "alex" during the
    // debounce + network window.
    act(() => {
      result.current.onInputChanged("alex");
    });
    expect(result.current.matches).toEqual([]);
  });

  it("ignores an in-flight response once the input has changed again", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    apiRequestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    const { result } = renderHook(() => useCandidateSearch());

    act(() => {
      result.current.onInputChanged("jo");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_SEARCH_DEBOUNCE_MS + 10);
    });
    expect(apiRequestMock).toHaveBeenCalledTimes(1);

    // New keystroke while the "jo" request is still in flight: its late
    // response must not surface stale suggestions during the debounce window.
    act(() => {
      result.current.onInputChanged("alex");
    });
    await act(async () => {
      resolveFirst({ candidates: [MATCH] });
      await Promise.resolve();
    });
    expect(result.current.matches).toEqual([]);
  });

  it("hides the dropdown on request failure", async () => {
    apiRequestMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useCandidateSearch());

    act(() => {
      result.current.onInputChanged("hilar");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANDIDATE_SEARCH_DEBOUNCE_MS + 10);
    });
    expect(result.current.matches).toEqual([]);
  });
});
