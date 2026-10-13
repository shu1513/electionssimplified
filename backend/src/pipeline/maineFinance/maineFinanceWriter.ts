import type { Pool, PoolClient } from "pg";

import {
  createStandardStateFinanceSnapshotWriter,
  type StandardStateFinanceDirectBreakdownInput,
  type StandardStateFinanceDirectCategoryType,
  type StandardStateFinanceLinkInput,
  type StandardStateFinanceLinkStatus,
  type StandardStateFinanceOutsideCategoryType,
  type StandardStateFinanceOutsideGroupBreakdownInput,
  type StandardStateFinanceOutsideGroupInput,
  type StandardStateFinanceSnapshotWriteResult,
  type StandardStateFinanceSummaryInput,
  type StandardStateFinanceSupportOppose,
} from "../finance/standardStateFinanceSnapshotWriter.js";
import { qualifyMaineMapLightBallotContext } from "./maineMapLightBallotContext.js";
import type { MaineMapLightCommitteeDonorPosition } from "./maineMapLightFinancialFacts.js";
import type { MaineMapLightIndependentExpenditureAllocation } from "./maineMapLightIndependentExpenditureCsv.js";
import {
  parseMaineMapLightCivilDate,
  parseMaineMapLightSourceId,
  parseMaineMapLightCents,
} from "./maineMapLightCsvPrimitives.js";
import { isMaineFinanceEligibleOffice } from "./maineFinanceEligibleOffices.js";
import type { FinanceLabelClassification } from "../finance/financeLabelClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type ConnectableQueryable = Queryable & {
  connect: () => Promise<PoolClient>;
};

export type MaineFinanceLinkStatus = StandardStateFinanceLinkStatus;
export type MaineFinanceLinkSource = "manual" | "cfis_bulk";
export type MaineFinanceDirectCategoryType =
  StandardStateFinanceDirectCategoryType;
export type MaineFinanceOutsideCategoryType =
  StandardStateFinanceOutsideCategoryType;
export type MaineFinanceSupportOppose = StandardStateFinanceSupportOppose;

export type MaineFinanceLinkInput = Omit<
  StandardStateFinanceLinkInput,
  "linkSource"
> & {
  linkSource?: MaineFinanceLinkSource;
};

export type MaineFinanceSummaryInput = StandardStateFinanceSummaryInput;
export type MaineFinanceDirectBreakdownInput =
  StandardStateFinanceDirectBreakdownInput;
export type MaineFinanceOutsideGroupInput =
  StandardStateFinanceOutsideGroupInput;
export type MaineFinanceOutsideGroupBreakdownInput =
  StandardStateFinanceOutsideGroupBreakdownInput;

export interface MaineMapLightFinanceSourceInput {
  linkId: string;
  electionDate: string;
  sourceCalendarYear: number;
  periodStart: string;
  periodEnd: string;
  observedAt: Date;
  captureDigest: string;
  sourceUrl: string;
  sourceFilerId: string;
  sourceFilerName: string;
  sourceOffice: "Senator" | "Representative" | "Governor";
  sourceDistrict: string | null;
  publishedSourceTimes?: { allFiler: string; independentExpenditures: string };
  /** Retains the unique official ballot qualification made during source acquisition. */
  qualifiedBallotContext?: NonNullable<
    ReturnType<typeof qualifyMaineMapLightBallotContext>["context"]
  >;
}

export type MaineFinanceSnapshotInput = {
  db: ConnectableQueryable;
  link: MaineFinanceLinkInput;
  syncedAt?: Date;
  summary?: MaineFinanceSummaryInput;
  directBreakdowns?: readonly MaineFinanceDirectBreakdownInput[];
  outsideGroups?: readonly MaineFinanceOutsideGroupInput[];
  outsideGroupBreakdowns?: readonly MaineFinanceOutsideGroupBreakdownInput[];
  classifications?: readonly FinanceLabelClassification[];
  mapLightSource?: MaineMapLightFinanceSourceInput;
  mapLightCommitteeDonors?: readonly MaineMapLightCommitteeDonorPosition[];
  mapLightOutsideAllocations?: readonly MaineMapLightIndependentExpenditureAllocation[];
};

