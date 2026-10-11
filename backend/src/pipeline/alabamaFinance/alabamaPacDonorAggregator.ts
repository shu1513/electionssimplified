import type { AlabamaCashRow } from "./alabamaFcpaCsv.js";
import type { AlabamaCommitteeRegistryRow } from "./alabamaFcpaClient.js";

export type AlabamaFinancePacDonor = {
  /** Numeric verified public FCPA ID, or reported:<normalized source name>. */
  committeeId: string;
  committeeName: string;
  committeeType: "Political Action Committee";
  amount: number;
  contributionCount: number;
  sourceUrl: string;
};

export type AlabamaPacDonorAggregationResult = {
  /** Omitted means preserve. The caller must establish source completeness before using []. */
  pacDonors?: AlabamaFinancePacDonor[];
  diagnostics: string[];
};

const CASH_TYPES = new Set([
  "CASH (ITEMIZED)", "CASH (NON-ITEMIZED)",
  "NON-ITEMIZED EMPLOYEE PAYROLL CONTRIBUTION",
]);
const IN_KIND_TYPES = new Set(["IN-KIND (ITEMIZED)", "IN-KIND (NON-ITEMIZED)"]);
const DONOR_TYPES = new Set(["PAC", "INDIVIDUAL", "GROUP/BUSINESS/CORPORATION", "OTHER"]);
const label = (value: string): string => value.trim().toUpperCase();
const legalName = (value: string): string => value.normalize("NFKC").toUpperCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const validId = (value: string): boolean => /^[1-9]\d*$/.test(value)
  && Number.isSafeInteger(Number(value));

