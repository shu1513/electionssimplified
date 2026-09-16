import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { APP_NAME, COPYRIGHT_LINE } from "../../constants/brand.js";
import type { MembershipChangedEmailInput, MembershipStartedEmailInput } from "./membershipService.js";

// The §17602 post-purchase acknowledgment (docs/plans/membership-contributions.md):
// a retainable notice, sent when a membership starts, that states what renews,
// for how much, and how to cancel. A Stripe receipt alone doesn't carry the
// cancellation policy, which is why this exists.

export type SendMembershipStartedEmail = (input: MembershipStartedEmailInput) => Promise<void>;

export type SesMembershipMailerOptions = {
  sesClient: Pick<SESv2Client, "send">;
  fromEmailAddress: string;
  replyToEmailAddress?: string;
  /** Absolute URL of the Manage membership page (/me/membership). */
  manageMembershipUrl: string;
  /** Absolute URL of the Terms of Use. */
  termsUrl: string;
};

function formatUsd(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function buildTextBody(input: MembershipStartedEmailInput, manageMembershipUrl: string, termsUrl: string): string {
  const amount = formatUsd(input.monthlyAmountCents);
  return (
    `Thank you for supporting ${APP_NAME}.\n\n` +
    `Your monthly membership is active: ${amount} will be charged to your payment method each month until you cancel. ` +
    `Your support funds the operation of the service; it is not a contribution to any candidate, campaign, committee, party, or charity, and it is not tax-deductible.\n\n` +
    `Cancel anytime: open Manage membership.\n${manageMembershipUrl}\n\n` +
    `Terms of Use: ${termsUrl}\n\n` +
    `Questions? Just reply to this email.\n\n${COPYRIGHT_LINE}`
  );
}

function buildHtmlBody(input: MembershipStartedEmailInput, manageMembershipUrl: string, termsUrl: string): string {
  const amount = escapeHtml(formatUsd(input.monthlyAmountCents));
  const manageUrl = escapeHtml(manageMembershipUrl);
  const terms = escapeHtml(termsUrl);
  return `<!doctype html>
<html lang="en">
  <body>
    <p>Thank you for supporting ${escapeHtml(APP_NAME)}.</p>
    <p>Your monthly membership is active: <strong>${amount}</strong> will be charged to your payment method each month until you cancel. Your support funds the operation of the service; it is not a contribution to any candidate, campaign, committee, party, or charity, and it is not tax-deductible.</p>
    <p>Cancel anytime: open <a href="${manageUrl}">Manage membership</a>.</p>
    <p><a href="${terms}">Terms of Use</a></p>
    <p>Questions? Just reply to this email.</p>
    <p>${escapeHtml(COPYRIGHT_LINE)}</p>
  </body>
</html>`;
}

export function createSesMembershipStartedSender(options: SesMembershipMailerOptions): SendMembershipStartedEmail {
  return async (input) => {
    await options.sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: options.fromEmailAddress,
        Destination: { ToAddresses: [input.email] },
        ReplyToAddresses: options.replyToEmailAddress ? [options.replyToEmailAddress] : undefined,
        Content: {
          Simple: {
            Subject: {
              Data: `[${APP_NAME}] Your monthly membership is active`,
              Charset: "UTF-8",
            },
            Body: {
              Text: {
                Data: buildTextBody(input, options.manageMembershipUrl, options.termsUrl),
                Charset: "UTF-8",
              },
              Html: {
                Data: buildHtmlBody(input, options.manageMembershipUrl, options.termsUrl),
                Charset: "UTF-8",
              },
            },
          },
        },
      })
    );
  };
}

export type ConsoleMembershipMailerOptions = {
  manageMembershipUrl: string;
  termsUrl: string;
  log?: (message: string) => void;
};

/** Local-development sender: prints instead of emailing (AUTH_MAILER=console). */
export function createConsoleMembershipStartedSender(
  options: ConsoleMembershipMailerOptions
): SendMembershipStartedEmail {
  const log = options.log ?? ((message: string) => console.log(message));
  return async (input) => {
    log(
      `[membership-mailer:console] membership-started acknowledgment for ${input.email}: ` +
        `${formatUsd(input.monthlyAmountCents)}/month, manage at ${options.manageMembershipUrl}`
    );
  };
}

// Membership changes (docs/plans/membership-manage-page.md): cancel / resume
// are courtesy confirmations for changes the member made in an authenticated
// session; the amount notice is the CA BPC §17602(g)(2) advance notice of a
// fee change, sent 7–30 days before the first charge at the new amount, so
// like the start acknowledgment it states the amount, the date, and how to
// cancel.

export type SendMembershipChangedEmail = (input: MembershipChangedEmailInput) => Promise<void>;

