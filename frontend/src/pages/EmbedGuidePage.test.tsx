import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoutes } from "../test/render";
import EmbedGuidePage from "./EmbedGuidePage";

describe("EmbedGuidePage", () => {
  it("gives the one line to paste, a live example, the two size settings, and a contact", () => {
    renderRoutes([{ path: "/embed-instructions", element: <EmbedGuidePage /> }], "/embed-instructions");

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("How to use our civic tool on your website");
    expect(screen.getByText('<script src="https://electionssimplified.com/embed.js"></script>')).toBeInTheDocument();
    // The live example is the real box page, framed.
    expect(screen.getByTitle("The Elections Simplified tool, as it appears on your website")).toHaveAttribute("src", "/embed");
    expect(screen.getByText('data-height="600"')).toBeInTheDocument();
    expect(screen.getByText('data-max-width="560"')).toBeInTheDocument();
    expect(
      screen.getByText(
        '<script src="https://electionssimplified.com/embed.js" data-height="600" data-max-width="560"></script>'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact@electionssimplified.com" })).toHaveAttribute(
      "href",
      "mailto:contact@electionssimplified.com"
    );
  });
});
