import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { upsertAlaskaFinanceLink } from "../../../src/pipeline/alaskaFinance/alaskaFinanceWriter.js";
import { upsertCaliforniaFinanceLink } from "../../../src/pipeline/californiaFinance/californiaFinanceWriter.js";
import { upsertColoradoFinanceLink } from "../../../src/pipeline/coloradoFinance/coloradoFinanceWriter.js";
import { upsertConnecticutFinanceLink } from "../../../src/pipeline/connecticutFinance/connecticutFinanceWriter.js";
import { upsertFloridaFinanceLink } from "../../../src/pipeline/floridaFinance/floridaFinanceWriter.js";
import { upsertHawaiiFinanceLink } from "../../../src/pipeline/hawaiiFinance/hawaiiFinanceWriter.js";
import { upsertIllinoisFinanceLink } from "../../../src/pipeline/illinoisFinance/illinoisFinanceWriter.js";
import { upsertIndianaFinanceLink } from "../../../src/pipeline/indianaFinance/indianaFinanceWriter.js";
import { upsertKentuckyFinanceLink } from "../../../src/pipeline/kentuckyFinance/kentuckyFinanceWriter.js";
import { upsertLouisianaFinanceLink } from "../../../src/pipeline/louisianaFinance/louisianaFinanceWriter.js";
import { upsertMassachusettsFinanceLink } from "../../../src/pipeline/massachusettsFinance/massachusettsFinanceWriter.js";
import { upsertMichiganFinanceLink } from "../../../src/pipeline/michiganFinance/michiganFinanceWriter.js";
import { upsertMinnesotaFinanceLink } from "../../../src/pipeline/minnesotaFinance/minnesotaFinanceWriter.js";
import { upsertNebraskaFinanceLink } from "../../../src/pipeline/nebraskaFinance/nebraskaFinanceWriter.js";
import { upsertNewJerseyFinanceLink } from "../../../src/pipeline/newJerseyFinance/newJerseyFinanceWriter.js";
import { upsertNewMexicoFinanceLink } from "../../../src/pipeline/newMexicoFinance/newMexicoFinanceWriter.js";
import { upsertNewYorkFinanceLink } from "../../../src/pipeline/newYorkFinance/newYorkFinanceWriter.js";
import { upsertNewYorkCityFinanceLink } from "../../../src/pipeline/newYorkCityFinance/newYorkCityFinanceWriter.js";
import { upsertOklahomaFinanceLink } from "../../../src/pipeline/oklahomaFinance/oklahomaFinanceWriter.js";
import { upsertPennsylvaniaFinanceLink } from "../../../src/pipeline/pennsylvaniaFinance/pennsylvaniaFinanceWriter.js";
import { upsertTennesseeFinanceLink } from "../../../src/pipeline/tennesseeFinance/tennesseeFinanceWriter.js";
import { upsertTexasFinanceLink } from "../../../src/pipeline/texasFinance/texasFinanceWriter.js";
import { upsertUtahFinanceLink } from "../../../src/pipeline/utahFinance/utahFinanceWriter.js";
import { upsertVermontFinanceLink } from "../../../src/pipeline/vermontFinance/vermontFinanceWriter.js";
import { upsertVirginiaFinanceLink } from "../../../src/pipeline/virginiaFinance/virginiaFinanceWriter.js";
import { upsertWashingtonFinanceLink } from "../../../src/pipeline/washingtonFinance/washingtonFinanceWriter.js";
import { upsertWisconsinFinanceLink } from "../../../src/pipeline/wisconsinFinance/wisconsinFinanceWriter.js";

/**
 * Live round-trip for same-identity manual-link protection (`M`) across
 * every bespoke finance writer plus the shared factory (through the Texas
 * wrapper). The rule under test is row-level Postgres behaviour — what an
 * `ON CONFLICT … DO UPDATE` CASE actually leaves in the row, and whether a
 * pre-INSERT "retire other identities" UPDATE touched an operator's row —
 * which ordered query mocks cannot show.
 *
 * Needs a live Postgres (DATABASE_URL) with migrations applied. CI runs it in
 * the migrate job, which provides one; the unit-test job skips it.
 */

const databaseUrl = process.env.DATABASE_URL;

type Queryable = Pick<Pool, "query">;

/** One writer under test: how to write a link with a given status/source
 * for identity A or B, and which table to read back. */
type WriterCase = {
  name: string;
  table: string;
  automaticSource: string;
  /** Writers whose input carries no linkStatus (NYC) skip the manual
   * deactivate-via-writer case; the row is disabled with SQL instead. */
  statusInput: boolean;
  /** Writers that retire other active identities before inserting an
   * active one (single-active partial unique index). */
  retiresOthers: boolean;
  upsert: (
    db: Queryable,
    ids: { candidateId: string; electionId: string },
    identity: "A" | "B",
    linkSource: string,
    linkStatus: "active" | "inactive",
    electionYear?: number
  ) => Promise<{ linkId: string }>;
};