export type MaineFinanceSnapshotWriteResult =
  StandardStateFinanceSnapshotWriteResult & {
    mapLightCommitteeDonorsWritten?: number;
    mapLightOutsideAllocationsWritten?: number;
  };

function normalizeMaineCommitteeId(value: string): string {
  return value.replace(/\s+/g, " ").toUpperCase();
}

const writer = createStandardStateFinanceSnapshotWriter({
  label: "Maine",
  minElectionYear: 2000,
  // Maine replaces every summary column except the outside totals, which keep
  // the stored value when the incoming value is NULL so a partial refresh
  // without expenditure data does not wipe them (preserveWhenNull default).
  summaryUpdatePolicy: {
    total_receipts: "replace",
    direct_contribution_total: "replace",
    total_disbursements: "replace",
    cash_on_hand: "replace",
    source_url: "replace",
  },
  outsideGroupValidation: "pairing",
  normalizeCommitteeId: normalizeMaineCommitteeId,
  supersededLinkSource: "cfis_bulk",
  tables: {
    links: "me_candidate_finance_links",
    summaries: "me_candidate_finance_summaries",
    directBreakdowns: "me_candidate_finance_direct_breakdowns",
    outsideGroups: "me_candidate_finance_outside_groups",
    outsideGroupBreakdowns: "me_candidate_finance_outside_group_breakdowns",
  },
});

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Maine finance election year: ${value}`);
  }
  return value;
}

function validateNullableDate(value: Date | null | undefined): void {
  if (value && Number.isNaN(value.getTime())) {
    throw new Error("Invalid Maine finance timestamp");
  }
}

function validateMaineFinanceLinkInput(link: MaineFinanceLinkInput): void {
  requireNonEmpty(link.candidateId, "candidate id");
  requireNonEmpty(link.electionId, "election id");
  normalizeElectionYear(link.electionYear);
  requireNonEmpty(link.candidateNameNormalized, "Maine finance candidate name");
  requireNonEmpty(link.officeName, "Maine finance office name");
  requireNonEmpty(link.committeeId, "Maine committee id");
  requireNonEmpty(link.committeeName, "Maine committee name");
  validateNullableDate(link.lastVerifiedAt);
}

function outsideGroupKey(
  group: Pick<MaineFinanceOutsideGroupInput, "committeeId" | "supportOppose">,
): string {
  return `${normalizeMaineCommitteeId(requireNonEmpty(group.committeeId, "Maine committee id"))}\u0000${group.supportOppose}`;
}

// The factory's pairing validation covers the same inputs, but Maine's
// original writer phrased its errors differently ("require matching outside
// groups...") and rejected a defined-but-empty breakdown list with no groups
// key at all. Per-state tests pin both behaviors, so the wrapper validates
// first with the legacy semantics; the factory's own pairing check then acts
// as a backstop and never fires on input that passes here.
function validateMaineFinanceSnapshotInput(
  input: MaineFinanceSnapshotInput,
): void {
  validateMaineFinanceLinkInput(input.link);
  if (input.outsideGroupBreakdowns && !input.outsideGroups) {
    throw new Error(
      "Maine outside group breakdowns require outside groups in the same snapshot",
    );
  }
  if (input.outsideGroupBreakdowns?.length) {
    const groupKeys = new Set((input.outsideGroups ?? []).map(outsideGroupKey));
    for (const breakdown of input.outsideGroupBreakdowns) {
      if (!groupKeys.has(outsideGroupKey(breakdown))) {
        throw new Error(
          "Maine outside group breakdowns require matching outside groups in the same snapshot",
        );
      }
    }
  }
}

// Maine snapshot writes must receive a Pool: a bare queryable without
// connect() is rejected instead of taking the factory's inline-transaction
// path. The stub throws on first use rather than up front so that input
// validation errors still surface before the transaction-contract error.
function requireMainePool(db: Queryable): Queryable {
  const candidate = db as { connect?: unknown; release?: unknown };
  if (
    typeof candidate.connect === "function" ||
    typeof candidate.release === "function"
  ) {
    return db;
  }
  const rejectQuery = () => {
    throw new Error("Maine finance snapshot writes must receive a Pool");
  };
  return { query: rejectQuery as unknown as Queryable["query"] };
}

export async function upsertMaineFinanceLink(input: {
  db: Queryable;
  link: MaineFinanceLinkInput;
}): Promise<{ linkId: string }> {
  return writer.upsertLink(input);
}

type MapLightComponent = "committee_donors" | "independent_expenditures";
function mapLightError(reason: string): never {
  throw new Error(`Maine MapLight write: ${reason}`);
}
function reportedNameKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
}
function exactMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) mapLightError("invalid exact-cent amount");
  const magnitude = BigInt(Math.abs(cents));
  return `${cents < 0 ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}
