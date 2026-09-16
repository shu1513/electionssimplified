import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildBroadcastMailerFromEnv,
  parseSendIssueBroadcastArgs,
} from "../../src/scripts/sendIssueBroadcast.js";

const bodyFile = join(mkdtempSync(join(tmpdir(), "broadcast-test-")), "body.txt");
writeFileSync(bodyFile, "Green Futures does great work.\n");

const requiredArgs = [
  "--broadcast-id",
  "env-test",
  "--areas",
  "environment_and_public_health,housing_affordability",
  "--subject",
  "A nonprofit worth knowing",
  "--body-file",
  bodyFile,
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseSendIssueBroadcastArgs", () => {
  it("parses a full invocation and defaults to a dry run", () => {
    const options = parseSendIssueBroadcastArgs(requiredArgs);

    expect(options).toMatchObject({
      live: false,
      allowConsole: false,
      broadcastId: "env-test",
      areaSlugs: ["environment_and_public_health", "housing_affordability"],
      subject: "A nonprofit worth knowing",
      batchSize: 500,
    });
    expect(options.body).toContain("Green Futures");
  });

  it("rejects stray arguments such as a value after --live", () => {
    // `--live false` must not silently run live: this CLI sends real email.
    expect(() => parseSendIssueBroadcastArgs([...requiredArgs, "--live", "false"])).toThrow(
      "Unexpected argument: false"
    );
    expect(() => parseSendIssueBroadcastArgs([...requiredArgs, "oops"])).toThrow("Unexpected argument: oops");
  });

  it("requires every value flag", () => {
    expect(() => parseSendIssueBroadcastArgs(["--broadcast-id", "x"])).toThrow("--body-file is required");
  });
});

describe("buildBroadcastMailerFromEnv", () => {
  it("refuses a live console mailer unless --allow-console was passed", () => {
    vi.stubEnv("NOTIFICATIONS_MAILER", "console");

    expect(() => buildBroadcastMailerFromEnv(false)).toThrow("--allow-console");
    expect(buildBroadcastMailerFromEnv(true)).toHaveProperty("sendBroadcastEmail");
  });

  it("refuses the SES mailer without a postal address for the CAN-SPAM footer", () => {
    vi.stubEnv("NOTIFICATIONS_MAILER", "ses");
    vi.stubEnv("AUTH_FROM_EMAIL", "noreply@example.com");
    vi.stubEnv("AUTH_SES_REGION", "us-east-2");
    vi.stubEnv("NOTIFICATIONS_UNSUBSCRIBE_URL", "https://api.example.com/api/email/unsubscribe");
    vi.stubEnv("NOTIFICATIONS_UNSUBSCRIBE_SECRET", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("EMAIL_POSTAL_ADDRESS", "");

    expect(() => buildBroadcastMailerFromEnv(false)).toThrow("EMAIL_POSTAL_ADDRESS");

    vi.stubEnv("EMAIL_POSTAL_ADDRESS", "Elections Simplified Inc., PMB 100, Sacramento, CA 95814");
    expect(buildBroadcastMailerFromEnv(false)).toHaveProperty("sendBroadcastEmail");
  });
});
