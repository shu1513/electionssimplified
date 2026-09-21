import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderRoutes } from "../test/render";
import { rememberEmbedSource, resetEmbedSessionForTests } from "../lib/embedSession";
import { clearBallotDraft } from "../lib/ballotDraft";
import { EmbedHeader } from "./EmbedHeader";

afterEach(() => {
  resetEmbedSessionForTests();
  clearBallotDraft();
  vi.unstubAllGlobals();
});

describe("EmbedHeader", () => {
  it("carries the box's publisher code on the wordmark link, which opens a separate tab", async () => {
    rememberEmbedSource("alpha-news");
    renderRoutes([{ path: "/ballot", element: <EmbedHeader /> }], "/ballot");
    const wordmark = screen.getByRole("link", { name: "Elections Simplified" });
    await waitFor(() => expect(wordmark).toHaveAttribute("href", "/?src=alpha-news"));
    expect(wordmark).toHaveAttribute("target", "_blank");
  });

  it("links plainly when the box has no publisher code, and shows no draft link before a pick", () => {
    renderRoutes([{ path: "/ballot", element: <EmbedHeader /> }], "/ballot");
    expect(screen.getByRole("link", { name: "Elections Simplified" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: /My Draft/ })).not.toBeInTheDocument();
  });
});
