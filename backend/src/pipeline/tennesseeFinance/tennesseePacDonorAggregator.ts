import { resolveTennesseeLocalNameAuthority,type TennesseeLocalNameAuthority } from "./tennesseeVerifiedLocalName.js";

export type TennesseeFinancePacDonor = {
  committeeId: string;
  committeeName: string;
  committeeType: "Political Action Committee";
  amount: number;
  contributionCount: number;
  sourceUrl: string;
};

export type TennesseePacCashReceipt = {
  reportId: string;
  occurrence: number;
  contributorName: string;
  contributorClass: string;
  date: string;
  amountCents: number;
  sourceUrl: string;
};

// Only the complete, independently typed PAC-category registry belongs here.
export type TennesseePacRegistryIdentity = { campId: string; name: string };

export type TennesseePacSourceProvenance = {
  version: 1;
  candidateId: string;
  electionId: string;
  campCandidateId: string;
  electionYear: number;
  windowStart: string;
  windowEnd: string;
  registryFingerprint: string;
  currentManifestFingerprint: string;
  nativeAllFingerprint: string;
  nativePacFingerprint: string;
  candidateContextFingerprint: string;
  localNameAuthority?: TennesseeLocalNameAuthority;
  reports: readonly { reportId: string; periodIdentity: string; periodStart: string; periodEnd: string;
    rawSha256: string; semanticFingerprint: string; sourceUrl: string }[];
  receipts: readonly { reportId: string; occurrence: number; donorId: string; date: string; amountCents: number;
    dateRelation?: "predates_report_period" }[];
};

export function normalizeTennesseeReportedDonorName(name: string): string {
  return name.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function isTennesseeCampId(value: string): boolean {
  return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

export function tennesseeReportIdFromSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const entries = [...url.searchParams.entries()];
    const id = url.searchParams.get("reportId");
    return url.origin === "https://apps.tn.gov" && !url.port && !url.username && !url.password && !url.hash
      && url.pathname === "/tncamp/search/pub/report_full.htm"
      && entries.length === 1 && entries[0]?.[0] === "reportId" && id && isTennesseeCampId(id)
      && url.search === `?reportId=${id}` ? id : null;
  } catch { return null; }
}