function dateString(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    mapLightError("invalid stored timestamp");
  return parsed.toISOString();
}
function numericSeat(value: string | null | undefined): string | null {
  return typeof value === "string" &&
    /^\d{1,3}$/.test(value) &&
    Number(value) > 0
    ? String(Number(value))
    : null;
}
function publicSourceUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    mapLightError("invalid public source URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ![
      "maine-disclosure-system.refined.site",
      "www.mainecampaignfinancedisclosure.com",
    ].includes(url.hostname)
  )
    mapLightError("invalid public source URL");
}
function validatePublisherTimes(value: {
  allFiler: string;
  independentExpenditures: string;
}): void {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "allFiler,independentExpenditures"
  )
    mapLightError("invalid publisher walltimes");
  for (const time of [value.allFiler, value.independentExpenditures]) {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) ET$/.exec(time);
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59)
      mapLightError("invalid publisher walltimes");
    parseMaineMapLightCivilDate(match[1], mapLightError);
  }
}

function prepareMapLight(input: MaineFinanceSnapshotInput) {
  const defined =
    input.mapLightCommitteeDonors !== undefined ||
    input.mapLightOutsideAllocations !== undefined;
  if (!defined && input.mapLightSource === undefined) return undefined;
  if (!defined || !input.mapLightSource)
    mapLightError("source and accepted component must be paired");
  if (
    [
      input.summary,
      input.directBreakdowns,
      input.outsideGroups,
      input.outsideGroupBreakdowns,
      input.classifications,
    ].some((value) => value !== undefined)
  )
    mapLightError("source-only snapshot must omit legacy finance components");
  const original = input.mapLightSource;
  if (
    !(original.observedAt instanceof Date) ||
    !Number.isFinite(original.observedAt.getTime())
  )
    mapLightError("invalid source observation timestamp");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      original.linkId,
    )
  )
    mapLightError("invalid existing link ID");
  if (
    !Number.isInteger(original.sourceCalendarYear) ||
    original.sourceCalendarYear < input.link.electionYear - 1 ||
    original.sourceCalendarYear > input.link.electionYear
  )
    mapLightError("invalid source calendar scope");
  for (const date of [
    original.periodStart,
    original.periodEnd,
    original.electionDate,
  ])
    parseMaineMapLightCivilDate(date, mapLightError);
  if (
    original.periodStart > original.periodEnd ||
    !original.periodStart.startsWith(`${original.sourceCalendarYear}-`) ||
    !original.periodEnd.startsWith(`${original.sourceCalendarYear}-`) ||
    !original.electionDate.startsWith(`${input.link.electionYear}-`) ||
    original.periodEnd > original.observedAt.toISOString().slice(0, 10)
  )
    mapLightError("invalid source period");
  if (!/^[0-9a-f]{64}$/.test(original.captureDigest))
    mapLightError("invalid source capture digest");
  publicSourceUrl(original.sourceUrl);
  parseMaineMapLightSourceId(original.sourceFilerId, "f", mapLightError);
  if (
    !original.sourceFilerName.trim() ||
    !["Senator", "Representative", "Governor"].includes(
      original.sourceOffice,
    ) ||
    (original.sourceOffice === "Governor"
      ? original.sourceDistrict !== null
      : numericSeat(original.sourceDistrict) === null)
  )
    mapLightError("invalid source filer context");
  if (
    input.link.linkStatus !== "active" ||
    input.link.linkSource === undefined ||
    !("sourceUrl" in input.link) ||
    !("lastVerifiedAt" in input.link) ||
    input.link.lastVerifiedAt === undefined
  )
    mapLightError("original active link fields required");
  if (original.publishedSourceTimes)
    validatePublisherTimes(original.publishedSourceTimes);
  let qualifiedBallotContext: MaineMapLightFinanceSourceInput["qualifiedBallotContext"];
  if (original.qualifiedBallotContext !== undefined) {
    const context = original.qualifiedBallotContext;
    if (!context || context.version !== 1 || !context.ballot)
      mapLightError("invalid official ballot qualification");
    qualifiedBallotContext = qualifyMaineMapLightBallotContext({
      rows: [context.ballot],
      candidate: context.candidate,
      source: context.source,
    }).context;
    if (
      !qualifiedBallotContext ||
      qualifiedBallotContext.source.filerId !== original.sourceFilerId ||
      qualifiedBallotContext.source.filerName !== original.sourceFilerName ||
      qualifiedBallotContext.source.office !== original.sourceOffice ||
      qualifiedBallotContext.source.district !== original.sourceDistrict ||
      qualifiedBallotContext.candidate.electionYear !== input.link.electionYear ||
      qualifiedBallotContext.candidate.electionDate !== original.electionDate
    )
      mapLightError("official ballot qualification does not match source");
  }
  const source = {
    ...original,
    qualifiedBallotContext,
    observedAt: new Date(original.observedAt),
    publishedSourceTimes: original.publishedSourceTimes
      ? { ...original.publishedSourceTimes }
      : undefined,
  };
  const donors = input.mapLightCommitteeDonors?.map((row) => ({
    ...row,
    giftTransactionIds: [...row.giftTransactionIds],
    returnedTransactionIds: [...row.returnedTransactionIds],
  }));
  const donorKeys = new Set<string>(),
    receiptIds = new Set<string>();
  for (const donor of donors ?? []) {
    if (
      !donor.committeeName.trim() ||
      donor.committeeId !==
        `reported:${reportedNameKey(donor.committeeName)}` ||
      donorKeys.has(donor.committeeId) ||
      !["political_action_committee", "political_party_committee"].includes(
        donor.sourceReportedClass,
      ) ||
      reportedNameKey(donor.committeeName) ===
        reportedNameKey(source.sourceFilerName)
    )
      mapLightError("invalid reported committee identity");
    donorKeys.add(donor.committeeId);
    exactMoney(donor.amountCents);
    if (
      !Number.isInteger(donor.contributionCount) ||
      donor.contributionCount < 0 ||
      donor.contributionCount > donor.giftTransactionIds.length ||
      (donor.amountCents > 0 && donor.contributionCount === 0) ||
      donor.giftTransactionIds.length + donor.returnedTransactionIds.length ===
        0 ||
      (donor.amountCents < 0 && donor.returnedTransactionIds.length === 0)
    )
      mapLightError("invalid gift/return occurrence control");
    for (const id of [
      ...donor.giftTransactionIds,
      ...donor.returnedTransactionIds,
    ]) {
      parseMaineMapLightSourceId(id, "a", mapLightError);
      if (receiptIds.has(id))
        mapLightError("conflicting receipt occurrence identity");
      receiptIds.add(id);
    }
  }
  const allocations = input.mapLightOutsideAllocations?.map((row) => ({
    ...row,
  }));
  const allocationKeys = new Set<string>(),
    transactionControls = new Map<string, string>();
  for (const row of allocations ?? []) {
    parseMaineMapLightSourceId(row.transactionId, "a", mapLightError);
    parseMaineMapLightSourceId(row.filerId, "f", mapLightError);
    parseMaineMapLightCivilDate(row.transactionDate, mapLightError);
    if (
      row.candidateId !== source.sourceFilerId ||
      row.candidateName !== source.sourceFilerName ||
      !row.filerName.trim() ||
      row.transactionType !== "independent_expenditure" ||
      !["support", "oppose"].includes(row.supportOppose) ||
      row.transactionDate < source.periodStart ||
      row.transactionDate > source.periodEnd
    )
      mapLightError("invalid allocation source target/scope");
    if (
      !Number.isSafeInteger(row.amountSpentOnCandidateCents) ||
      row.amountSpentOnCandidateCents <= 0 ||
      !Number.isSafeInteger(row.totalTransactionAmountCents) ||
      row.totalTransactionAmountCents < row.amountSpentOnCandidateCents ||
      parseMaineMapLightCents(row.amountSpentOnCandidate, mapLightError) !==
        row.amountSpentOnCandidateCents ||
      parseMaineMapLightCents(row.totalTransactionAmount, mapLightError) !==
        row.totalTransactionAmountCents
    )
      mapLightError("invalid allocation monetary control");
    const key = JSON.stringify([
      row.transactionId,
      row.candidateId,
      row.supportOppose,
    ]);
    if (allocationKeys.has(key))
      mapLightError("duplicate allocation occurrence");
    allocationKeys.add(key);
    const control = JSON.stringify([
      row.filerId,
      row.filerName,
      row.transactionDate,
      row.totalTransactionAmountCents,
    ]);
    if (
      transactionControls.has(row.transactionId) &&
      transactionControls.get(row.transactionId) !== control
    )
      mapLightError("conflicting allocation whole-transaction control");
    transactionControls.set(row.transactionId, control);
  }
  return { source, donors, allocations };
}

