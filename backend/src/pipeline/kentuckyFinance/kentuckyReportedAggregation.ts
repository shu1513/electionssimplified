import { filterKentuckyContributionRecordsForCandidateCycle } from "./kentuckyDirectContributionAggregator.js";
import { firstNamesConflict } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import {
  isKentuckyReportedPacket,
  kyAdd,
  kyCents,
  kyHold,
  type KentuckyReportedPacket,
  type KentuckyReportedRow,
} from "./kentuckyReportedSource.js";

export type KentuckyReportedReceiver = {
  linkId: string;
  candidateId: string;
  electionId: string;
  electionYear: number;
  electionDate: string;
  candidateName: string;
  officeScope: string;
  officeName: string;
  canonicalOffice: string;
  location: string;
  canonicalDistrict: string;
  candidateKey: string;
  committeeKey: string;
  committeeName: string;
};
export type KentuckyReportedGroup = {
  key: string;
  name: string;
  sourceClass: string;
  stance: "direct" | "support" | "oppose";
  cents: number;
  occurrences: number;
};
export type KentuckyReportedAggregation = {
  totalCents: number;
  supportCents: number;
  opposeCents: number;
  sourceRows: number;
  censusRows: number;
  matchedRows: number;
  includedRows: number;
  excludedRows: number;
  zeroNetRows: number;
  groups: KentuckyReportedGroup[];
};
export const kyText = (v: string): string =>
  v.normalize("NFC").trim().replace(/\s+/gu, " ");