// Renewal instants are shown as a calendar date in the operator's time zone
// (the Stripe dashboard's default for this account); the member's own zone is
// unknowable server-side.
function formatDate(value: Date): string {
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

function changedSubject(input: MembershipChangedEmailInput): string {
  if (input.kind === "canceled") {
    return input.endsAt
      ? `[${APP_NAME}] Your membership will end on ${formatDate(input.endsAt)}`
      : `[${APP_NAME}] Your membership will not renew`;
  }
  if (input.kind === "amount_notice") {
    return `[${APP_NAME}] Your membership amount changes on ${formatDate(input.startsAt)}`;
  }
  return `[${APP_NAME}] Your membership continues`;
}

function changedTextBody(input: MembershipChangedEmailInput, manageMembershipUrl: string, termsUrl: string): string {
  if (input.kind === "amount_notice") {
    const amount = formatUsd(input.newAmountCents);
    return (
      `You asked to change your monthly membership amount. Starting on ${formatDate(input.startsAt)}, ${amount} will be charged to your payment method each month until you cancel. ` +
      `Nothing is charged today. ` +
      `Your support funds the operation of the service; it is not a contribution to any candidate, campaign, committee, party, or charity, and it is not tax-deductible.\n\n` +
      `Cancel anytime: open Manage membership.\n${manageMembershipUrl}\n\n` +
      `Terms of Use: ${termsUrl}\n\n` +
      `Questions? Just reply to this email.\n\n${COPYRIGHT_LINE}`
    );
  }
  if (input.kind === "canceled") {
    const when = input.endsAt ? ` after ${formatDate(input.endsAt)}` : "";
    return (
      `Your monthly membership will not renew${when}. You will not be charged for another month after that.\n\n` +
      `Changed your mind? Open Manage membership and choose Keep membership.\n${manageMembershipUrl}\n\n` +
      `Thank you for having supported ${APP_NAME}.\n\n` +
      `Questions? Just reply to this email.\n\n${COPYRIGHT_LINE}`
    );
  }
  const amount = formatUsd(input.monthlyAmountCents);
  const next = input.renewsAt ? ` on ${formatDate(input.renewsAt)} and` : "";
  return (
    `Welcome back. Your monthly membership continues: ${amount} will be charged to your payment method${next} each month until you cancel.\n\n` +
    `Cancel anytime: open Manage membership.\n${manageMembershipUrl}\n\n` +
    `Terms of Use: ${termsUrl}\n\n` +
    `Questions? Just reply to this email.\n\n${COPYRIGHT_LINE}`
  );
}

function changedHtmlBody(input: MembershipChangedEmailInput, manageMembershipUrl: string, termsUrl: string): string {
  const manageUrl = escapeHtml(manageMembershipUrl);
  const body =
    input.kind === "amount_notice"
      ? `<p>You asked to change your monthly membership amount. Starting on <strong>${escapeHtml(formatDate(input.startsAt))}</strong>, <strong>${escapeHtml(formatUsd(input.newAmountCents))}</strong> will be charged to your payment method each month until you cancel. Nothing is charged today. Your support funds the operation of the service; it is not a contribution to any candidate, campaign, committee, party, or charity, and it is not tax-deductible.</p>
    <p>Cancel anytime: open <a href="${manageUrl}">Manage membership</a>.</p>
    <p><a href="${escapeHtml(termsUrl)}">Terms of Use</a></p>`
      : input.kind === "canceled"
        ? `<p>Your monthly membership will not renew${input.endsAt ? ` after <strong>${escapeHtml(formatDate(input.endsAt))}</strong>` : ""}. You will not be charged for another month after that.</p>
    <p>Changed your mind? Open <a href="${manageUrl}">Manage membership</a> and choose Keep membership.</p>
    <p>Thank you for having supported ${escapeHtml(APP_NAME)}.</p>`
        : `<p>Welcome back. Your monthly membership continues: <strong>${escapeHtml(formatUsd(input.monthlyAmountCents))}</strong> will be charged to your payment method${input.renewsAt ? ` on ${escapeHtml(formatDate(input.renewsAt))} and` : ""} each month until you cancel.</p>
    <p>Cancel anytime: open <a href="${manageUrl}">Manage membership</a>.</p>
    <p><a href="${escapeHtml(termsUrl)}">Terms of Use</a></p>`;
  return `<!doctype html>
<html lang="en">
  <body>
    ${body}
    <p>Questions? Just reply to this email.</p>
    <p>${escapeHtml(COPYRIGHT_LINE)}</p>
  </body>
</html>`;
}

export function createSesMembershipChangedSender(options: SesMembershipMailerOptions): SendMembershipChangedEmail {
  return async (input) => {
    await options.sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: options.fromEmailAddress,
        Destination: { ToAddresses: [input.email] },
        ReplyToAddresses: options.replyToEmailAddress ? [options.replyToEmailAddress] : undefined,
        Content: {
          Simple: {
            Subject: { Data: changedSubject(input), Charset: "UTF-8" },
            Body: {
              Text: { Data: changedTextBody(input, options.manageMembershipUrl, options.termsUrl), Charset: "UTF-8" },
              Html: { Data: changedHtmlBody(input, options.manageMembershipUrl, options.termsUrl), Charset: "UTF-8" },
            },
          },
        },
      })
    );
  };
}

