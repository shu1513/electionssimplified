import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { BallotMeasureFunding } from "@voteapp/api-client";
import { MeasureFundingSection } from "./MeasureFundingSection";

function funding(overrides: Partial<BallotMeasureFunding> = {}): BallotMeasureFunding {
  return {
    as_of: "2026-09-17",
    support: {
      total_raised: 5_006_868.25,
      shared_with_other_measures_raised: 3_727_713.25,
      top_donors: [
        { name: "Brian Heywood", amount: 606_869, type: "individual", state: "WA" },
        { name: "Madrona Venture Group, LLC", amount: 250_000, type: "organization" },
      ],
      source_urls: ["https://www.pdc.wa.gov/committees/co-2026-42237", "https://www.pdc.wa.gov/committees/co-2026-30644"],
    },
    oppose: { total_raised: 0, shared_with_other_measures_raised: 0, top_donors: [], source_urls: [] },
    ...overrides,
  };
}

describe("MeasureFundingSection", () => {
  it("shows each side's total, its largest donors, and the shared-money note", () => {
    render(<MeasureFundingSection funding={funding()} homeState="CA" />);

    expect(screen.getByRole("heading", { name: "Who is paying for the campaigns" })).toBeInTheDocument();
    const supporting = screen.getByRole("heading", { name: "Supporting" }).parentElement as HTMLElement;
    expect(within(supporting).getByText("$5,006,868")).toBeInTheDocument();
    const donors = within(supporting).getAllByRole("listitem");
    expect(donors.map((item) => item.textContent)).toEqual([
      "Brian Heywood · WA$606,869",
      "Madrona Venture Group, LLC$250,000",
    ]);
    expect(
      within(supporting).getByText("$3,727,713 of this was raised by groups that also work on other measures.")
    ).toBeInTheDocument();
  });

  it("marks only out-of-state donors with their state", () => {
    render(<MeasureFundingSection funding={funding()} homeState="WA" />);

    const supporting = screen.getByRole("heading", { name: "Supporting" }).parentElement as HTMLElement;
    expect(within(supporting).getAllByRole("listitem")[0]?.textContent).toBe("Brian Heywood$606,869");
  });

  it("says so when one side reported no money", () => {
    render(<MeasureFundingSection funding={funding()} homeState="CA" />);

    const opposing = screen.getByRole("heading", { name: "Opposing" }).parentElement as HTMLElement;
    expect(within(opposing).getByText("No group has reported raising money.")).toBeInTheDocument();
    expect(within(opposing).queryByText("Largest donors")).not.toBeInTheDocument();
  });

  it("collapses to one line when neither side reported money", () => {
    const empty = funding();
    render(<MeasureFundingSection funding={{ ...empty, support: empty.oppose }} homeState="CA" />);

    expect(screen.getByText("No group has reported raising money for or against this measure.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Supporting" })).not.toBeInTheDocument();
  });

  it("dates the numbers and links every filing page from both sides", () => {
    const base = funding();
    render(
      <MeasureFundingSection
        funding={{
          ...base,
          oppose: { ...base.oppose, total_raised: 10, source_urls: ["https://www.pdc.wa.gov/committees/co-2026-42211"] },
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
