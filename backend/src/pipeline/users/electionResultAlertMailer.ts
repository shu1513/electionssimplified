import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { APP_NAME, COPYRIGHT_LINE } from "../../constants/brand.js";

// The opening line says "Preliminary" whenever any result in the email is not
// yet certified, so an election-night count never reads as final.
function buildIntroLine(brand: string, hasUnofficialResults: boolean | undefined): string {
  return hasUnofficialResults
    ? `Preliminary election results are in for your districts on ${brand}:`
    : `Election results are in for your districts on ${brand}:`;
}

export type ElectionResultAlertItem = {
  electionTitle: string;
  electionDate: string;
  districtName: string;
  /** Decisive outcome from the result row: won/advanced/runoff/passed/failed. */
  outcome: string;
  /** Winner display names (with party when known); empty for ballot measures. */
  winnerNames: readonly string[];
};

export type ElectionResultAlertEmailInput = {
  email: string;
  firstName: string;
  /**
   * Items to render, already sorted by district then date. May be fewer than
   * totalEventCount when the caller caps rendering; the body then notes the
   * remainder.
   */
  items: readonly ElectionResultAlertItem[];
  totalEventCount: number;
  /**
   * True when at least one of the user's pending results is not certified
   * (an election-night unofficial count or a news projection). The opening
   * line then calls the results preliminary.
   */
  hasUnofficialResults?: boolean;
  /**
   * Signed per-user unsubscribe link scoped to the email digest (result
   * alerts ride the digest opt-in). When present it is rendered in the footer
   * and emitted as List-Unsubscribe / List-Unsubscribe-Post headers (RFC 8058
   * one-click).
   */
  unsubscribeUrl?: string;
};

export type ElectionResultAlertMailer = {
  sendResultAlertEmail(input: ElectionResultAlertEmailInput): Promise<void>;
};

export type SesElectionResultAlertMailerOptions = {
  appName?: string;
  fromEmailAddress: string;
  replyToEmailAddress?: string;
  sesClient: Pick<SESv2Client, "send">;
};

function resolveBrandName(appName: string | undefined): string {
  const normalized = appName?.trim();
  return normalized && normalized.length > 0 ? normalized : APP_NAME;
}

