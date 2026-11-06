import { describe, expect, it } from "vitest";

import {
  DEMO_TODAY_ISO,
  inactiveCandidacyStatusesSql,
  isDemoRequest,
  runAsDemoRequest,
  US_LATEST_LOCAL_DATE_SQL,
  usLatestLocalDateIso,
  usLatestLocalDateSql,
} from "../../src/utils/usLocalDate.js";

describe("usLatestLocalDateIso", () => {
  it("returns the UTC date while every US timezone is on the same date", () => {
    // 2026-07-13 22:00 UTC = 12:00 in Honolulu on the 13th.
    expect(usLatestLocalDateIso(new Date("2026-07-13T22:00:00Z"))).toBe("2026-07-13");
  });

  it("stays on the US-local date after the UTC calendar rolls over", () => {
    // 2026-07-14 00:11 UTC = 2026-07-13 17:11 in Los Angeles / 14:11 in
    // Honolulu — the exact live case: a records checkpoint stamped from the
    // UTC date claimed 2026-07-14 as researched on the evening of the 13th.
    expect(usLatestLocalDateIso(new Date("2026-07-14T00:11:00Z"))).toBe("2026-07-13");
  });

  it("rolls to the next date only once Hawaii does", () => {
    // 2026-07-14 10:00 UTC = 2026-07-14 00:00 in Honolulu.
    expect(usLatestLocalDateIso(new Date("2026-07-14T10:00:00Z"))).toBe("2026-07-14");
    expect(usLatestLocalDateIso(new Date("2026-07-14T09:59:59Z"))).toBe("2026-07-13");
  });
});

describe("demo clock", () => {
  it("is off outside a demo request", () => {
    expect(isDemoRequest()).toBe(false);
    expect(usLatestLocalDateSql()).toBe(US_LATEST_LOCAL_DATE_SQL);
    expect(usLatestLocalDateIso()).not.toBe(DEMO_TODAY_ISO);
  });

  it("returns the fixed demo date inside a demo request, across awaits", async () => {
    await runAsDemoRequest(async () => {
      expect(isDemoRequest()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(isDemoRequest()).toBe(true);
      expect(usLatestLocalDateIso()).toBe("2026-11-02");
      expect(usLatestLocalDateSql()).toBe("(DATE '2026-11-02')");
    });
    expect(isDemoRequest()).toBe(false);
  });

  it("counts a result-assigned loss as out of the race only outside the demo", () => {
    expect(inactiveCandidacyStatusesSql()).toBe("('withdrawn', 'lost')");
    runAsDemoRequest(() => {
      expect(inactiveCandidacyStatusesSql()).toBe("('withdrawn')");
    });
  });

  it("keeps an explicit date inside a demo request", () => {
    runAsDemoRequest(() => {
      expect(usLatestLocalDateIso(new Date("2026-07-13T22:00:00Z"))).toBe("2026-07-13");
    });
  });

  it("does not leak into a request running at the same time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const demo = runAsDemoRequest(async () => {
      await gate;
      return isDemoRequest();
    });
    const normal = (async () => {
      await gate;
      return isDemoRequest();
    })();
    release();
    expect(await demo).toBe(true);
    expect(await normal).toBe(false);
  });
});