type LockedMapLightOwner = {
  id: string;
  candidate_id: string;
  election_id: string;
  election_year: number;
  candidate_name_normalized: string;
  office_name: string;
  district: string | null;
  committee_id: string;
  committee_name: string;
  link_status: string;
  link_source: string;
  source_url: string | null;
  last_verified_at: Date | string | null;
  candidate_name: string;
  candidate_first_name: string;
  candidate_last_name: string;
  candidate_party: string | null;
  candidate_state: string;
  candidate_deleted: boolean;
  candidate_merged: boolean;
  candidate_election_status: string;
  election_stage: string;
  race_type: string;
  election_date: string;
  district_state: string;
  district_type: string;
  geoid_compact: string;
  office_scope: string;
  office_canonical_name: string;
};
type StoredMapLightMarker = {
  component: MapLightComponent;
  period_start: string;
  period_end: string;
  observed_at: Date | string;
  capture_digest: string;
  source_filer_id: string;
  source_filer_name: string;
  source_office: string;
  source_district: string | null;
  election_date: string;
  source_url: string;
  published_source_times: {
    allFiler: string;
    independentExpenditures: string;
  } | null;
};
async function lockMapLightOwner(
  db: Queryable,
  link: MaineFinanceLinkInput,
  source: MaineMapLightFinanceSourceInput,
): Promise<void> {
  const result = await db.query<LockedMapLightOwner>(
    `
    SELECT link.id::text,link.candidate_id::text,link.election_id::text,link.election_year,
      link.candidate_name_normalized,link.office_name,link.district,link.committee_id,link.committee_name,
      link.link_status,link.link_source,link.source_url,link.last_verified_at,
      COALESCE(NULLIF(btrim(candidate.display_name),''),NULLIF(btrim(concat_ws(' ',candidate.first_name,candidate.last_name)),'')) AS candidate_name,
      candidate.first_name AS candidate_first_name,candidate.last_name AS candidate_last_name,candidate.party AS candidate_party,
      candidate.state AS candidate_state,candidate.deleted_at IS NOT NULL AS candidate_deleted,
      candidate.merged_into_candidate_id IS NOT NULL AS candidate_merged,
      candidate_election.status AS candidate_election_status,election.election_stage,election.race_type,
      election.election_date::text AS election_date,district.state AS district_state,district.district_type,
      district.geoid_compact,office.scope AS office_scope,office.canonical_name AS office_canonical_name
    FROM public.me_candidate_finance_links link
    JOIN public.candidates candidate ON candidate.id=link.candidate_id
    JOIN public.candidate_elections candidate_election ON candidate_election.candidate_id=link.candidate_id AND candidate_election.election_id=link.election_id
    JOIN public.elections election ON election.id=link.election_id
    JOIN public.districts district ON district.id=election.district_id
    JOIN public.offices office ON office.id=election.office_id
    WHERE link.link_status='active' AND ((link.candidate_id=$1::uuid AND link.election_id=$2::uuid)
      OR (link.committee_id=$3 AND link.election_year=$4::integer AND link.candidate_id<>$1::uuid))
    ORDER BY link.id FOR UPDATE OF link,candidate,candidate_election,election,district,office`,
    [link.candidateId, link.electionId, link.committeeId, link.electionYear],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.id !== source.linkId ||
    row.candidate_id !== link.candidateId ||
    row.election_id !== link.electionId ||
    row.election_year !== link.electionYear ||
    row.link_status !== "active" ||
    row.candidate_deleted ||
    row.candidate_merged ||
    row.candidate_state !== "ME" ||
    row.district_state !== "ME" ||
    row.candidate_election_status !== "declared" ||
    row.election_stage !== "general" ||
    row.race_type !== "office" ||
    row.election_date !== source.electionDate ||
    !isMaineFinanceEligibleOffice({
      officeScope: row.office_scope,
      officeCanonicalName: row.office_canonical_name,
    }) ||
    reportedNameKey(row.candidate_name ?? "") !==
      reportedNameKey(link.candidateNameNormalized) ||
    (source.qualifiedBallotContext === undefined &&
      reportedNameKey(row.candidate_name ?? "") !==
        reportedNameKey(source.sourceFilerName))
  )
    mapLightError("canonical source owner unavailable or ambiguous");
  const qualified = source.qualifiedBallotContext?.candidate;
  if (qualified) {
    const qualifiedName = [
      qualified.firstName,
      qualified.middleName,
      qualified.lastName,
      qualified.suffix,
    ].filter(Boolean).join(" ");
    if (
      row.candidate_first_name !== qualified.firstName ||
      row.candidate_last_name !== qualified.lastName ||
      row.candidate_party !== (qualified.party ?? null) ||
      reportedNameKey(row.candidate_name ?? "") !==
        reportedNameKey(qualifiedName) ||
      row.office_scope !== qualified.officeScope ||
      row.office_canonical_name !== qualified.officeName ||
      numericSeat(row.district) !== numericSeat(qualified.district)
    )
      mapLightError("qualified candidate changed before write");
  }
  const office =
    row.office_scope === "state_upper"
      ? "Senator"
      : row.office_scope === "state_lower"
        ? "Representative"
        : "Governor";
  const legislative =
    row.office_scope === "state_upper" || row.office_scope === "state_lower";
  if (
    source.sourceOffice !== office ||
    (legislative
      ? row.district_type !== row.office_scope ||
        !/^23\d{3}$/.test(row.geoid_compact) ||
        numericSeat(row.geoid_compact.slice(2)) !==
          numericSeat(source.sourceDistrict) ||
        numericSeat(link.district) !== numericSeat(source.sourceDistrict)
      : row.district_type !== "statewide" ||
        row.geoid_compact !== "23" ||
        source.sourceDistrict !== null)
  )
    mapLightError("canonical source office/seat mismatch");
  if (
    row.candidate_name_normalized !== link.candidateNameNormalized ||
    row.office_name !== link.officeName ||
    row.district !== (link.district ?? null) ||
    row.committee_id !== link.committeeId ||
    row.committee_name !== link.committeeName ||
    row.link_source !== link.linkSource ||
    row.source_url !== (link.sourceUrl ?? null) ||
    dateString(row.last_verified_at) !== dateString(link.lastVerifiedAt ?? null)
  )
    mapLightError("original receiving link changed");
}
async function checkMapLightMarkers(
  db: Queryable,
  source: MaineMapLightFinanceSourceInput,
  electionYear: number,
  components: readonly MapLightComponent[],
): Promise<void> {
  const existing = await db.query<StoredMapLightMarker>(
    `SELECT component,period_start::text,period_end::text,observed_at,capture_digest,source_filer_id,source_filer_name,source_office,source_district,election_date::text,source_url,published_source_times
    FROM public.me_candidate_finance_source_markers WHERE link_id=$1::uuid AND election_year=$2::integer AND source_calendar_year=$3::integer ORDER BY component FOR UPDATE`,
    [source.linkId, electionYear, source.sourceCalendarYear],
  );
  for (const marker of existing.rows) {
    if (
      marker.source_filer_id !== source.sourceFilerId ||
      marker.source_filer_name !== source.sourceFilerName ||
      marker.source_office !== source.sourceOffice ||
      marker.source_district !== source.sourceDistrict ||
      marker.election_date !== source.electionDate
    )
      mapLightError("stored source identity changed");
    if (!components.includes(marker.component)) continue;
    if (source.publishedSourceTimes && marker.published_source_times) {
      validatePublisherTimes(marker.published_source_times);
      if (
        source.publishedSourceTimes.allFiler <
          marker.published_source_times.allFiler ||
        source.publishedSourceTimes.independentExpenditures <
          marker.published_source_times.independentExpenditures
      )
        mapLightError("older published source snapshot");
    }
    const incomingTime = source.observedAt.getTime(),
      previousTime = Date.parse(dateString(marker.observed_at)!);
    if (
      incomingTime < previousTime ||
      source.periodStart > marker.period_start ||
      source.periodEnd < marker.period_end ||
      (incomingTime === previousTime &&
        marker.capture_digest !== source.captureDigest)
    )
      mapLightError("stale, shorter or conflicting source capture");
  }
}
async function writeMapLightMarker(
  db: Queryable,
  source: MaineMapLightFinanceSourceInput,
  electionYear: number,
  component: MapLightComponent,
): Promise<void> {
  await db.query(
    `INSERT INTO public.me_candidate_finance_source_markers(link_id,election_year,component,source_calendar_year,period_start,period_end,observed_at,capture_digest,source_url,source_filer_id,source_filer_name,source_office,source_district,election_date,published_source_times)
    VALUES($1::uuid,$2::integer,$3,$4::integer,$5::date,$6::date,$7::timestamptz,$8,$9,$10,$11,$12,$13,$14::date,$15::jsonb)
    ON CONFLICT(link_id,election_year,component,source_calendar_year) DO UPDATE SET period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,observed_at=EXCLUDED.observed_at,capture_digest=EXCLUDED.capture_digest,source_url=EXCLUDED.source_url,source_filer_id=EXCLUDED.source_filer_id,source_filer_name=EXCLUDED.source_filer_name,source_office=EXCLUDED.source_office,source_district=EXCLUDED.source_district,election_date=EXCLUDED.election_date,published_source_times=EXCLUDED.published_source_times,updated_at=now()`,
    [
      source.linkId,
      electionYear,
      component,
      source.sourceCalendarYear,
      source.periodStart,
      source.periodEnd,
      source.observedAt.toISOString(),
      source.captureDigest,
      source.sourceUrl,
      source.sourceFilerId,
      source.sourceFilerName,
      source.sourceOffice,
      source.sourceDistrict,
      source.electionDate,
      source.publishedSourceTimes
        ? JSON.stringify(source.publishedSourceTimes)
        : null,
    ],
  );
}

