import { createHash } from "node:crypto";

export type FloridaCommitteeDonorType = "PAC" | "CCE" | "PTY" | "PAP";
export type FloridaCommitteeDateBound =
  | { effectiveDate: string; activeBy?: never; closedBy?: never }
  | { activeBy: string; effectiveDate?: never; closedBy?: never }
  | { closedBy: string; effectiveDate?: never; activeBy?: never };
export type FloridaCommitteeDateEvidence = FloridaCommitteeDateBound & {
  sourceUrl: string;
  sha256: string;
};
export type FloridaCommitteeDonorRegistration = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
  status: string;
  address: string;
  cityStateZip: string;
  sourceUrl: string;
  registration: FloridaCommitteeDateEvidence | null;
  disbandment: FloridaCommitteeDateEvidence | null;
  rawFields?: Readonly<Record<string, unknown>>;
};
export type FloridaCommitteeDonorQueryProof = {
  prefixes: readonly string[];
  fingerprintBefore: string;
  fingerprintAfter: string;
};
export type FloridaResolvedCommitteeDonorIdentity = {
  committeeId: string;
  committeeName: string;
  committeeType: string;
  sourceUrl: string;
  includedInCommitteeDonorScope: boolean;
  resolution: "unique_exact_name" | "dated_exact_address";
};
export type FloridaCommitteeDonorIdentityResult = {
  status: "resolved" | "not_found" | "unresolved";
  identity?: FloridaResolvedCommitteeDonorIdentity;
  diagnostics: readonly string[];
};

const COMMITTEE_TYPES = new Set<string>(["PAC", "CCE", "PTY", "PAP"]);
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[1-9][0-9]*$/;

// Legal names preserve punctuation, accents, word order and every reported token.
function exactText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toUpperCase();
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => JSON.stringify(key) + ":" + canonical(v)).join(",") + "}";
}

/** Full row multiset; retains duplicate occurrences and all supplied source metadata. */
export function fingerprintFloridaCommitteeDonorRegistrations(
  rows: readonly FloridaCommitteeDonorRegistration[]
): string {
  return createHash("sha256").update(rows.map(canonical).sort().join("\n")).digest("hex");
}

function day(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function officialUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "dos.elections.myflorida.com" &&
      !u.username && !u.password && !u.port && !u.hash ? u : null;
  } catch { return null; }
}
function accountUrl(value: string, committeeId: string): boolean {
  const u = officialUrl(value);
  return Boolean(u && u.pathname === "/committees/ComDetail.asp" &&
    [...u.searchParams.keys()].length === 1 && u.searchParams.get("account") === committeeId);
}
function dateEvidence(value: FloridaCommitteeDateEvidence | null, kind: "registration" | "disbandment"): boolean {
  if (value === null) return true;
  if (!value || !HASH.test(value.sha256)) return false;
  const fields = ["effectiveDate", "activeBy", "closedBy"].filter(k => Object.hasOwn(value, k));
  if (fields.length !== 1 || (kind === "registration" && fields[0] === "closedBy") ||
    (kind === "disbandment" && fields[0] === "activeBy") ||
    !day(value[fields[0] as keyof FloridaCommitteeDateBound] as string)) return false;
  const u = officialUrl(value.sourceUrl);
  return Boolean(u && u.pathname === "/campaign-docs/PDFHandler.ashx" &&
    u.searchParams.has("AcctType") && /^[1-9][0-9]*$/.test(u.searchParams.get("TrackNum") ?? ""));
}
function validRegistration(r: FloridaCommitteeDonorRegistration): boolean {
  return r && ACCOUNT.test(r.committeeId) && [r.committeeName, r.committeeType, r.status,
    r.address, r.cityStateZip, r.sourceUrl].every(v => typeof v === "string") &&
    Boolean(exactText(r.committeeName)) && Boolean(exactText(r.committeeType)) &&
    accountUrl(r.sourceUrl, r.committeeId) && dateEvidence(r.registration, "registration") &&
    dateEvidence(r.disbandment, "disbandment") &&
    !(r.registration && r.disbandment &&
      r.registration.effectiveDate &&
      (r.disbandment.effectiveDate || r.disbandment.closedBy) &&
      r.registration.effectiveDate > (r.disbandment.effectiveDate ?? r.disbandment.closedBy!));
}

/** USPS Pub28 C1 DRIVE/DR only. No street/unit/punctuation/locality fields are removed. */
function street(value: string): string {
  return exactText(value).replace(/(^| )DRIVE$/u, "$1DR");
}
function sameAddress(
  r: FloridaCommitteeDonorRegistration, address: string, cityStateZip: string
): boolean {
  return Boolean(exactText(address) && exactText(cityStateZip) && exactText(r.address) &&
    exactText(r.cityStateZip)) && street(r.address) === street(address) &&
    exactText(r.cityStateZip) === exactText(cityStateZip);
}
function outsideKnownLifetime(r: FloridaCommitteeDonorRegistration, date: string): boolean {
  return Boolean((r.registration?.effectiveDate && date < r.registration.effectiveDate) ||
    (r.disbandment?.effectiveDate && date >= r.disbandment.effectiveDate) ||
    (r.disbandment?.closedBy && date > r.disbandment.closedBy));
}
function registrationSupportsDate(r: FloridaCommitteeDonorRegistration, date: string): boolean {
  const bound = r.registration?.effectiveDate ?? r.registration?.activeBy;
  return Boolean(bound && date >= bound);
}

