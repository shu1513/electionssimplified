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
    expect(html.match(/>Los Angeles County<\/div>/g)).toHaveLength(1);
    expect(html.indexOf(">Los Angeles County<")).toBeLessThan(html.indexOf(">Texas Senate District 19<"));
    // Outcome chips: green for a win or a passed measure, amber for a runoff.
    expect(html).toContain('<span style="background:#15803d;color:#fff;font-size:12px;font-weight:600;padding:2px 7px;border-radius:4px;margin-right:8px">Winner</span>');
    expect(html).toContain(">Passed</span>");
    expect(html).toContain('<span style="background:#b45309;color:#fff;font-size:12px;font-weight:600;padding:2px 7px;border-radius:4px;margin-right:8px">Runoff</span>');
    // Name bold, party muted.
    expect(html).toContain('<b>Jane Doe</b> <span style="color:#717171">(Democratic)</span>');
    // Footer: escaped unsubscribe link and the copyright line.
    expect(html).toContain('href="https://example.com/u?t=1&amp;p=2"');
    expect(html).toContain("© 2026 Elections Simplified Inc.");
  });

  it("shows the election date in the HTML only when the results span more than one day", () => {
    // One election day (the usual case): the date is noise, so it is left out.
    expect(buildResultAlertHtmlBody(undefined, baseInput)).not.toContain("2026-11-03");

    // A special and a regular election for the same office share a title;
    // the date is what tells them apart.
    const mixed = buildResultAlertHtmlBody(undefined, {
      ...baseInput,
      items: [
        baseInput.items[0]!,
        { ...baseInput.items[0]!, electionDate: "2026-12-08", winnerNames: ["John Roe (Republican)"] },
      ],
      totalEventCount: 2,
    });
    expect(mixed).toContain('County Assessor <span style="color:#717171">(2026-11-03)</span>');
    expect(mixed).toContain('County Assessor <span style="color:#717171">(2026-12-08)</span>');
  });

  it("keeps a full 200-result email under Gmail's 102 KB clipping limit", () => {
    // Past about 102 KB Gmail hides the rest of the message, including the
    // unsubscribe link, behind "View entire message". Titles and names here
    // are longer than the Nov 2026 average (60-character titles).
    const items = Array.from({ length: 200 }, (_, index) => ({
      districtName: `District number ${Math.floor(index / 10)} of a long county name, California`,
      electionTitle: `Member of the Board of Supervisors, Supervisorial District ${index}, Full Term Ending 2030`,
      electionDate: "2026-11-03",
      outcome: "won",
      winnerNames: [`Alexandria Montgomery-Fitzgerald ${index} (Democratic)`],
    }));
    const html = buildResultAlertHtmlBody(undefined, {
      ...baseInput,
      items,
      totalEventCount: 200,
      hasUnofficialResults: true,
      unsubscribeUrl: `https://example.com/api/email/unsubscribe?token=${"t".repeat(160)}`,
    });
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(102 * 1024);
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
