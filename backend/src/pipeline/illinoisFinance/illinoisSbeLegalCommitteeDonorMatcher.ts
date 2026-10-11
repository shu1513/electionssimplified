import { parseIllinoisSbeTsv } from "./illinoisSbeTsvParser.js";

/** Full official registry schema, including fields deliberately unused for donor identity. */
export const ILLINOIS_SBE_COMMITTEE_REGISTRY_HEADER = [
  "ID", "TypeOfCommittee", "StateCommittee", "StateID", "LocalCommittee", "LocalID", "ReferName", "Name",
  "Address1", "Address2", "Address3", "City", "State", "Zip", "Status", "StatusDate", "CreationDate",
  "CreationAmount", "DispFundsReturn", "DispFundsPolComm", "DispFundsCharity", "DispFunds95", "DispFundsDescrip",
  "CanSuppOpp", "PolicySuppOpp", "PartyAffiliation", "Purpose",
] as const;

export type IllinoisSbeLegalCommitteeRegistryRow = {
  committeeId: string;
  legalName: string;
  committeeType: string;
  status: string;
};
export type IllinoisSbeLegalCommitteeDonorMatch =
  | { status: "matched"; committeeId: string; legalName: string; committeeType: "Political Action" | "Political Party" }
  | { status: "unmatched" | "ambiguous"; reason: string };

function legalNameKey(value: unknown): string {
  // Preserve diacritics and every legal-name token. No ReferName, nickname, or acronym expansion.
  return typeof value === "string" ? value.normalize("NFKC").toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim() : "";
}
function typeKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}
function validIdentity(row: IllinoisSbeLegalCommitteeRegistryRow): boolean {
  return validId(row.committeeId) && typeof row.legalName === "string" && !!legalNameKey(row.legalName) &&
    typeof row.committeeType === "string" && typeof row.status === "string" &&
    [row.legalName, row.committeeType, row.status].every((value) =>
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/.test(value));
}
function identityKey(row: IllinoisSbeLegalCommitteeRegistryRow): string {
  // Status changes do not create a different legal committee identity.
  return JSON.stringify([legalNameKey(row.legalName), typeKey(row.committeeType)]);
}
function hasConflictingIds(rows: readonly IllinoisSbeLegalCommitteeRegistryRow[]): boolean {
  const identities = new Map<string, string>();
  for (const row of rows) {
    const identity = identityKey(row);
    const prior = identities.get(row.committeeId);
    if (prior !== undefined && prior !== identity) return true;
    identities.set(row.committeeId, identity);
  }
  return false;
}

/** Explicit source byte decoding, independent of Node's ICU encoding aliases. */
export function decodeIllinoisSbeWindows1252(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error("Illinois SBE Windows-1252 decoder requires raw bytes");
  // Undefined CP1252 bytes remain controls; identity validation rejects them.
  const highBytes = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
  return Buffer.from(bytes).toString("latin1").replace(/[\u0080-\u009f]/g,
    (character) => highBytes[character.charCodeAt(0) - 0x80]!);
}

/** Strict Windows-1252 Committees.txt decoder. Retains all types and statuses before matching. */
export function decodeIllinoisSbeLegalCommitteeRegistry(bytes: Uint8Array): IllinoisSbeLegalCommitteeRegistryRow[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("Illinois SBE Committees.txt requires nonempty raw bytes");
  }
  const text = decodeIllinoisSbeWindows1252(bytes);
  const rows: IllinoisSbeLegalCommitteeRegistryRow[] = [];
  parseIllinoisSbeTsv(text, "Committees.txt", ILLINOIS_SBE_COMMITTEE_REGISTRY_HEADER, (fields) => {
    const row = { committeeId: fields[0]!.trim(), legalName: fields[7]!.trim(),
      committeeType: fields[1]!.trim(), status: fields[14]!.trim() };
    if (!validIdentity(row)) throw new Error(`Illinois SBE Committees.txt row ${rows.length + 2} has invalid committee identity`);
    rows.push(row);
  });
  if (rows.length === 0) throw new Error("Illinois SBE Committees.txt registry has no committee rows");
  if (hasConflictingIds(rows)) throw new Error("Illinois SBE Committees.txt has conflicting identities for a committee ID");
  return rows;
}

export type IllinoisSbeLegalCommitteeDonorLookupInput = {
  donorName: string;
  recipientCommitteeIds?: readonly string[];
};
export type IllinoisSbeLegalCommitteeDonorMatcher =
  (input: IllinoisSbeLegalCommitteeDonorLookupInput) => IllinoisSbeLegalCommitteeDonorMatch;

/** Copy and index the complete registry once per source generation before any gift lookup. */
export function createIllinoisSbeLegalCommitteeDonorMatcher(
  registryRows: readonly IllinoisSbeLegalCommitteeRegistryRow[]
): IllinoisSbeLegalCommitteeDonorMatcher {
  const rows = registryRows.map((row) => ({ committeeId: row.committeeId, legalName: row.legalName,
    committeeType: row.committeeType, status: row.status }));
  let registryError: IllinoisSbeLegalCommitteeDonorMatch | undefined;
  if (rows.length === 0) registryError = { status: "unmatched", reason: "registry_empty" };
  else if (rows.some((row) => !validIdentity(row))) registryError = { status: "ambiguous", reason: "invalid_registry_identity" };
  else if (hasConflictingIds(rows)) registryError = { status: "ambiguous", reason: "registry_committee_identity_conflict" };
  const byName = new Map<string, Map<string, IllinoisSbeLegalCommitteeRegistryRow>>();
  if (!registryError) {
    for (const row of rows) {
      const name = legalNameKey(row.legalName);
      let identities = byName.get(name);
      if (!identities) { identities = new Map(); byName.set(name, identities); }
      if (!identities.has(row.committeeId)) identities.set(row.committeeId, row);
    }
  }
  return (input) => {
    const name = legalNameKey(input.donorName);
    if (!name) return { status: "unmatched", reason: "invalid_donor_name" };
    if (registryError) return { ...registryError };
    const matches = byName.get(name);
    if (!matches) return { status: "unmatched", reason: "donor_legal_name_unresolved" };
    if (matches.size > 1) return { status: "ambiguous", reason: "registry_legal_name_ambiguous_across_all_types" };
    const row = matches.values().next().value!;
    const recipients = input.recipientCommitteeIds ?? [];
    if (recipients.some((committeeId) => !validId(committeeId))) {
      return { status: "ambiguous", reason: "invalid_recipient_committee_identity" };
    }
    if (recipients.includes(row.committeeId)) return { status: "unmatched", reason: "donor_is_recipient_committee" };
    const type = typeKey(row.committeeType);
    const committeeType = type === "POLITICAL ACTION" ? "Political Action" : type === "POLITICAL PARTY" ? "Political Party" : null;
    if (!committeeType) return { status: "unmatched", reason: "donor_committee_type_not_allowed" };
    return { status: "matched", committeeId: row.committeeId, legalName: row.legalName, committeeType };
  };
}

/** Legal identity only: a match does not establish a current or cash receipt. */
export function matchIllinoisSbeLegalCommitteeDonor(input: IllinoisSbeLegalCommitteeDonorLookupInput & {
  registryRows: readonly IllinoisSbeLegalCommitteeRegistryRow[];
}): IllinoisSbeLegalCommitteeDonorMatch {
  return createIllinoisSbeLegalCommitteeDonorMatcher(input.registryRows)(input);
}