export function kyPerson(v: string): string {
  const parts = v.split(",");
  if (parts.length === 2) v = `${parts[1]} ${parts[0]}`;
  return kyText(v).toUpperCase().replace(/[.]/g, "");
}
export function kyOffice(v: string): string {
  const key = kyText(v)
    .toUpperCase()
    .replace(/\s*\((?:EVEN|ODD)\)$/, "");
  if (["STATE REPRESENTATIVE", "STATE LOWER CHAMBER LEGISLATOR"].includes(key))
    return "STATE REPRESENTATIVE";
  if (["STATE SENATOR", "STATE UPPER CHAMBER LEGISLATOR"].includes(key))
    return "STATE SENATOR";
  return key;
}
export function kyLocation(v: string): string {
  const s = kyText(v).toUpperCase();
  const ordinal = /^(\d+)(?:ST|ND|RD|TH) DISTRICT$/.exec(s);
  if (ordinal) return String(Number(ordinal[1]));
  if (
    /^(?:(?:HOUSE|SENATE|STATE (?:HOUSE|SENATE|REPRESENTATIVE|SENATOR))\s*)?(?:DISTRICT\s*)?0*\d+$/.test(
      s,
    )
  )
    return String(Number(s.match(/\d+$/)![0]));
  return s === "STATEWIDE" ? "STATEWIDE" : s;
}
function date(v: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(v.trim());
  return m
    ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`
    : kyHold("row_date");
}
function context(row: KentuckyReportedRow): string {
  return JSON.stringify([
    kyPerson(`${row["First Name"]} ${row["Last Name"]}`),
    kyOffice(row["Office Sought"]!),
    kyLocation(row.Location!),
    date(row["Election Date"]!),
    row["Election Type"],
  ]);
}
function regular(row: KentuckyReportedRow): boolean {
  return ["PRIMARY", "GENERAL"].includes(row["Election Type"] ?? "");
}
/** The full all-status census, not the local ballot or receipt-bearing subset,
 * must resolve the receiving name/office/district independently of receipts. */
export function qualifyKentuckyReportedReceiver(
  receiver: KentuckyReportedReceiver,
  source: KentuckyReportedPacket,
): KentuckyReportedRow[] {
  if (
    !isKentuckyReportedPacket(source) ||
    receiver.electionYear !== 2026 ||
    receiver.electionDate !== "2026-11-03" ||
    kyOffice(receiver.officeName) !== kyOffice(receiver.canonicalOffice) ||
    !receiver.location ||
    kyLocation(receiver.location) !== kyLocation(receiver.canonicalDistrict)
  )
    kyHold("receiver_scope");
  const matches = source.census.filter(
    (row) =>
      regular(row) &&
      kyOffice(row["Office Sought"]!) === kyOffice(receiver.officeName) &&
      kyLocation(row.Location!) === kyLocation(receiver.location) &&
      filterKentuckyContributionRecordsForCandidateCycle({
        candidateName: receiver.candidateName,
        electionDate: receiver.electionDate,
        officeName: receiver.officeName,
        location: receiver.location,
        expandNames: true,
        contributionRecords: [
          {
            candidateName: `${row["First Name"]} ${row["Last Name"]}`,
            candidateFirstName: row["First Name"],
            candidateLastName: row["Last Name"],
            office: row["Office Sought"],
            location: row.Location,
            electionDate: date(row["Election Date"]!),
            electionType: row["Election Type"],
            amount: 0,
          },
        ],
      }).length === 1,
  );
  const general = matches.filter(
    (row) => date(row["Election Date"]!) === receiver.electionDate,
  );
  if (general.length !== 1 || !matches.length)
    kyHold("receiving_census_ambiguous_or_missing");
  // One registration in each regular election; differing current/closed rows
  // cannot be silently collapsed into a single identity.
  if (
    new Set(matches.map(context)).size !== matches.length ||
    new Set(matches.map((r) => date(r["Election Date"]!))).size !==
      matches.length
  )
    kyHold("receiving_census_duplicate");
  const legalNames = new Set(
    matches.map((row) => kyPerson(`${row["First Name"]} ${row["Last Name"]}`)),
  );
  if (!legalNames.has(kyPerson(receiver.committeeName)))
    kyHold("receiving_link_name_changed");
  return matches;
}
const KY_REPORTED_COMMITTEE_CLASSES = new Set([
  "KYPAC",
  "FEDERALPAC",
  "OUT_OF_STATE_PACS",
  "OTHER_CANDIDATES",
  "OTHER_CAMP_COMM",
  "EXECUTIVECOMM",
  "CAUCUS_CAMP_COMM",
  "NATIONAL_EXECUTIVE_COMMITTEE",
  "CONTRIBUTINGORGANIZATION",
]);
export const isKentuckyReportedCommitteeClass = (value: string): boolean => KY_REPORTED_COMMITTEE_CLASSES.has(value);
const targetIndexes = new WeakMap<
  KentuckyReportedPacket,
  Map<string, KentuckyReportedRow[]>
>();
const receiptIndexes = new WeakMap<
  KentuckyReportedPacket,
  Map<string, KentuckyReportedRow[]>
>();
function receiptIndex(
  source: KentuckyReportedPacket,
): Map<string, KentuckyReportedRow[]> {
  let index = receiptIndexes.get(source);
  if (index) return index;
  index = new Map();
  for (const row of source.rows) {
    if (!regular(row)) continue;
    const key = JSON.stringify([
        kyPerson(
          `${row["Recipient First Name"]} ${row["Recipient Last Name"]}`,
        ),
        kyOffice(row["Office Sought"]!),
        kyLocation(row.Location!),
        date(row["Election Date"]!),
        row["Election Type"],
      ]),
      list = index.get(key) ?? [];
    list.push(row);
    index.set(key, list);
  }
  receiptIndexes.set(source, index);
  return index;
}
function censusIndex(
  source: KentuckyReportedPacket,
): Map<string, KentuckyReportedRow[]> {
  let index = targetIndexes.get(source);
  if (index) return index;
  index = new Map();
  for (const r of source.census) {
    const key = JSON.stringify([
        date(r["Election Date"]!),
        kyOffice(r["Office Sought"]!),
        kyPerson(`${r["First Name"]} ${r["Last Name"]}`),
      ]),
      list = index.get(key) ?? [];
    list.push(r);
    index.set(key, list);
  }
  targetIndexes.set(source, index);
  return index;
}
export function aggregateKentuckyReported(
  receiver: KentuckyReportedReceiver,
  source: KentuckyReportedPacket,
): KentuckyReportedAggregation {
  const receiving = qualifyKentuckyReportedReceiver(receiver, source),
    groups = new Map<string, KentuckyReportedGroup>();
  let matchedRows = 0,
    includedRows = 0;
  const receivingNames = new Set(
    receiving.map((r) => kyPerson(`${r["First Name"]} ${r["Last Name"]}`)),
  );
  const index = censusIndex(source);
  const censusTargets = (name: string, office: string, election: string) =>
    index.get(JSON.stringify([election, kyOffice(office), kyPerson(name)])) ??
    [];
  const receipts = source.kind === "committee" ? receiptIndex(source) : null;
  const rows = receipts
    ? receiving.flatMap((r) => receipts.get(context(r)) ?? [])
    : source.rows;
  for (const row of rows) {
    let stance: KentuckyReportedGroup["stance"],
      name: string,
      sourceClass: string,
      key: string;
    if (source.kind === "committee") {
      const filedName = `${row["Recipient First Name"]} ${row["Recipient Last Name"]}`;
      if (
        !regular(row) ||
        !receiving.some(
          (r) =>
            date(r["Election Date"]!) === date(row["Election Date"]!) &&
            kyPerson(`${r["First Name"]} ${r["Last Name"]}`) ===
              kyPerson(filedName) &&
            kyOffice(row["Office Sought"]!) === kyOffice(r["Office Sought"]!) &&
            kyLocation(row.Location!) === kyLocation(r.Location!),
        )
      )
        continue;
      matchedRows++;
      sourceClass = row["Contribution Type"]!;
      if (
        !KY_REPORTED_COMMITTEE_CLASSES.has(sourceClass) ||
        !["DIRECT", "EVENT_FUNDRAISING"].includes(row["Contribution Mode"]!)
      )
        continue;
      name = kyText(
        row["From Organization Name"]! ||
          `${row["Contributor First Name"]} ${row["Contributor Last Name"]}`,
      );
      if (!name || /[\u0000-\u001f\u007f]/.test(name))
        kyHold("missing_typed_donor");
      if (
        receivingNames.has(kyPerson(name)) ||
        kyPerson(name) === kyPerson(row["To Organization"]!)
      )
        continue;
      stance = "direct";
      key = JSON.stringify([
        sourceClass,
        name.toUpperCase(),
        ...["Address 1", "Address 2", "City", "State", "Zip"].map((k) =>
          kyText(row[k]!).toUpperCase(),
        ),
      ]);
    } else {
      const target = row["Candidate Name"]!,
        office = row["Office / Ballot Measure"]!,
        election = date(row["Election Date"]!);
      if (kyOffice(office) !== kyOffice(receiver.officeName)) continue;
      // A shorter/variant label resembling this receiver (including a nickname
      // the receiver link itself was accepted under) but lacking a unique full
      // census match is held, never treated as proof of zero spending.
      const targets = censusTargets(target, office, election);
      const relevant = targets.some(
        (r) =>
          kyLocation(r.Location!) === kyLocation(receiver.location) &&
          regular(r) &&
          receivingNames.has(kyPerson(`${r["First Name"]} ${r["Last Name"]}`)),
      );
      if (!relevant) {
        const targetParts = kyPerson(target).split(" "),
          possible = [...receivingNames].some((n) => {
            const parts = n.split(" ");
            return (
              !firstNamesConflict(targetParts[0]!, parts[0]!) &&
              targetParts.at(-1) === parts.at(-1) &&
              !hasMiddleNameConflict({
                candidateName: n,
                rowNames: [target],
                normalizePersonName: kyPerson,
              })
            );
          });
        if (possible) kyHold("ie_target_unresolved");
        continue;
      }
      if (targets.length !== 1) kyHold("ie_target_district_ambiguous");
      matchedRows++;
      if (!["Supported", "Opposed"].includes(row["Support / Oppose"]!))
        kyHold("ie_stance_unresolved");
      stance = row["Support / Oppose"] === "Supported" ? "support" : "oppose";
      sourceClass = "reported independent spender";
      name = kyText(row.Name!);
      if (!name || /[\u0000-\u001f\u007f]/.test(name))
        kyHold("ie_spender_missing");
      key = JSON.stringify([name.toUpperCase(), stance]);
    }
    const amount = kyCents(row.Amount!);
    includedRows++;
    const group = groups.get(key) ?? {
      key,
      name,
      sourceClass,
      stance,
      cents: 0,
      occurrences: 0,
    };
    group.cents = kyAdd(group.cents, amount);
    group.occurrences++;
    groups.set(key, group);
  }
  let zeroNetRows = 0,
    totalCents = 0,
    supportCents = 0,
    opposeCents = 0;
  const positive: KentuckyReportedGroup[] = [];
  for (const g of groups.values()) {
    if (g.cents < 0) kyHold("negative_reported_group_net");
    if (g.cents === 0) {
      zeroNetRows += g.occurrences;
      continue;
    }
    positive.push(g);
    totalCents = kyAdd(totalCents, g.cents);
    if (g.stance === "support") supportCents = kyAdd(supportCents, g.cents);
    if (g.stance === "oppose") opposeCents = kyAdd(opposeCents, g.cents);
  }
  return {
    totalCents,
    supportCents,
    opposeCents,
    sourceRows: source.rows.length,
    censusRows: source.census.length,
    matchedRows,
    includedRows,
    excludedRows: source.rows.length - includedRows,
    zeroNetRows,
    groups: positive.sort((a, b) => a.key.localeCompare(b.key)),
  };
}
