import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import MethodologyPage, { meta } from "./MethodologyPage";
import { renderRoutes } from "../test/render";

describe("MethodologyPage", () => {
  it("answers who, where, how, the ratings, and corrections under question headings", async () => {
    renderRoutes([{ path: "/methodology", element: <MethodologyPage /> }], "/methodology");

    expect(await screen.findByRole("heading", { name: "How Elections Simplified works" })).toBeInTheDocument();
    for (const question of [
      "Who runs Elections Simplified?",
      "Where does the data come from?",
      "How is the research done?",
      "How is “vote power” calculated?",
      "How is competitiveness decided?",
      "How do I report an error?",
    ]) {
      expect(screen.getByRole("heading", { name: question })).toBeInTheDocument();
    }
    // The published formula mirrors votePower.ts / districtsLoader.ts.
    expect(screen.getByText(/50 \+ 50 × ln\(state population ÷ district population\) ÷ ln\(50,000\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 points or less is a toss-up, up to 5 is very competitive/)).toBeInTheDocument();
    // The corrections anchor the Organization JSON-LD points at.
    expect(screen.getByRole("heading", { name: "How do I report an error?" })).toHaveAttribute("id", "corrections");
    expect(screen.getByText("Elections Simplified Inc.", { exact: false })).toBeInTheDocument();
  });

  it("sets a canonical path and description", () => {
    const tags = meta({ data: undefined, params: {}, location: { pathname: "/methodology" }, matches: [] } as never);
    expect(tags).toContainEqual({ title: "How Elections Simplified works · Elections Simplified" });
    expect(tags).toContainEqual({ tagName: "link", rel: "canonical", href: "https://electionssimplified.com/methodology" });
  });
});