function normalizeEmailAddress(email: string): string {
  if (typeof email !== "string") {
    throw new Error("Email address must be a string");
  }
  const normalized = email.trim();
  if (normalized.length === 0) {
    throw new Error("Email address must be a non-empty string");
  }
  return normalized;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function describeOutcome(item: ElectionResultAlertItem): string {
  const winners = item.winnerNames.map((name) => name.trim()).filter((name) => name.length > 0);
  switch (item.outcome) {
    case "won":
      return winners.length > 0 ? `Winner${winners.length === 1 ? "" : "s"}: ${winners.join(", ")}` : "Decided";
    case "advanced":
      return winners.length > 0 ? `Advancing: ${winners.join(", ")}` : "Advanced to the next round";
    case "runoff":
      return winners.length > 0 ? `Headed to a runoff: ${winners.join(", ")}` : "Headed to a runoff";
    case "passed":
      return "Measure passed";
    case "failed":
      return "Measure failed";
    default:
      return "Results available";
  }
}

function describeItem(item: ElectionResultAlertItem): string {
  const title = item.electionTitle.trim() || "Election";
  const date = item.electionDate.trim();
  const heading = date ? `${title} (${date})` : title;
  return `${heading} — ${describeOutcome(item)}`;
}

function groupItemsByDistrict(
  items: readonly ElectionResultAlertItem[]
): Array<{ districtName: string; lines: string[] }> {
  const groups: Array<{ districtName: string; lines: string[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.districtName === item.districtName) {
      last.lines.push(describeItem(item));
    } else {
      groups.push({ districtName: item.districtName, lines: [describeItem(item)] });
    }
  }
  return groups;
}

export function buildResultAlertSubject(appName: string | undefined, totalEventCount: number): string {
  const brand = resolveBrandName(appName);
  const noun = totalEventCount === 1 ? "election" : "elections";
  return `[${brand}] Results are in for ${totalEventCount} ${noun} in your districts`;
}

export function buildResultAlertTextBody(
  appName: string | undefined,
  input: ElectionResultAlertEmailInput
): string {
  const brand = resolveBrandName(appName);
  const groups = groupItemsByDistrict(input.items);
  const sections = groups.map(
    (group) => `${group.districtName}\n${group.lines.map((line) => `- ${line}`).join("\n")}`
  );
  const remainder = input.totalEventCount - input.items.length;
  const remainderLine = remainder > 0 ? `\n…and results for ${remainder} more election${remainder === 1 ? "" : "s"}.\n` : "";
  const unsubscribeLine = input.unsubscribeUrl
    ? `\nUnsubscribe from these emails: ${input.unsubscribeUrl}`
    : "";
  return (
    `Hi ${input.firstName.trim() || "there"},\n\n` +
    `${buildIntroLine(brand, input.hasUnofficialResults)}\n\n` +
    `${sections.join("\n\n")}\n` +
    remainderLine +
    unsubscribeLine +
    `\n\n${COPYRIGHT_LINE}`
  );
}

// HTML styling. Email clients ignore <style> blocks and classes, so every
// rule is inline. The colors mirror the site's tokens in
// frontend/src/index.css (ink, ink-soft, surface) and the green of its result
// chip, so the email reads as the same product. No images: nothing to block.
const EMAIL_FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const EMAIL_INK = "#222222";
const EMAIL_INK_SOFT = "#717171";
const EMAIL_SURFACE = "#faf7f2";
const EMAIL_LINE = "#ece7df";
const EMAIL_GREEN = "#15803d";
const EMAIL_AMBER = "#b45309";

function outcomeChip(item: ElectionResultAlertItem): { label: string; color: string } {
  const winnerCount = item.winnerNames.filter((name) => name.trim().length > 0).length;
  switch (item.outcome) {
    case "won":
      return { label: winnerCount > 1 ? "Winners" : winnerCount === 1 ? "Winner" : "Decided", color: EMAIL_GREEN };
    case "advanced":
      return { label: "Advancing", color: EMAIL_GREEN };
    case "runoff":
      return { label: "Runoff", color: EMAIL_AMBER };
    case "passed":
      return { label: "Passed", color: EMAIL_GREEN };
    case "failed":
      return { label: "Failed", color: EMAIL_INK_SOFT };
    default:
      return { label: "Results available", color: EMAIL_INK_SOFT };
  }
}

// Winner names arrive as "Name (Party)"; the name is set bold and the party
// muted so a long list still scans by name.
function renderWinnerNameHtml(raw: string): string {
  const name = raw.trim();
  const partyStart = name.endsWith(")") ? name.lastIndexOf(" (") : -1;
  if (partyStart <= 0) {
    return `<b>${escapeHtml(name)}</b>`;
  }
  return (
    `<b>${escapeHtml(name.slice(0, partyStart))}</b>` +
    ` <span style="color:${EMAIL_INK_SOFT}">${escapeHtml(name.slice(partyStart + 1))}</span>`
  );
}

// One race: its title, then the outcome chip and winners on the next line.
// Kept deliberately light: Gmail clips an HTML part past about 102 KB and
// hides the rest (including the unsubscribe link) behind "View entire
// message", and this markup repeats once per result. Font, size and ink
// color are inherited from the district cell rather than restated here.
function renderItemHtml(item: ElectionResultAlertItem, showDate: boolean): string {
  const chip = outcomeChip(item);
  const winners = item.winnerNames
    .filter((name) => name.trim().length > 0)
    .map(renderWinnerNameHtml)
    .join(", ");
  const date = item.electionDate.trim();
  const dateHtml = showDate && date ? ` <span style="color:${EMAIL_INK_SOFT}">(${escapeHtml(date)})</span>` : "";
  return (
    `<div style="margin-top:12px">${escapeHtml(item.electionTitle.trim() || "Election")}${dateHtml}<br>` +
    `<span style="background:${chip.color};color:#fff;font-size:12px;font-weight:600;padding:2px 7px;border-radius:4px;margin-right:8px">${escapeHtml(chip.label)}</span>` +
    `${winners}</div>`
  );
}

export function buildResultAlertHtmlBody(
  appName: string | undefined,
  input: ElectionResultAlertEmailInput
): string {
  const brand = escapeHtml(resolveBrandName(appName));
  // Every result in one email is normally from the same election day, so the
  // date is noise. It comes back when the batch spans more than one day (a
  // special and a regular election for the same office share a title).
  const showDates = new Set(input.items.map((item) => item.electionDate.trim())).size > 1;
  const sections: string[] = [];
  let currentDistrict: string | null = null;
  let currentRows: string[] = [];
  const flushSection = (): void => {
    if (currentDistrict === null) {
      return;
    }
    sections.push(
      `        <tr><td style="padding:18px 28px 6px 28px;border-top:1px solid ${EMAIL_LINE};${EMAIL_FONT}font-size:15px;line-height:1.5;color:${EMAIL_INK};">` +
        `<div style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${EMAIL_INK_SOFT}">${escapeHtml(currentDistrict)}</div>\n` +
        `${currentRows.join("\n")}</td></tr>`
    );
  };
  for (const item of input.items) {
    if (item.districtName !== currentDistrict) {
      flushSection();
      currentDistrict = item.districtName;
      currentRows = [];
    }
    currentRows.push(renderItemHtml(item, showDates));
  }
  flushSection();
  const remainder = input.totalEventCount - input.items.length;
  const remainderHtml =
    remainder > 0
      ? `        <tr><td style="padding:14px 28px 0 28px;${EMAIL_FONT}font-size:14px;line-height:1.5;color:${EMAIL_INK_SOFT};">…and results for ${remainder} more election${remainder === 1 ? "" : "s"}.</td></tr>\n`
      : "";
  const unsubscribeHtml = input.unsubscribeUrl
    ? `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${EMAIL_INK_SOFT};">Unsubscribe from these emails</a><br>`
    : "";
  const bodyText = `${EMAIL_FONT}font-size:15px;line-height:1.6;color:${EMAIL_INK};`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
  </head>
  <body style="margin:0;padding:0;background:${EMAIL_SURFACE};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_SURFACE};"><tr><td align="center" style="padding:24px 12px 32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${EMAIL_LINE};border-radius:10px;">
        <tr><td style="padding:22px 28px 0 28px;${EMAIL_FONT}font-size:17px;font-weight:700;color:${EMAIL_INK};">${brand}</td></tr>
        <tr><td style="padding:18px 28px 4px 28px;${bodyText}">Hi ${escapeHtml(input.firstName.trim() || "there")},</td></tr>
        <tr><td style="padding:4px 28px 20px 28px;${bodyText}">${buildIntroLine(brand, input.hasUnofficialResults)}</td></tr>
${sections.join("\n")}
        <tr><td style="padding:0 28px 22px 28px;font-size:0;line-height:0;">&nbsp;</td></tr>
${remainderHtml}        <tr><td style="padding:22px 28px 24px 28px;border-top:1px solid ${EMAIL_LINE};${EMAIL_FONT}font-size:12px;line-height:1.6;color:${EMAIL_INK_SOFT};">${unsubscribeHtml}${escapeHtml(COPYRIGHT_LINE)}</td></tr>
      </table>
    </td></tr></table>
  </body>
</html>`;
}

export function createSesElectionResultAlertMailer(
  options: SesElectionResultAlertMailerOptions
): ElectionResultAlertMailer {
  return {
    async sendResultAlertEmail(input) {
      if (input.items.length === 0) {
        throw new Error("Result alert email requires at least one item");
      }
      await options.sesClient.send(
        new SendEmailCommand({
          FromEmailAddress: normalizeEmailAddress(options.fromEmailAddress),
          Destination: {
            ToAddresses: [normalizeEmailAddress(input.email)],
          },
          ReplyToAddresses: options.replyToEmailAddress
            ? [normalizeEmailAddress(options.replyToEmailAddress)]
            : undefined,
          Content: {
            Simple: {
              ...(input.unsubscribeUrl
                ? {
                    Headers: [
                      { Name: "List-Unsubscribe", Value: `<${input.unsubscribeUrl}>` },
                      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
                    ],
                  }
                : {}),
              Subject: {
                Data: buildResultAlertSubject(options.appName, input.totalEventCount),
                Charset: "UTF-8",
              },
              Body: {
                Text: {
                  Data: buildResultAlertTextBody(options.appName, input),
                  Charset: "UTF-8",
                },
                Html: {
                  Data: buildResultAlertHtmlBody(options.appName, input),
                  Charset: "UTF-8",
                },
              },
            },
          },
        })
      );
    },
  };
}

export type ConsoleElectionResultAlertMailerOptions = {
  appName?: string;
  log?: (message: string) => void;
};

// Local-development mailer: prints the alert instead of sending email, so the
// full send loop is testable without an email provider.
export function createConsoleElectionResultAlertMailer(
  options: ConsoleElectionResultAlertMailerOptions = {}
): ElectionResultAlertMailer {
  const log = options.log ?? ((message: string) => console.log(message));
  return {
    async sendResultAlertEmail(input) {
      if (input.items.length === 0) {
        throw new Error("Result alert email requires at least one item");
      }
      const subject = buildResultAlertSubject(options.appName, input.totalEventCount);
      const body = buildResultAlertTextBody(options.appName, input);
      log(
        `[election-result-alert-mailer:console] to=${normalizeEmailAddress(input.email)} subject=${subject}\n${body}`
      );
    },
  };
}
