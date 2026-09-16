import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, it, vi } from "vitest";

import {
  buildBroadcastHtmlBody,
  buildBroadcastTextBody,
  createConsoleIssueBroadcastMailer,
  createSesIssueBroadcastMailer,
  type IssueBroadcastEmailInput,
} from "../../../src/pipeline/users/issueBroadcastMailer.js";

const baseInput: IssueBroadcastEmailInput = {
  email: "voter@example.com",
  firstName: "Sam",
  subject: "A nonprofit worth knowing",
  body: "Green Futures does great work.\n\nLearn more at their site.",
  matchedAreaNames: ["Environment and Public Health"],
};

describe("broadcast message builders", () => {
  it("renders the operator body verbatim in text with the matched-areas footer", () => {
    const body = buildBroadcastTextBody(undefined, baseInput);
    expect(body).toContain("Hi Sam,");
    expect(body).toContain("Green Futures does great work.\n\nLearn more at their site.");
    expect(body).toContain(
      "because you saved Environment and Public Health as issues you care about on Elections Simplified"
    );
  });

  it("falls back to generic footer copy when no matched areas are provided", () => {
    const body = buildBroadcastTextBody("MyApp", { ...baseInput, matchedAreaNames: [] });
    expect(body).toContain("because you saved your saved issues as issues you care about on MyApp");
  });

  it("includes the unsubscribe line only when provided", () => {
    const withLink = buildBroadcastTextBody(undefined, {
      ...baseInput,
      unsubscribeUrl: "https://api.example.com/api/email/unsubscribe?token=t&pref=issue_updates",
    });
    expect(withLink).toContain("Unsubscribe from these updates: https://api.example.com");
    expect(buildBroadcastTextBody(undefined, baseInput)).not.toContain("Unsubscribe");
  });

  it("prints the postal address after the copyright line in both parts when provided", () => {
    const postal = "Elections Simplified Inc., PMB 100, 1 Main St, Sacramento, CA 95814";
    const text = buildBroadcastTextBody(undefined, baseInput, postal);
    expect(text.endsWith(`\n${postal}`)).toBe(true);
    const html = buildBroadcastHtmlBody(undefined, baseInput, "<PMB> & Co");
    expect(html).toContain("&lt;PMB&gt; &amp; Co</p>");
    expect(buildBroadcastTextBody(undefined, baseInput)).not.toContain("PMB");
  });

  it("escapes the operator body in HTML and turns blank lines into paragraphs", () => {
    const html = buildBroadcastHtmlBody(undefined, {
      ...baseInput,
      body: "Watch out for <script>alert(1)</script> & friends.\n\nSecond paragraph\nwith a break.",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; friends.");
    expect(html).toContain("<p>Second paragraph<br>with a break.</p>");
  });
});

describe("createSesIssueBroadcastMailer", () => {
  it("sends a composed SES message with one-click unsubscribe headers", async () => {
    const send = vi.fn().mockResolvedValue({});
    const mailer = createSesIssueBroadcastMailer({
      fromEmailAddress: "updates@example.com",
      sesClient: { send },
    });

    await mailer.sendBroadcastEmail({
      ...baseInput,
      unsubscribeUrl: "https://api.example.com/api/email/unsubscribe?token=t&pref=issue_updates",
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input.Destination?.ToAddresses).toEqual(["voter@example.com"]);
    expect(command.input.Content?.Simple?.Subject?.Data).toBe("A nonprofit worth knowing");
    expect(command.input.Content?.Simple?.Headers).toEqual([
      {
        Name: "List-Unsubscribe",
        Value: "<https://api.example.com/api/email/unsubscribe?token=t&pref=issue_updates>",
      },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("rejects unsubscribe URLs that would break email headers", async () => {
    const send = vi.fn();
    const mailer = createSesIssueBroadcastMailer({
      fromEmailAddress: "updates@example.com",
      sesClient: { send },
    });

    await expect(
      mailer.sendBroadcastEmail({ ...baseInput, unsubscribeUrl: "https://x.test/a\r\nBcc: evil@x.test" })
    ).rejects.toThrow("invalid in email headers");
    await expect(
      mailer.sendBroadcastEmail({ ...baseInput, unsubscribeUrl: "javascript:alert(1)" })
    ).rejects.toThrow("http(s)");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an empty subject or body", async () => {
    const send = vi.fn();
    const mailer = createSesIssueBroadcastMailer({
      fromEmailAddress: "updates@example.com",
      sesClient: { send },
    });

    await expect(mailer.sendBroadcastEmail({ ...baseInput, subject: "  " })).rejects.toThrow("subject");
    await expect(mailer.sendBroadcastEmail({ ...baseInput, body: "" })).rejects.toThrow("body");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createConsoleIssueBroadcastMailer", () => {
  it("logs the recipient, subject, and text body instead of sending", async () => {
    const lines: string[] = [];
    const mailer = createConsoleIssueBroadcastMailer({ log: (message) => lines.push(message) });

    await mailer.sendBroadcastEmail(baseInput);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("to=voter@example.com");
    expect(lines[0]).toContain("subject=A nonprofit worth knowing");
    expect(lines[0]).toContain("Green Futures does great work.");
  });
});