export function tennesseePacAmountCents(value: number): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function validateTennesseePacDonors(donors: readonly TennesseeFinancePacDonor[]): void {
  const ids = new Set<string>();
  for (const donor of donors) {
    const canonicalName = normalizeTennesseeReportedDonorName(donor.committeeName);
    if (!canonicalName || donor.committeeName.trim() !== donor.committeeName
      || (!isTennesseeCampId(donor.committeeId) && donor.committeeId !== `reported:${canonicalName}`)
      || ids.has(donor.committeeId) || donor.committeeType !== "Political Action Committee"
      || tennesseePacAmountCents(donor.amount) === null
      || !Number.isInteger(donor.contributionCount) || donor.contributionCount <= 0 || donor.contributionCount > 2147483647
      || tennesseeReportIdFromSourceUrl(donor.sourceUrl) === null) {
      throw new Error("Invalid Tennessee typed PAC donor snapshot");
    }
    ids.add(donor.committeeId);
  }
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateTennesseePacSourceProvenance(input: {
  provenance: TennesseePacSourceProvenance;
  donors: readonly TennesseeFinancePacDonor[];
  candidateId: string;
  electionId: string;
  campCandidateId: string;
  electionYear: number;
  officeName: string;
  district?: string | null;
  candidateNameNormalized: string;
  ownerName: string;
}): void {
  validateTennesseePacDonors(input.donors);
  const p = input.provenance;
  const fail = () => { throw new Error("Invalid Tennessee PAC source provenance"); };
  const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
  if (p.localNameAuthority !== undefined) {
    const expected = resolveTennesseeLocalNameAuthority({ ...input },p.localNameAuthority.sourceName);
    const canonical = (value: object) => JSON.stringify(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)));
    if (!expected || canonical(expected) !== canonical(p.localNameAuthority)) fail();
  }
  if (p.version !== 1 || p.candidateId !== input.candidateId || p.electionId !== input.electionId
    || p.campCandidateId !== input.campCandidateId || !isTennesseeCampId(p.campCandidateId)
    || p.electionYear !== input.electionYear || !Number.isInteger(p.electionYear) || p.electionYear < 2000 || p.electionYear > 2100
    || !validDate(p.windowStart) || !validDate(p.windowEnd) || p.windowStart > p.windowEnd
    || p.windowStart !== `${p.electionYear - 1}-01-01` || p.windowEnd !== `${p.electionYear}-12-31`
    || ![p.registryFingerprint, p.currentManifestFingerprint, p.nativeAllFingerprint, p.nativePacFingerprint,p.candidateContextFingerprint].every(hash)
    || !Array.isArray(p.reports) || p.reports.length === 0 || !Array.isArray(p.receipts)) fail();
  const reports = new Map<string, string>();
  const periods = new Map<string, { start: string; end: string }>();
  const periodIdentities = new Set<string>();
  for (const report of p.reports) {
    if (!isTennesseeCampId(report.reportId) || reports.has(report.reportId) || !hash(report.rawSha256)
      || !hash(report.semanticFingerprint) || tennesseeReportIdFromSourceUrl(report.sourceUrl) !== report.reportId
      || typeof report.periodIdentity !== "string" || !report.periodIdentity.trim()
      || periodIdentities.has(report.periodIdentity)
      || !validDate(report.periodStart) || !validDate(report.periodEnd) || report.periodStart > report.periodEnd) fail();
    periodIdentities.add(report.periodIdentity);
    reports.set(report.reportId, report.sourceUrl);
    periods.set(report.reportId, { start: report.periodStart, end: report.periodEnd });
  }
  const orderedPeriods = [...periods.values()].sort((a, b) => a.start.localeCompare(b.start));
  if (orderedPeriods.some((period, index) => index > 0 && orderedPeriods[index - 1]!.end >= period.start)) fail();
  const occurrences = new Set<string>();
  const sums = new Map<string, { cents: number; count: number }>();
  for (const receipt of p.receipts) {
    const key = `${receipt.reportId}:${receipt.occurrence}`;
    if (!reports.has(receipt.reportId) || !Number.isSafeInteger(receipt.occurrence) || receipt.occurrence < 0
      || occurrences.has(key) || !validDate(receipt.date) || receipt.date < p.windowStart || receipt.date > p.windowEnd
      || receipt.date > periods.get(receipt.reportId)!.end
      || receipt.dateRelation !== (receipt.date < periods.get(receipt.reportId)!.start ? "predates_report_period" : undefined)
      || !Number.isSafeInteger(receipt.amountCents) || receipt.amountCents <= 0) fail();
    occurrences.add(key);
    const sum = sums.get(receipt.donorId) ?? { cents: 0, count: 0 };
    sum.cents += receipt.amountCents; sum.count += 1;
    if (!Number.isSafeInteger(sum.cents)) fail();
    sums.set(receipt.donorId, sum);
  }
  if (sums.size !== input.donors.length) fail();
  for (const donor of input.donors) {
    const sum = sums.get(donor.committeeId);
    const reportId = tennesseeReportIdFromSourceUrl(donor.sourceUrl);
    if (!sum || sum.cents !== tennesseePacAmountCents(donor.amount) || sum.count !== donor.contributionCount
      || !reportId || reports.get(reportId) !== donor.sourceUrl
      || !p.receipts.some(receipt => receipt.donorId === donor.committeeId && receipt.reportId === reportId)) fail();
  }
}

/** Identity enrichment only. The caller must first prove whole-current cash,
 * covers, native all/PAC membership and unchanged source generations. */
