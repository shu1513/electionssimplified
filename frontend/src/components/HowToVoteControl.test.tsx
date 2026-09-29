import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateVotingResources } from "@voteapp/api-client";
import { HowToVoteControl } from "./HowToVoteControl";
import { stubApiRoutes } from "../test/mockApi";
import { renderRoutes } from "../test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OHIO: StateVotingResources = {
  state_abbreviation: "OH",
  state_name: "Ohio",
  voter_registration_url: "https://olvr.ohiosos.gov/",
  polling_place_url: "https://www.ohiosos.gov/elections/voters/toolkit/polling-location/",
  mail_voting_available: true,
  mail_ballot_request_url: "https://www.ohiosos.gov/elections/voters/absentee-voting/",
  mail_ballot_request_type: "form",
  mail_ballot_request_deadline_rule: "Requests must arrive 7 days before election day.",
};

async function openPanel(resources: StateVotingResources) {
  stubApiRoutes({ "/api/state-resources": { body: { state_resources: resources } } });
  renderRoutes([{ path: "/", element: <HowToVoteControl states={["OH"]} /> }]);
  await userEvent.click(screen.getByRole("button", { name: "How to vote in OH" }));
  return screen.findByText("Find your polling place");
}

describe("HowToVoteControl", () => {
  it("leads with the official registration link, then mail, then in person", async () => {
    await openPanel(OHIO);

    const registration = screen.getByRole("link", { name: "Register or check your registration" });
    expect(registration).toHaveAttribute("href", "https://olvr.ohiosos.gov/");
    expect(screen.getByText("olvr.ohiosos.gov")).toBeInTheDocument();

    // Order matters: registration is the prerequisite, so it renders first.
    const headings = screen
      .getAllByText(/^(Register to vote|Vote by mail|Vote in person)$/)
      .map((node) => node.textContent);
    expect(headings).toEqual(["Register to vote", "Vote by mail", "Vote in person"]);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    await openPanel(OHIO);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: "Find your polling place" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How to vote in OH" })).toHaveFocus();
  });

  it("closes on a click outside the panel", async () => {
    await openPanel(OHIO);

    await userEvent.click(document.body);
    expect(screen.queryByRole("link", { name: "Find your polling place" })).not.toBeInTheDocument();
  });

  it("omits the registration block when an older API build leaves the field out", async () => {
    const { voter_registration_url: _omitted, ...withoutRegistration } = OHIO;
    await openPanel(withoutRegistration);

    expect(screen.queryByText("Register to vote")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find your polling place" })).toBeInTheDocument();
  });
});
