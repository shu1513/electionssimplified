import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoutes } from "../test/render";
import { DetailPager } from "./DetailPager";

const BACK = { path: "/ballot", label: "My elections" };

function renderPager(prev: { path: string; label: string } | null, next: { path: string; label: string } | null) {
  return renderRoutes(
    [{ path: "/", element: <DetailPager ariaLabel="Test navigation" prev={prev} next={next} backTo={BACK} /> }],
    "/"
  );
}

describe("DetailPager", () => {
  it("puts the back link at the left edge when there is no previous page", async () => {
    renderPager(null, { path: "/candidates/c-2", label: "Grace Hopper" });
    const back = await screen.findByRole("link", { name: "Back to My elections" });
    expect(back.closest("p")).toHaveClass("text-left");
    expect(back.closest("div")).toHaveClass("sm:order-1");
  });

  it("keeps the back link in the middle between Prev and Next", async () => {
    renderPager({ path: "/candidates/c-0", label: "Ada Lovelace" }, { path: "/candidates/c-2", label: "Grace Hopper" });
    const back = await screen.findByRole("link", { name: "Back to My elections" });
    expect(back.closest("p")).toHaveClass("text-center");
    expect(back.closest("div")).toHaveClass("sm:order-2");
  });
});
