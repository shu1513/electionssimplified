import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes } from "../test/render";
import EmbedGuidePage from "./EmbedGuidePage";

describe("EmbedGuidePage", () => {
  it("copies the line to paste with one click and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderRoutes([{ path: "/embed-instructions", element: <EmbedGuidePage /> }], "/embed-instructions");

    await userEvent.click(screen.getByRole("button", { name: "Copy the line" }));
    expect(writeText).toHaveBeenCalledWith('<script src="https://electionssimplified.com/embed.js"></script>');
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });


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
