import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { BallotMeasureFunding } from "@voteapp/api-client";
import { MeasureFundingSection } from "./MeasureFundingSection";

function funding(overrides: Partial<BallotMeasureFunding> = {}): BallotMeasureFunding {
  return {
    as_of: "2026-09-17",
    support: {
      shared_with_other_measures: true,
      top_donors: [
        { name: "Brian Heywood", amount: 606_869, type: "individual", state: "WA" },
        { name: "Madrona Venture Group, LLC", amount: 250_000, type: "organization" },
      ],
      source_urls: ["https://www.pdc.wa.gov/committees/co-2026-42237", "https://www.pdc.wa.gov/committees/co-2026-30644"],
    },
    oppose: { shared_with_other_measures: false, top_donors: [], source_urls: [] },
    ...overrides,
  };
}

describe("MeasureFundingSection", () => {
  it("lists each side's largest donors and the shared-money note, with no total", () => {
    render(<MeasureFundingSection funding={funding()} homeState="CA" />);

    expect(screen.getByRole("heading", { name: "Who is paying for the campaigns" })).toBeInTheDocument();
    const supporting = screen.getByRole("heading", { name: "Largest donors supporting" }).parentElement as HTMLElement;
    const donors = within(supporting).getAllByRole("listitem");
    expect(donors.map((item) => item.textContent)).toEqual([
      "Brian Heywood · WA$606,869",
      "Madrona Venture Group, LLC$250,000",
    ]);
    expect(
      within(supporting).getByText("Some of this money went to groups that also work on other measures.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Raised/)).not.toBeInTheDocument();
  });

  it("marks only out-of-state donors with their state", () => {
    render(<MeasureFundingSection funding={funding()} homeState="WA" />);

    const supporting = screen.getByRole("heading", { name: "Largest donors supporting" }).parentElement as HTMLElement;
    expect(within(supporting).getAllByRole("listitem")[0]?.textContent).toBe("Brian Heywood$606,869");
  });

  it("says so when one side has no donors", () => {
    render(<MeasureFundingSection funding={funding()} homeState="CA" />);

    const opposing = screen.getByRole("heading", { name: "Largest donors opposing" }).parentElement as HTMLElement;
    expect(within(opposing).getByText("No donors reported.")).toBeInTheDocument();
    expect(within(opposing).queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("collapses to one line when neither side has donors", () => {
    const empty = funding();
    render(<MeasureFundingSection funding={{ ...empty, support: empty.oppose }} homeState="CA" />);

    expect(screen.getByText("No donors reported for or against this measure.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Largest donors supporting" })).not.toBeInTheDocument();
  });

  it("dates the numbers and links every filing page from both sides", () => {
    const base = funding();
    render(
      <MeasureFundingSection
        funding={{
          ...base,
          oppose: {
            ...base.oppose,
            top_donors: [{ name: "Washington Education Association", amount: 3_064_261, type: "organization" }],
            source_urls: ["https://www.pdc.wa.gov/committees/co-2026-42211"],
          },
        }}
        homeState="CA"
      />
    );

    expect(screen.getByText(/From campaign finance filings as of September 17, 2026/)).toBeInTheDocument();
    // One site name plus numbered links for its other pages; the opposing
    // side's filing page is still reachable.
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://www.pdc.wa.gov/committees/co-2026-42237",
      "https://www.pdc.wa.gov/committees/co-2026-30644",
      "https://www.pdc.wa.gov/committees/co-2026-42211",
    ]);
  });
});
