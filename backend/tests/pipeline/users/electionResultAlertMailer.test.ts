import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, it, vi } from "vitest";

import {
  buildResultAlertHtmlBody,
  buildResultAlertSubject,
  buildResultAlertTextBody,
  createConsoleElectionResultAlertMailer,
  createSesElectionResultAlertMailer,
  type ElectionResultAlertEmailInput,
} from "../../../src/pipeline/users/electionResultAlertMailer.js";

const baseInput: ElectionResultAlertEmailInput = {
  email: "voter@example.com",
  firstName: "Sam",
  totalEventCount: 3,
  items: [
    {
      districtName: "Los Angeles County",
      electionTitle: "County Assessor",
      electionDate: "2026-11-03",
      outcome: "won",
      winnerNames: ["Jane Doe (Democratic)"],
    },
    {
      districtName: "Los Angeles County",
      electionTitle: "Measure A",
      electionDate: "2026-11-03",
      outcome: "passed",
      winnerNames: [],
    },
    {
      districtName: "Texas Senate District 19",
      electionTitle: "State Senator, District 19",
      electionDate: "2026-11-03",
      outcome: "runoff",
      winnerNames: ["Ann Alpha (Republican)", "Bob Beta (Democratic)"],
    },
  ],
};

describe("result alert message builders", () => {
  it("builds a subject with singular/plural counts", () => {
    expect(buildResultAlertSubject(undefined, 1)).toBe(
      "[Elections Simplified] Results are in for 1 election in your districts"
    );
    expect(buildResultAlertSubject("MyApp", 3)).toBe(
      "[MyApp] Results are in for 3 elections in your districts"
    );
  });

  it("groups body lines by district with per-outcome phrasing", () => {
    const body = buildResultAlertTextBody(undefined, baseInput);
    expect(body).toContain("Hi Sam,");
    expect(body).toContain(
      "Los Angeles County\n- County Assessor (2026-11-03) — Winner: Jane Doe (Democratic)\n- Measure A (2026-11-03) — Measure passed"
    );
    expect(body).toContain(
      "Texas Senate District 19\n- State Senator, District 19 (2026-11-03) — Headed to a runoff: Ann Alpha (Republican), Bob Beta (Democratic)"
    );
    expect(body).not.toContain("more election");
  });

  it("renders each result as a title, a colored outcome chip, and bold winner names", () => {
    const html = buildResultAlertHtmlBody(undefined, { ...baseInput, unsubscribeUrl: "https://example.com/u?t=1&p=2" });
    // District heading once per group, in ballot order.
    expect(html.match(/>Los Angeles County<\/td>/g)).toHaveLength(1);
    expect(html.indexOf(">Los Angeles County<")).toBeLessThan(html.indexOf(">Texas Senate District 19<"));
    // Outcome chips: green for a win or a passed measure, amber for a runoff.
    expect(html).toContain("background:#15803d;color:#ffffff;font-size:12px;font-weight:600;line-height:1;padding:4px 7px;border-radius:4px;margin-right:8px;\">Winner</span>");
    expect(html).toContain("\">Passed</span>");
    expect(html).toContain("background:#b45309;color:#ffffff;font-size:12px;font-weight:600;line-height:1;padding:4px 7px;border-radius:4px;margin-right:8px;\">Runoff</span>");
    // Name bold, party muted; the per-line date stays out of the HTML.
    expect(html).toContain("<span style=\"font-weight:600;color:#222222;\">Jane Doe</span> <span style=\"color:#717171;\">(Democratic)</span>");
    expect(html).not.toContain("2026-11-03");
    // Footer: escaped unsubscribe link and the copyright line.
    expect(html).toContain("href=\"https://example.com/u?t=1&amp;p=2\"");
    expect(html).toContain("© 2026 Elections Simplified Inc.");
  });

  it("calls uncertified results preliminary and keeps the footer to the unsubscribe link", () => {
    const plain = buildResultAlertTextBody(undefined, baseInput);
    expect(plain).not.toContain("You are receiving this");
    expect(plain).not.toContain("See the details");
    expect(plain).toContain("\n\nElection results are in for your districts on Elections Simplified:\n\nLos Angeles County\n");
    expect(plain).not.toContain("Preliminary");

    const flagged = buildResultAlertTextBody(undefined, { ...baseInput, hasUnofficialResults: true });
    expect(flagged).toContain(
      "\n\nPreliminary election results are in for your districts on Elections Simplified:\n\nLos Angeles County\n"
    );

    const html = buildResultAlertHtmlBody(undefined, { ...baseInput, hasUnofficialResults: true });
    expect(html).toContain(">Preliminary election results are in for your districts on Elections Simplified:</td>");
    expect(html).not.toContain("You are receiving this");
    expect(buildResultAlertHtmlBody(undefined, baseInput)).toContain(
      ">Election results are in for your districts on Elections Simplified:</td>"
    );
  });

  it("notes the remainder when rendered items are capped below the total", () => {
    const body = buildResultAlertTextBody(undefined, { ...baseInput, totalEventCount: 10 });
    expect(body).toContain("…and results for 7 more elections.");
  });

  it("includes the digest unsubscribe link only when provided", () => {
    const withLink = buildResultAlertTextBody(undefined, {
      ...baseInput,
      unsubscribeUrl: "https://api.example.com/api/email/unsubscribe?token=t",
    });
    expect(withLink).toContain("Unsubscribe from these emails: https://api.example.com");
    expect(buildResultAlertTextBody(undefined, baseInput)).not.toContain("Unsubscribe");
  });
});

describe("createSesElectionResultAlertMailer", () => {
  it("sends a composed SES message with one-click unsubscribe headers", async () => {
    const send = vi.fn().mockResolvedValue({});
    const mailer = createSesElectionResultAlertMailer({
      fromEmailAddress: "alerts@example.com",
      sesClient: { send },
    });

    await mailer.sendResultAlertEmail({
      ...baseInput,
      unsubscribeUrl: "https://api.example.com/api/email/unsubscribe?token=t",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input.Destination?.ToAddresses).toEqual(["voter@example.com"]);
    expect(command.input.Content?.Simple?.Subject?.Data).toBe(
      "[Elections Simplified] Results are in for 3 elections in your districts"
    );
    expect(command.input.Content?.Simple?.Headers).toEqual([
      {
        Name: "List-Unsubscribe",
        Value: "<https://api.example.com/api/email/unsubscribe?token=t>",
      },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("omits unsubscribe headers when no link is provided and rejects empty item lists", async () => {
    const send = vi.fn().mockResolvedValue({});
    const mailer = createSesElectionResultAlertMailer({
      fromEmailAddress: "alerts@example.com",
      sesClient: { send },
    });

    await mailer.sendResultAlertEmail(baseInput);
    expect(send.mock.calls[0][0].input.Content?.Simple?.Headers).toBeUndefined();

    await expect(mailer.sendResultAlertEmail({ ...baseInput, items: [] })).rejects.toThrow(
      "Result alert email requires at least one item"
    );
  });
});

describe("createConsoleElectionResultAlertMailer", () => {
  it("logs the composed alert instead of sending", async () => {
    const log = vi.fn();
    const mailer = createConsoleElectionResultAlertMailer({ log });

    await mailer.sendResultAlertEmail(baseInput);

    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0][0] as string;
    expect(message).toContain("to=voter@example.com");
    expect(message).toContain("Results are in for 3 elections in your districts");
    expect(message).toContain("Los Angeles County");
  });
});
