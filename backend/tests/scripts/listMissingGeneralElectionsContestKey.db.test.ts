import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contestKeySql, sameSeatContestKeySql } from "../../src/scripts/listMissingGeneralElections.js";

/**
 * The missing-generals report pairs a primary with its general by contest key
 * when the two titles name the same seat differently. The key is built by
 * regex SQL, so only a live Postgres shows what it actually matches.
 *
 * Needs DATABASE_URL; it reads no tables (inputs are bound parameters), so it
 * runs against any database. CI runs it in the migrate job; the unit-test job
 * skips it.
 */

const databaseUrl = process.env.DATABASE_URL;

// Title keys as stored (official_ballot_title_key: lowercase, single spaces).
const PIMA = "Pima County, Arizona";
const CAPE_CORAL = "Cape Coral city, Florida";
const CANYON = "Canyon County, Idaho";

describe.skipIf(!databaseUrl)("missing-generals contest-key pairing (requires DATABASE_URL)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function contestKey(titleKey: string, districtName: string): Promise<string> {
    const result = await client.query<{ key: string }>(`SELECT ${contestKeySql("$1::text", "$2::text")} AS key`, [
      titleKey,
      districtName,
    ]);
    return result.rows[0]!.key;
  }

  async function sameSeat(primaryKey: string, laterKey: string, districtName: string): Promise<boolean> {
    const result = await client.query<{ same: boolean }>(
      `SELECT ${sameSeatContestKeySql("$1::text", "$2::text", "$3::text")} AS same`,
      [primaryKey, laterKey, districtName]
    );
    return result.rows[0]!.same;
  }

  it("pairs the three verified 2026-09-24 false positives", async () => {
    expect(await sameSeat("constable justice prec 2", "constable justice prec 2 pima county arizona", PIMA)).toBe(true);
    expect(
      await sameSeat("cape coral city council district 6", "city of cape coral city council district 6", CAPE_CORAL)
    ).toBe(true);
    expect(await sameSeat("county commissioner district 1", "commissioner district 1", CANYON)).toBe(true);
  });

  it("strips suffix and prefix down to the same contest key", async () => {
    expect(await contestKey("constable justice prec 2 pima county arizona", PIMA)).toBe("constable justice prec 2");
    expect(await contestKey("constable justice prec 2 pima county", PIMA)).toBe("constable justice prec 2");
    expect(await contestKey("city of cape coral city council district 6", CAPE_CORAL)).toBe("city council district 6");
    expect(await contestKey("cape coral city council district 6", CAPE_CORAL)).toBe("city council district 6");
    expect(await contestKey("county commissioner district 1", CANYON)).toBe("commissioner district 1");
  });

  it("keeps sibling seats apart", async () => {
    expect(await sameSeat("constable justice prec 2", "constable justice prec 3 pima county arizona", PIMA)).toBe(false);
    expect(
      await sameSeat("cape coral city council district 6", "city of cape coral city council district 1", CAPE_CORAL)
    ).toBe(false);
    expect(await sameSeat("county commissioner district 1", "commissioner district 2", CANYON)).toBe(false);
  });

  it("does not vouch for seatless titles or strip a title down to nothing", async () => {
    expect(await sameSeat("county commissioner", "commissioner", CANYON)).toBe(false);
    expect(await contestKey("pima", PIMA)).toBe("pima");
    expect(await contestKey("county", CANYON)).toBe("county");
  });
});