export function createConsoleMembershipChangedSender(
  options: ConsoleMembershipMailerOptions
): SendMembershipChangedEmail {
  const log = options.log ?? ((message: string) => console.log(message));
  return async (input) => {
    log(`[membership-mailer:console] ${input.kind} email for ${input.email}: ${changedSubject(input)}`);
  };
}

// ---------------------------------------------------------------------------
// Annual reminder (Cal. Bus. & Prof. Code §17602(b)(2), AB 2863): once a year,
// every continuing member is told what renews, for how much, how often, and
// how to cancel. Sent by backend/src/scripts/sendMembershipAnnualReminders.ts
// ahead of each anniversary of started_at; the send is recorded in
// billing_subscription_annual_reminders. A legal notice about an existing
// paid relationship, so no unsubscribe link: it is transactional, and a
// member who does not want it cancels the membership instead.
// ---------------------------------------------------------------------------

export type MembershipAnnualReminderEmailInput = {
  email: string;
  monthlyAmountCents: number;
  /** When the membership started; shown as a calendar date. */
  startedAt: Date;
};

export type SendMembershipAnnualReminderEmail = (input: MembershipAnnualReminderEmailInput) => Promise<void>;

export function buildAnnualReminderTextBody(
  input: MembershipAnnualReminderEmailInput,
  manageMembershipUrl: string,
  termsUrl: string
): string {
  const amount = formatUsd(input.monthlyAmountCents);
  return (
    `A yearly reminder about your ${APP_NAME} membership.\n\n` +
    `You have supported ${APP_NAME} with a monthly membership since ${formatDate(input.startedAt)}. ` +
    `It renews automatically: ${amount} is charged to your payment method each month until you cancel. ` +
    `Your support funds the operation of the service; it is not a contribution to any candidate, campaign, committee, party, or charity, and it is not tax-deductible.\n\n` +
    `To change the amount or cancel at any time, open Manage membership:\n${manageMembershipUrl}\n` +
    `Cancellation takes effect at the end of the current billing period.\n\n` +
    `Terms of Use: ${termsUrl}\n\n` +
    `Thank you for keeping the service running. Questions? Just reply to this email.\n\n${COPYRIGHT_LINE}`
  );
}

export function buildAnnualReminderHtmlBody(
  input: MembershipAnnualReminderEmailInput,
  manageMembershipUrl: string,
  termsUrl: string
): string {
  const amount = escapeHtml(formatUsd(input.monthlyAmountCents));
  const manageUrl = escapeHtml(manageMembershipUrl);
  const terms = escapeHtml(termsUrl);
  return `<!doctype html>
<html lang="en">
  <body>
    <p>A yearly reminder about your ${escapeHtml(APP_NAME)} membership.</p>
    <p>You have supported ${escapeHtml(APP_NAME)} with a monthly membership since ${escapeHtml(formatDate(input.startedAt))}. It renews automatically: <strong>${amount}</strong> is charged to your payment method each month until you cancel. Your support funds the operation of the service; it is not a contribution to any candidate, campaign, committee, party, or charity, and it is not tax-deductible.</p>
    <p>To change the amount or cancel at any time, open <a href="${manageUrl}">Manage membership</a>. Cancellation takes effect at the end of the current billing period.</p>
    <p><a href="${terms}">Terms of Use</a></p>
    <p>Thank you for keeping the service running. Questions? Just reply to this email.</p>
    <p>${escapeHtml(COPYRIGHT_LINE)}</p>
  </body>
</html>`;
}

export function createSesMembershipAnnualReminderSender(
  options: SesMembershipMailerOptions
): SendMembershipAnnualReminderEmail {
  return async (input) => {
    await options.sesClient.send(
      new SendEmailCommand({
        FromEmailAddress: options.fromEmailAddress,
        Destination: { ToAddresses: [input.email] },
        ReplyToAddresses: options.replyToEmailAddress ? [options.replyToEmailAddress] : undefined,
        Content: {
          Simple: {
            Subject: {
              Data: `[${APP_NAME}] Yearly reminder: your monthly membership`,
              Charset: "UTF-8",
            },
            Body: {
              Text: {
                Data: buildAnnualReminderTextBody(input, options.manageMembershipUrl, options.termsUrl),
                Charset: "UTF-8",
              },
              Html: {
                Data: buildAnnualReminderHtmlBody(input, options.manageMembershipUrl, options.termsUrl),
                Charset: "UTF-8",
              },
            },
          },
        },
      })
    );
  };
}

export function createConsoleMembershipAnnualReminderSender(
  options: ConsoleMembershipMailerOptions
): SendMembershipAnnualReminderEmail {
  const log = options.log ?? ((message: string) => console.log(message));
  return async (input) => {
    log(
      `[membership-mailer:console] annual reminder for ${input.email}: ` +
        `${formatUsd(input.monthlyAmountCents)}/month since ${formatDate(input.startedAt)}, manage at ${options.manageMembershipUrl}`
    );
  };
}
