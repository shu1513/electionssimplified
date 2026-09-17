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

    expect(screen.getByRole("heading", { name: "Campaign Finance Information" })).toBeInTheDocument();
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

  it("is a collapsed disclosure titled like the candidate page's finance section", () => {
    const { container } = render(<MeasureFundingSection funding={funding()} homeState="CA" />);

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    // Collapsed by default; the donor lists still ship in the HTML.
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("$ Campaign Finance Information");
    expect(details?.textContent).toContain("Brian Heywood");
  });

  it("names who is behind a pass-through donor", () => {
    const base = funding();
    render(
      <MeasureFundingSection
        funding={{
          ...base,
          oppose: {
            ...base.oppose,
            top_donors: [
              {
                name: "Building a Better California",
                amount: 41_500_000,
                type: "organization",
                about: "Political spending group",
                funded_by: ["Sergey Brin (Google co-founder)", "L. John Doerr, III (venture capitalist)"],
              },
            ],
          },
        }}
        homeState="CA"
      />
    );

    expect(screen.getByText("Political spending group")).toBeInTheDocument();
    expect(
      screen.getByText("Its top donors: Sergey Brin (Google co-founder); L. John Doerr, III (venture capitalist)")
    ).toBeInTheDocument();
  });

  it("marks only out-of-state donors with their state", () => {
    render(<MeasureFundingSection funding={funding()} homeState="WA" />);

    const supporting = screen.getByRole("heading", { name: "Largest donors supporting" }).parentElement as HTMLElement;
    expect(within(supporting).getAllByRole("listitem")[0]?.textContent).toBe("Brian Heywood$606,869");
  });

  it("says so when one side has no donors", () => {
    render(<MeasureFundingSection funding={funding()} homeState="CA" />);

    const opposing = screen.getByRole("heading", { name: "Largest donors opposing" }).parentElement as HTMLElement;
    expect(within(opposing).getByText("No large donors reported.")).toBeInTheDocument();
    expect(within(opposing).queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("collapses to one line when neither side has donors", () => {
    const empty = funding();
    render(<MeasureFundingSection funding={{ ...empty, support: empty.oppose }} homeState="CA" />);

    expect(screen.getByText("No large donors reported for or against this measure.")).toBeInTheDocument();
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

    // Date and sources share one line.
    expect(screen.getByText(/Filings as of September 17, 2026 · Sources:/)).toBeInTheDocument();
    // One site name plus numbered links for its other pages; the opposing
    // side's filing page is still reachable.
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://www.pdc.wa.gov/committees/co-2026-42237",
      "https://www.pdc.wa.gov/committees/co-2026-30644",
      "https://www.pdc.wa.gov/committees/co-2026-42211",
    ]);
  });
});