export function aggregateTennesseePacDonors(input: {
  receipts: readonly TennesseePacCashReceipt[];
  registry: readonly TennesseePacRegistryIdentity[];
  windowStart: string;
  windowEnd: string;
}): { donors: TennesseeFinancePacDonor[] | undefined; diagnostics: string[] } {
  const unavailable = (diagnostic: string) => ({ donors: undefined, diagnostics: [diagnostic] });
  if (!validDate(input.windowStart) || !validDate(input.windowEnd) || input.windowStart > input.windowEnd) {
    return unavailable("Invalid Tennessee PAC receipt window");
  }
  const byName = new Map<string, Map<string, string>>();
  for (const row of input.registry) {
    const name = normalizeTennesseeReportedDonorName(row.name);
    if (!name || !isTennesseeCampId(row.campId)) return unavailable("Invalid Tennessee PAC registry identity");
    const matches = byName.get(name) ?? new Map<string, string>();
    matches.set(row.campId, row.name);
    byName.set(name, matches);
  }
  const occurrences = new Set<string>();
  const classesByName = new Map<string, Set<string>>();
  for (const row of input.receipts) {
    if (row.date < input.windowStart || row.date > input.windowEnd) continue;
    const name = normalizeTennesseeReportedDonorName(row.contributorName);
    const classes = classesByName.get(name) ?? new Set<string>();
    classes.add(row.contributorClass);
    classesByName.set(name, classes);
  }
  if ([...classesByName.values()].some(classes => classes.has("P") && classes.size > 1)) {
    return unavailable("Contradictory Tennessee current donor classes");
  }
  const groups = new Map<string, { donor: TennesseeFinancePacDonor; cents: number }>();
  for (const row of input.receipts) {
    const occurrence = `${row.reportId}:${row.occurrence}`;
    if (!isTennesseeCampId(row.reportId) || !Number.isSafeInteger(row.occurrence) || row.occurrence < 0
      || occurrences.has(occurrence) || !validDate(row.date) || !Number.isSafeInteger(row.amountCents)
      || tennesseeReportIdFromSourceUrl(row.sourceUrl) !== row.reportId) {
      return unavailable("Invalid Tennessee current cash receipt identity");
    }
    occurrences.add(occurrence);
    if (row.date < input.windowStart || row.date > input.windowEnd) continue;
    if (row.contributorClass !== "P") continue;
    const name = normalizeTennesseeReportedDonorName(row.contributorName);
    if (!name || row.amountCents <= 0) return unavailable("Unresolved Tennessee typed PAC name or signed receipt");
    const matches = byName.get(name);
    if (matches && matches.size !== 1) return unavailable("Ambiguous Tennessee legal PAC identity");
    const matched = matches?.entries().next().value as [string, string] | undefined;
    const id = matched?.[0] ?? `reported:${name}`;
    const existing = groups.get(id);
    const cents = (existing?.cents ?? 0) + row.amountCents;
    if (!Number.isSafeInteger(cents) || tennesseePacAmountCents(cents / 100) !== cents) {
      return unavailable("Unsafe Tennessee PAC receipt sum");
    }
    groups.set(id, {
      cents,
      donor: {
        committeeId: id, committeeName: existing?.donor.committeeName ?? matched?.[1]?.trim() ?? row.contributorName.trim(),
        committeeType: "Political Action Committee", amount: cents / 100,
        contributionCount: (existing?.donor.contributionCount ?? 0) + 1,
        sourceUrl: existing?.donor.sourceUrl ?? row.sourceUrl,
      },
    });
  }
  const donors = [...groups.values()].map(group => group.donor)
    .sort((a, b) => b.amount - a.amount || a.committeeName.localeCompare(b.committeeName));
  try { validateTennesseePacDonors(donors); }
  catch { return unavailable("Invalid Tennessee aggregated PAC donor snapshot"); }
  return { donors, diagnostics: [] };
}