function isoDate(value: string): string | null {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    ?? (us ? [us[0]!, us[3]!, us[1]!, us[2]!] : null);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Pure donor aggregation; currentness, quarantine and complete native/bulk reconciliation belong to the caller. */
export function aggregateAlabamaPacDonors(input: {
  cashRows: readonly AlabamaCashRow[];
  committeeRegistryRows: readonly AlabamaCommitteeRegistryRow[];
  fcpaCommitteeNumber: string;
  windowStart: string;
  windowEnd: string;
}): AlabamaPacDonorAggregationResult {
  const unavailable = (reason: string): AlabamaPacDonorAggregationResult => ({ diagnostics: [reason] });
  const start = isoDate(input.windowStart), end = isoDate(input.windowEnd);
  if (!validId(input.fcpaCommitteeNumber) || !start || !end
    || start !== input.windowStart || end !== input.windowEnd || start > end) {
    return unavailable("Invalid Alabama PAC receiving identity or term window");
  }
  const registryByPublicId = new Map<string, string>();
  const registryByInternalId = new Map<number, string>();
  const byName = new Map<string, Map<string, AlabamaCommitteeRegistryRow>>();
  for (const row of input.committeeRegistryRows) {
    if (!validId(row.committeeId) || !Number.isSafeInteger(row.id) || row.id <= 0
      || (row.committeeType !== "1" && row.committeeType !== "2")
      || [row.committeeName, row.candidateFirstName, row.candidateMiddleName, row.candidateLastName]
        .some((value) => value != null && typeof value !== "string")) {
      return unavailable("Invalid Alabama PAC registry identity");
    }
    const fingerprint = JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key as keyof typeof row]]));
    const priorPublic = registryByPublicId.get(row.committeeId);
    const priorInternal = registryByInternalId.get(row.id);
    if ((priorPublic !== undefined && priorPublic !== fingerprint)
      || (priorInternal !== undefined && priorInternal !== fingerprint)) {
      return unavailable("Conflicting Alabama PAC registry identities");
    }
    registryByPublicId.set(row.committeeId, fingerprint);
    registryByInternalId.set(row.id, fingerprint);
    const names = [row.committeeName ?? ""];
    if (row.committeeType === "1") {
      names.push([row.candidateFirstName, row.candidateMiddleName, row.candidateLastName].filter(Boolean).join(" "));
    }
    for (const name of names) {
      const normalized = legalName(name);
      if (!normalized) continue;
      const matches = byName.get(normalized) ?? new Map<string, AlabamaCommitteeRegistryRow>();
      matches.set(row.committeeId, row);
      byName.set(normalized, matches);
    }
  }
  if (!registryByPublicId.size) return unavailable("Missing Alabama PAC registry identities");

  const seenContributions = new Map<string, string>();
  let totalPacCents = 0;
  const totals = new Map<string, { committeeId: string; committeeName: string; sourceUrl: string; cents: number; count: number }>();
  const reportedSourceUrl = "https://fcpa.alabamavotes.gov/page.request.do?" + new URLSearchParams({
    page: "com.acf.common.page.contributionsearchresults",
    sortDirection: "DESC", sortBy: "transactionId",
    criteria: JSON.stringify([
      { field_key: "committeeId", comparison_type: "equalTo", comparison_value_1: input.fcpaCommitteeNumber },
      { field_key: "contributorType", comparison_type: "equalTo", comparison_value_1: "4" },
    ]),
    pageNumber: "1", pageSize: "1000",
  }).toString();
  for (const row of input.cashRows) {
    if (row.committeeId !== input.fcpaCommitteeNumber) continue;
    const date = isoDate(row.contributionDate);
    if (!date) return unavailable("Invalid Alabama PAC contribution date");
    if (date < start || date > end) continue;
    if (!validId(row.contributionId) || !Number.isSafeInteger(row.amountCents)) {
      return unavailable("Invalid Alabama PAC contribution identity or cents");
    }
    const fingerprint = JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key as keyof typeof row]]));
    const prior = seenContributions.get(row.contributionId);
    if (prior !== undefined) {
      if (prior !== fingerprint) return unavailable("Conflicting Alabama PAC contribution IDs");
      continue;
    }
    seenContributions.set(row.contributionId, fingerprint);
    const type = label(row.contributionType), donorType = label(row.contributorType);
    if (donorType === "RETURNED (CASH ONLY)") {
      return unavailable("Alabama PAC component has unresolved Returned (Cash Only) contributions");
    }
    if (IN_KIND_TYPES.has(type)) continue;
    if (!CASH_TYPES.has(type)) return unavailable("Unknown Alabama PAC cash or return category");
    if (row.amountCents < 0) return unavailable("Alabama PAC component has negative cash corrections");
    if (!DONOR_TYPES.has(donorType) && !(donorType === "" && type !== "CASH (ITEMIZED)")) {
      return unavailable("Unknown Alabama PAC contributor category");
    }
    if (type !== "CASH (ITEMIZED)" || donorType !== "PAC" || row.amountCents === 0) continue;
    if (!row.lastName.trim() || row.firstName.trim()) return unavailable("Invalid Alabama PAC organization identity");
    const nameKey = legalName(row.lastName);
    if (!nameKey) return unavailable(`Invalid Alabama reported PAC identity: contribution ${row.contributionId}, donor ${row.lastName}`);
    const matches = [...(byName.get(nameKey)?.values() ?? [])];
    if (matches.length > 1 && matches.some((match) => match.committeeType !== "2"
      || match.committeeId === input.fcpaCommitteeNumber)) {
      return unavailable(`Ambiguous Alabama PAC donor type or self identity: contribution ${row.contributionId}, donor ${row.lastName}`);
    }
    const registry = matches.length === 1 ? matches[0] : undefined;
    if (registry && (registry.committeeId === input.fcpaCommitteeNumber || registry.committeeType !== "2")) continue;
    // Explicit source PAC typing is independently verified by the caller's native filter4.
    // A reported name does not claim a resolved legal registry ID or merge aliases.
    const committeeId = registry ? registry.committeeId : `reported:${nameKey}`;
    const committeeName = registry ? registry.committeeName!.trim() : row.lastName;
    const sourceUrl = registry ? "https://fcpa.alabamavotes.gov/page.request.do?" + new URLSearchParams({
      page: "page.acfPublicCommitteeDetails", type: Buffer.from("pac").toString("base64"),
      id: Buffer.from(String(registry.id)).toString("base64"),
    }).toString() : reportedSourceUrl;
    const current = totals.get(committeeId) ?? { committeeId, committeeName, sourceUrl, cents: 0, count: 0 };
    current.cents += row.amountCents;
    totalPacCents += row.amountCents;
    current.count += 1;
    if (!Number.isSafeInteger(current.cents) || !Number.isSafeInteger(current.count) || !Number.isSafeInteger(totalPacCents)) {
      return unavailable("Unsafe Alabama PAC aggregate cents or contribution count");
    }
    totals.set(committeeId, current);
  }
  return {
    pacDonors: [...totals.values()].map(({ committeeId, committeeName, sourceUrl, cents, count }) => ({
      committeeId, committeeName, sourceUrl,
      committeeType: "Political Action Committee" as const,
      amount: cents / 100,
      contributionCount: count,
    })).sort((a, b) => b.amount - a.amount || a.committeeId.localeCompare(b.committeeId)),
    diagnostics: [],
  };
}