export async function replaceMaineCandidateFinanceSnapshot(
  input: MaineFinanceSnapshotInput,
): Promise<MaineFinanceSnapshotWriteResult> {
  const syncedAt = input.syncedAt ?? new Date();
  if (Number.isNaN(syncedAt.getTime()))
    throw new Error("Invalid Maine finance sync timestamp");
  validateMaineFinanceSnapshotInput(input);
  const prepared = prepareMapLight(input);
  if (!prepared)
    return writer.replaceSnapshot({
      ...input,
      syncedAt,
      db: requireMainePool(input.db),
    });
  const link = {
    ...input.link,
    lastVerifiedAt: input.link.lastVerifiedAt
      ? new Date(input.link.lastVerifiedAt)
      : input.link.lastVerifiedAt,
  };
  const components: MapLightComponent[] = [
    ...(prepared.donors === undefined ? [] : ["committee_donors" as const]),
    ...(prepared.allocations === undefined
      ? []
      : ["independent_expenditures" as const]),
  ];
  const result = await writer.replaceSnapshot({
    db: requireMainePool(input.db),
    link,
    syncedAt,
    beforeSnapshotWrite: async ({ db }) => {
      await lockMapLightOwner(db, link, prepared.source);
      await checkMapLightMarkers(
        db,
        prepared.source,
        link.electionYear,
        components,
      );
    },
    afterSnapshotWrite: async ({ db, linkId, electionYear }) => {
      if (linkId !== prepared.source.linkId)
        mapLightError("receiving link identity changed during write");
      for (const component of components)
        await writeMapLightMarker(db, prepared.source, electionYear, component);
      if (prepared.donors !== undefined) {
        await db.query(
          `DELETE FROM public.me_candidate_finance_pac_donors WHERE link_id=$1::uuid AND election_year=$2::integer AND source_calendar_year=$3::integer`,
          [linkId, electionYear, prepared.source.sourceCalendarYear],
        );
        for (const donor of prepared.donors)
          await db.query(
            `INSERT INTO public.me_candidate_finance_pac_donors(link_id,election_year,source_calendar_year,committee_id,committee_name,source_reported_class,amount,contribution_count,gift_transaction_ids,returned_transaction_ids,source_url) VALUES($1::uuid,$2::integer,$3::integer,$4,$5,$6,$7::numeric,$8::integer,$9::jsonb,$10::jsonb,$11)`,
            [
              linkId,
              electionYear,
              prepared.source.sourceCalendarYear,
              donor.committeeId,
              donor.committeeName,
              donor.sourceReportedClass,
              exactMoney(donor.amountCents),
              donor.contributionCount,
              JSON.stringify(donor.giftTransactionIds),
              JSON.stringify(donor.returnedTransactionIds),
              prepared.source.sourceUrl,
            ],
          );
      }
      if (prepared.allocations !== undefined) {
        await db.query(
          `DELETE FROM public.me_candidate_finance_maplight_allocations WHERE link_id=$1::uuid AND election_year=$2::integer AND source_calendar_year=$3::integer`,
          [linkId, electionYear, prepared.source.sourceCalendarYear],
        );
        for (const row of prepared.allocations)
          await db.query(
            `INSERT INTO public.me_candidate_finance_maplight_allocations(link_id,election_year,source_calendar_year,transaction_id,target_filer_id,target_name,payer_id,payer_name,support_oppose,transaction_date,amount,whole_amount,source_url) VALUES($1::uuid,$2::integer,$3::integer,$4,$5,$6,$7,$8,$9,$10::date,$11::numeric,$12::numeric,$13)`,
            [
              linkId,
              electionYear,
              prepared.source.sourceCalendarYear,
              row.transactionId,
              row.candidateId,
              row.candidateName,
              row.filerId,
              row.filerName,
              row.supportOppose,
              row.transactionDate,
              exactMoney(row.amountSpentOnCandidateCents),
              exactMoney(row.totalTransactionAmountCents),
              prepared.source.sourceUrl,
            ],
          );
      }
    },
  });
  return {
    ...result,
    mapLightCommitteeDonorsWritten: prepared.donors?.length,
    mapLightOutsideAllocationsWritten: prepared.allocations?.length,
  };
}
