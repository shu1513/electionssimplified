import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { Pool } from "pg";

import { loadProjectEnv } from "../config/env.js";
import { readPositiveIntegerFlag } from "../utils/cliFlags.js";
import {
  assertUnsubscribeLinksConfigured,
  buildUnsubscribeUrlBuilderFromEnv,
  requirePostalAddress,
} from "./sendCandidateFollowDigests.js";
import {
  DEFAULT_BROADCAST_MAX_USERS,
  sendIssueBroadcast,
  withIssueBroadcastRunLock,
  type SendIssueBroadcastOptions,
} from "../pipeline/users/issueBroadcast.js";
import {
  createConsoleIssueBroadcastMailer,
  createSesIssueBroadcastMailer,
  type IssueBroadcastMailer,
} from "../pipeline/users/issueBroadcastMailer.js";

// Thin CLI over the issue-broadcast pipeline function (a future admin page
// calls the same function through an API route). Dry run by default:
//
//   npm run notifications:broadcast -- \
//     --broadcast-id env-nonprofit-2026-07 \
//     --areas environment_and_public_health \
//     --subject "A nonprofit worth knowing" \
//     --body-file ./broadcast.txt \
//     [--live] [--batch-size 500] [--allow-console]

function readStringFlag(argv: readonly string[], flagName: string): string | null {
  const flagIndex = argv.indexOf(flagName);
  const inlinePrefix = `${flagName}=`;
  const inline = argv.find((token) => token.startsWith(inlinePrefix));
  const rawValue = flagIndex >= 0 ? argv[flagIndex + 1] : inline ? inline.slice(inlinePrefix.length) : null;
  if (flagIndex >= 0 && (rawValue === undefined || rawValue === null || rawValue.startsWith("--"))) {
    throw new Error(`${flagName} requires a value`);
  }
  return rawValue ?? null;
}

function requireStringFlag(argv: readonly string[], flagName: string): string {
  const value = readStringFlag(argv, flagName);
  if (value === null || value.trim().length === 0) {
    throw new Error(`${flagName} is required`);
  }
  return value.trim();
}

const VALUE_FLAGS = ["--broadcast-id", "--areas", "--subject", "--body-file", "--batch-size"] as const;
const BARE_FLAGS = ["--live", "--allow-console"] as const;

/**
 * Rejects tokens that are not a known flag or a known flag's value. This CLI
 * sends real email, so a malformed invocation like `--live false` (which
 * would otherwise still run live) must fail loudly instead of being ignored.
 */
function assertNoStrayArgs(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if ((BARE_FLAGS as readonly string[]).includes(token)) {
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      index += 1; // skip the flag's value
      continue;
    }
    if (VALUE_FLAGS.some((flag) => token.startsWith(`${flag}=`))) {
      continue;
    }
    throw new Error(`Unexpected argument: ${token}`);
  }
}

export function parseSendIssueBroadcastArgs(
  argv: readonly string[]
): SendIssueBroadcastOptions & { allowConsole: boolean } {
  assertNoStrayArgs(argv);
  const bodyFile = requireStringFlag(argv, "--body-file");
  return {
    live: argv.includes("--live"),
    allowConsole: argv.includes("--allow-console"),
    broadcastId: requireStringFlag(argv, "--broadcast-id"),
    areaSlugs: requireStringFlag(argv, "--areas")
      .split(",")
      .map((slug) => slug.trim())
      .filter((slug) => slug.length > 0),
    subject: requireStringFlag(argv, "--subject"),
    body: readFileSync(bodyFile, "utf8"),
    batchSize: readPositiveIntegerFlag(argv, "--batch-size", DEFAULT_BROADCAST_MAX_USERS),
  };
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function buildBroadcastMailerFromEnv(allowConsole: boolean): IssueBroadcastMailer {
  // Reuses the auth mailer configuration: broadcasts go out from the same
  // sender identity. NOTIFICATIONS_MAILER=console overrides for local runs.
  const mailerKind = (readOptionalEnv("NOTIFICATIONS_MAILER") ?? readOptionalEnv("AUTH_MAILER") ?? "ses").toLowerCase();
  if (mailerKind === "console") {
    // A live console run still writes dedupe rows, so a later real send with
    // the same broadcast id would skip users who never got an email. Make
    // that footgun an explicit choice.
    if (!allowConsole) {
      throw new Error(
        "NOTIFICATIONS_MAILER=console with --live writes dedupe rows without delivering email; pass --allow-console if that is intended (local testing)"
      );
    }
    return createConsoleIssueBroadcastMailer();
  }
  if (mailerKind !== "ses") {
    throw new Error(`Unsupported notifications mailer: ${mailerKind} (expected "ses" or "console")`);
  }
  const fromEmailAddress = readOptionalEnv("AUTH_FROM_EMAIL");
  const sesRegion =
    readOptionalEnv("AUTH_SES_REGION") ?? readOptionalEnv("AWS_REGION") ?? readOptionalEnv("AWS_DEFAULT_REGION");
  if (!fromEmailAddress || !sesRegion) {
    throw new Error(
      "SES broadcast mailer requires AUTH_FROM_EMAIL and AUTH_SES_REGION/AWS_REGION (or set NOTIFICATIONS_MAILER=console)"
    );
  }
  assertUnsubscribeLinksConfigured("SES broadcast mailer");
  const postalAddress = requirePostalAddress("SES broadcast mailer");
  const replyToEmailAddress = readOptionalEnv("AUTH_REPLY_TO_EMAIL");
  return createSesIssueBroadcastMailer({
    sesClient: new SESv2Client({ region: sesRegion }),
    fromEmailAddress,
    postalAddress,
    ...(replyToEmailAddress ? { replyToEmailAddress } : {}),
  });
}

async function main(): Promise<void> {
  loadProjectEnv();
  const { allowConsole, ...parsedOptions } = parseSendIssueBroadcastArgs(process.argv.slice(2));
  const buildUnsubscribeUrl = buildUnsubscribeUrlBuilderFromEnv("issue_updates");
  const options: SendIssueBroadcastOptions = {
    ...parsedOptions,
    ...(buildUnsubscribeUrl ? { buildUnsubscribeUrl } : {}),
  };
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to send an issue broadcast");
  }

  // The dry run never sends, so it must not require mailer configuration.
  const mailer: IssueBroadcastMailer = options.live
    ? buildBroadcastMailerFromEnv(allowConsole)
    : {
        async sendBroadcastEmail() {
          throw new Error("Dry run must not send email");
        },
      };

  const pool = new Pool({ connectionString });
  try {
    // Dry runs read without marking, so they run unlocked.
    const result = options.live
      ? await withIssueBroadcastRunLock(pool, () => sendIssueBroadcast(pool, mailer, options))
      : await sendIssueBroadcast(pool, mailer, options);
    if (result === null) {
      console.log(JSON.stringify({ skipped: true, reason: "another broadcast run holds the lock" }, null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        {
          ...result,
          ...(options.live ? {} : { next: "re-run with --live to send" }),
        },
        null,
        2
      )
    );
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("issue broadcast failed:", message);
    process.exitCode = 1;
  });
}