/**
 * Identity policy only: source acquisition must establish the paired all-status
 * query neighborhood and reviewed exact-date or temporal-bound evidence. This does not establish an
 * exhaustive statewide registry, financial currentness, refunds or cash totals.
 */
export function resolveFloridaCommitteeDonorIdentity(input: {
  reportedName: string;
  reportedAddress: string;
  reportedCityStateZip: string;
  transactionDate: string;
  registrations?: readonly FloridaCommitteeDonorRegistration[];
  queryProof?: FloridaCommitteeDonorQueryProof;
  receivingCommitteeId?: string;
}): FloridaCommitteeDonorIdentityResult {
  const unknown = (reason: string): FloridaCommitteeDonorIdentityResult =>
    ({ status: "unresolved", diagnostics: [reason] });
  if (typeof input.reportedName !== "string" || !exactText(input.reportedName) ||
    typeof input.reportedAddress !== "string" || typeof input.reportedCityStateZip !== "string" ||
    !day(input.transactionDate)) return unknown("Missing or invalid reported donor identity/date.");
  if (input.receivingCommitteeId !== undefined && !ACCOUNT.test(input.receivingCommitteeId)) {
    return unknown("Invalid receiving committee identity.");
  }
  const rows = input.registrations;
  if (!rows || !rows.every(validRegistration)) return unknown("Committee registry source unavailable or invalid.");
  const proof = input.queryProof;
  const name = exactText(input.reportedName);
  if (!proof || !Array.isArray(proof.prefixes) || proof.prefixes.length < 2 ||
    !proof.prefixes.every(p => typeof p === "string" && exactText(p) &&
      name.startsWith(exactText(p))) ||
    new Set(proof.prefixes.map(exactText)).size < 2 ||
    !HASH.test(proof.fingerprintBefore) || proof.fingerprintBefore !== proof.fingerprintAfter ||
    proof.fingerprintAfter !== fingerprintFloridaCommitteeDonorRegistrations(rows)) {
    return unknown("Missing or changed paired all-status name-query neighborhood.");
  }
  const matches = rows.filter(r => exactText(r.committeeName) === name);
  if (!matches.length) return { status: "not_found", diagnostics: ["No exact registered legal-name match; donor remains unclassified."] };
  // Full identical source rows may repeat; a same ID with conflicting metadata is unresolved.
  const byId = new Map<string, FloridaCommitteeDonorRegistration>();
  for (const r of matches) {
    const old = byId.get(r.committeeId);
    if (old && canonical(old) !== canonical(r)) return unknown("Conflicting registry metadata for one committee account.");
    byId.set(r.committeeId, r);
  }
  const identities = [...byId.values()];
  let selected: FloridaCommitteeDonorRegistration;
  let resolution: FloridaResolvedCommitteeDonorIdentity["resolution"];
  if (identities.length === 1) {
    selected = identities[0]!;
    resolution = "unique_exact_name";
  } else {
    const viable = identities.filter(r => !outsideKnownLifetime(r, input.transactionDate));
    if (viable.length !== 1 || !registrationSupportsDate(viable[0]!, input.transactionDate) ||
      !sameAddress(viable[0]!, input.reportedAddress, input.reportedCityStateZip)) {
      return unknown("Same-name accounts lack unique source-dated full-address identity.");
    }
    selected = viable[0]!;
    resolution = "dated_exact_address";
  }
  const status = exactText(selected.status);
  const historicalClosedLifetime = status === "CLOSED" && selected.registration &&
    selected.disbandment?.effectiveDate && registrationSupportsDate(selected, input.transactionDate) &&
    input.transactionDate < selected.disbandment.effectiveDate;
  if ((status !== "ACTIVE" && !historicalClosedLifetime) ||
    outsideKnownLifetime(selected, input.transactionDate) ||
    (selected.registration?.activeBy && !registrationSupportsDate(selected, input.transactionDate)) ||
    selected.disbandment?.closedBy) {
    return unknown("Closed, unknown-status, or out-of-lifetime account at receipt date.");
  }
  const included = COMMITTEE_TYPES.has(selected.committeeType) &&
    selected.committeeId !== input.receivingCommitteeId;
  return {
    status: "resolved",
    identity: {
      committeeId: selected.committeeId,
      committeeName: selected.committeeName,
      committeeType: selected.committeeType,
      sourceUrl: selected.sourceUrl,
      includedInCommitteeDonorScope: included,
      resolution,
    },
    diagnostics: included ? [] : ["Resolved source class/self is outside the committee-donor subset."],
  };
}