const NOW = new Date("2026-09-06T00:00:00.000Z");

function base(ids: { candidateId: string; electionId: string }) {
  return {
    candidateId: ids.candidateId,
    electionId: ids.electionId,
    electionYear: 2026,
    candidateNameNormalized: "MANUAL PROTECTION",
    officeName: "Governor",
    district: null,
    sourceUrl: null,
    lastVerifiedAt: NOW,
  };
}

function simple(
  name: string,
  table: string,
  automaticSource: string,
  fn: (input: { db: Queryable; link: never }) => Promise<{ linkId: string }>,
  identityFields: (identity: "A" | "B") => Record<string, unknown>,
  options: { retiresOthers?: boolean } = {}
): WriterCase {
  return {
    name,
    table,
    automaticSource,
    statusInput: true,
    retiresOthers: options.retiresOthers ?? false,
    upsert: (db, ids, identity, linkSource, linkStatus, electionYear) =>
      fn({
        db,
        link: {
          ...base(ids),
          ...identityFields(identity),
          linkSource,
          linkStatus,
          ...(electionYear === undefined ? {} : { electionYear }),
        } as never,
      }),
  };
}

const WRITERS: WriterCase[] = [
  simple("alaska", "ak_candidate_finance_links", "apoc_csv", upsertAlaskaFinanceLink as never, (i) => ({
    candidateFilerId: `AK-${i}`,
    candidateFilerName: `Filer ${i}`,
  })),
  simple("california", "ca_candidate_finance_links", "cal_access", upsertCaliforniaFinanceLink as never, (i) => ({
    controlledCommitteeId: `CA-${i}`,
    controlledCommitteeName: `Committee ${i}`,
  })),
  simple("colorado", "co_candidate_finance_links", "tracer_bulk", upsertColoradoFinanceLink as never, (i) => ({
    committeeId: `CO-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("connecticut", "ct_candidate_finance_links", "ecris_bulk", upsertConnecticutFinanceLink as never, (i) => ({
    committeeId: `CT-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("florida", "fl_candidate_finance_links", "dos_export", upsertFloridaFinanceLink as never, (i) => ({
    committeeId: `FL-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("hawaii", "hi_candidate_finance_links", "csc_api", upsertHawaiiFinanceLink as never, (i) => ({
    committeeId: `HI-${i}`,
    committeeName: `Committee ${i}`,
    electionPeriod: "2024-2026",
  })),
  simple("illinois", "il_candidate_finance_links", "illinois_sbe", upsertIllinoisFinanceLink as never, (i) => ({
    committeeKey: `IL-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("indiana", "in_candidate_finance_links", "public_bulk", upsertIndianaFinanceLink as never, (i) => ({
    committeeId: `IN-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("kentucky", "ky_candidate_finance_links", "kref_public_search", upsertKentuckyFinanceLink as never, (i) => ({
    candidateKey: "KY-CAND",
    committeeKey: `KY-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple(
    "louisiana",
    "la_candidate_finance_links",
    "la_ethics_search",
    upsertLouisianaFinanceLink as never,
    (i) => ({ filerNumber: `LA-${i}`, filerName: `Filer ${i}` }),
    { retiresOthers: true }
  ),
  simple("massachusetts", "ma_candidate_finance_links", "ocpf_api", upsertMassachusettsFinanceLink as never, (i) => ({
    candidateCpfId: `MA-${i}`,
    filerName: `Filer ${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("michigan", "mi_candidate_finance_links", "mitn_public_search", upsertMichiganFinanceLink as never, (i) => ({
    committeeId: `MI-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("minnesota", "mn_candidate_finance_links", "mn_board", upsertMinnesotaFinanceLink as never, (i) => ({
    committeeId: `MN-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("nebraska", "ne_candidate_finance_links", "nadc_bulk", upsertNebraskaFinanceLink as never, (i) => ({
    committeeId: `NE-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("newJersey", "nj_candidate_finance_links", "elec_api", upsertNewJerseyFinanceLink as never, (i) => ({
    candidateEntityS: i === "A" ? 1001 : 1002,
    entityName: `Entity ${i}`,
  })),
  simple("newMexico", "nm_candidate_finance_links", "cfis_bulk", upsertNewMexicoFinanceLink as never, (i) => ({
    committeeId: `NM-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple(
    "newYork",
    "ny_candidate_finance_links",
    "ny_soda_api",
    upsertNewYorkFinanceLink as never,
    (i) => ({ filerId: `NY-${i}`, filerName: `Filer ${i}` }),
    { retiresOthers: true }
  ),
  simple("oklahoma", "ok_candidate_finance_links", "guardian_bulk", upsertOklahomaFinanceLink as never, (i) => ({
    committeeId: `OK-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("pennsylvania", "pa_candidate_finance_links", "pa_bulk", upsertPennsylvaniaFinanceLink as never, (i) => ({
    filerId: `PA-${i}`,
    filerName: `Filer ${i}`,
  })),
  simple("tennessee", "tn_candidate_finance_links", "tncamp_search", upsertTennesseeFinanceLink as never, (i) => ({
    campCandidateId: i === "A" ? "1001" : "1002",
    ownerName: `Owner ${i}`,
  })),
  simple("texas (factory)", "tx_candidate_finance_links", "tec_bulk", upsertTexasFinanceLink as never, (i) => ({
    committeeId: `TX-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("utah", "ut_candidate_finance_links", "disclosures_advanced_search", upsertUtahFinanceLink as never, (i) => ({
    folderId: `UT-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("vermont", "vt_candidate_finance_links", "vermont_public_transactions", upsertVermontFinanceLink as never, (i) => ({
    filerRegistrationGuid: `VT-${i}`,
    filerName: `Filer ${i}`,
  })),
  simple("virginia", "va_candidate_finance_links", "cfreports_xml", upsertVirginiaFinanceLink as never, (i) => ({
    committeeId: `VA-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("washington", "wa_candidate_finance_links", "pdc_api", upsertWashingtonFinanceLink as never, (i) => ({
    filerId: `WA-F-${i}`,
    committeeId: `WA-${i}`,
    committeeName: `Committee ${i}`,
  })),
  simple("wisconsin", "wi_candidate_finance_links", "sunshine_api", upsertWisconsinFinanceLink as never, (i) => ({
    entityId: `WI-${i}`,
    committeeId: `WI-C-${i}`,
    committeeName: `Committee ${i}`,
  })),
  {
    name: "newYorkCity",
    table: "nyc_candidate_finance_links",
    automaticSource: "cfb_csv",
    statusInput: false,
    retiresOthers: true,
    upsert: async (db, ids, identity, linkSource, _linkStatus, electionYear) => ({
      linkId: await upsertNewYorkCityFinanceLink({
        db,
        link: {
          candidateId: ids.candidateId,
          electionId: ids.electionId,
          electionYear: electionYear ?? 2026,
          candidateNameNormalized: "MANUAL PROTECTION",
          officeCode: "1",
          boroughCode: null,
          cfbCandidateId: `NYC-${identity}`,
          cfbCandidateName: `Candidate ${identity}`,
          linkSource: linkSource as "manual" | "cfb_csv",
          sourceUrl: null,
          lastVerifiedAt: NOW,
        },
      }),
    }),
  },
];

const FIXTURE_EMAIL_TAG = "manual-link-protection";

describe.skipIf(!databaseUrl)("finance manual-link protection across writers (requires DATABASE_URL)", () => {
  let pool: Pool;
  let ids: { candidateId: string; electionId: string; districtId: string };

  async function readRows(table: string): Promise<Array<{ id: string; link_status: string; link_source: string }>> {
    const result = await pool.query<{ id: string; link_status: string; link_source: string }>(
      `SELECT id::text AS id, link_status, link_source FROM public.${table}
       WHERE candidate_id = $1::uuid AND election_id = $2::uuid ORDER BY created_at, id`,
      [ids.candidateId, ids.electionId]
    );
    return result.rows;
  }

  async function disableBySql(table: string, linkId: string): Promise<void> {
    await pool.query(`UPDATE public.${table} SET link_status = 'inactive' WHERE id = $1::uuid`, [linkId]);
  }

  async function clearLinks(): Promise<void> {
    for (const w of WRITERS) {
      await pool.query(`DELETE FROM public.${w.table} WHERE candidate_id = $1::uuid`, [ids.candidateId]);
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    // Leftovers from an interrupted run: the fixture rows cascade to links.
    await pool.query("DELETE FROM public.candidates WHERE last_name = $1", [FIXTURE_EMAIL_TAG]);
    await pool.query("DELETE FROM public.districts WHERE geoid_compact = $1", [FIXTURE_EMAIL_TAG]);
    const district = await pool.query<{ id: string }>(
      `INSERT INTO public.districts (geoid_compact, name, state, state_fips, district_type, population)
       VALUES ($1, 'Manual protection fixture', 'TX', '48', 'statewide', 1) RETURNING id::text AS id`,
      [FIXTURE_EMAIL_TAG]
    );
    const districtId = district.rows[0]!.id;
    const election = await pool.query<{ id: string }>(
      `INSERT INTO public.elections (district_id, official_ballot_title, official_ballot_title_key, election_date, sources, race_type)
       VALUES ($1::uuid, 'Manual protection fixture', 'manual-protection-fixture', '2026-11-03', '["test"]'::jsonb, 'office')
       RETURNING id::text AS id`,
      [districtId]
    );
    const candidate = await pool.query<{ id: string }>(
      `INSERT INTO public.candidates (first_name, last_name, party, state) VALUES ('Fixture', $1, 'Nonpartisan', 'TX')
       RETURNING id::text AS id`,
      [FIXTURE_EMAIL_TAG]
    );
    ids = { candidateId: candidate.rows[0]!.id, electionId: election.rows[0]!.id, districtId };
  });

  afterEach(async () => {
    await clearLinks();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM public.candidates WHERE id = $1::uuid", [ids.candidateId]);
    await pool.query("DELETE FROM public.elections WHERE id = $1::uuid", [ids.electionId]);
    await pool.query("DELETE FROM public.districts WHERE id = $1::uuid", [ids.districtId]);
    await pool.end();
  });

  for (const w of WRITERS) {
    describe(w.name, () => {
      it("automation cannot reactivate or reclassify an operator-disabled manual link", async () => {
        const { linkId } = await w.upsert(pool, ids, "A", "manual", "active");
        await disableBySql(w.table, linkId);

        await expect(w.upsert(pool, ids, "A", w.automaticSource, "active")).rejects.toThrow(
          "automatic finance link matches an operator-disabled manual link"
        );

        expect(await readRows(w.table)).toEqual([{ id: linkId, link_status: "inactive", link_source: "manual" }]);
      });

      it("automation reuses an active manual link without changing its status or source", async () => {
        const { linkId } = await w.upsert(pool, ids, "A", "manual", "active");

        await expect(w.upsert(pool, ids, "A", w.automaticSource, "active")).resolves.toEqual({ linkId });

        expect(await readRows(w.table)).toEqual([{ id: linkId, link_status: "active", link_source: "manual" }]);
      });

      it("automation with a different election year cannot relabel a manual link", async () => {
        const { linkId } = await w.upsert(pool, ids, "A", "manual", "active");

        // The snapshot tables reference (link id, election_year) with ON
        // UPDATE CASCADE: a refreshed year would relabel the operator's
        // existing summaries and breakdowns as another cycle's.
        await expect(w.upsert(pool, ids, "A", w.automaticSource, "active", 2028)).rejects.toThrow(
          "automatic finance link year 2028 does not match the protected manual link year 2026"
        );

        const year = await pool.query<{ election_year: number }>(
          `SELECT election_year FROM public.${w.table} WHERE id = $1::uuid`,
          [linkId]
        );
        expect(year.rows).toEqual([{ election_year: 2026 }]);
      });

      if (w.statusInput) {
        it("a deliberate manual write changes status in both directions", async () => {
          const { linkId } = await w.upsert(pool, ids, "A", "manual", "active");

          await w.upsert(pool, ids, "A", "manual", "inactive");
          expect(await readRows(w.table)).toEqual([{ id: linkId, link_status: "inactive", link_source: "manual" }]);

          await w.upsert(pool, ids, "A", "manual", "active");
          expect(await readRows(w.table)).toEqual([{ id: linkId, link_status: "active", link_source: "manual" }]);
        });
      }

      if (w.retiresOthers) {
        it("automation with a different identity cannot retire an active manual link", async () => {
          const { linkId } = await w.upsert(pool, ids, "A", "manual", "active");

          // The single-active index rejects the second active row; either
          // way the operator's link must still be active afterwards.
          await w.upsert(pool, ids, "B", w.automaticSource, "active").catch(() => undefined);

          const rows = await readRows(w.table);
          expect(rows.find((row) => row.id === linkId)).toEqual({
            id: linkId,
            link_status: "active",
            link_source: "manual",
          });
          expect(rows.filter((row) => row.link_status === "active")).toHaveLength(1);
        });

        it("rejecting an operator-disabled replacement leaves the candidate's other active link alone", async () => {
          const { linkId: rejected } = await w.upsert(pool, ids, "B", "manual", "active");
          await disableBySql(w.table, rejected);
          const { linkId: working } = await w.upsert(pool, ids, "A", w.automaticSource, "active");

          // Automation proposes the disabled identity: the retirement of A it
          // performs first must roll back with the rejection.
          await expect(w.upsert(pool, ids, "B", w.automaticSource, "active")).rejects.toThrow(
            "automatic finance link matches an operator-disabled manual link"
          );

          expect(await readRows(w.table)).toEqual([
            { id: rejected, link_status: "inactive", link_source: "manual" },
            { id: working, link_status: "active", link_source: w.automaticSource },
          ]);
        });
      }
    });
  }
});
