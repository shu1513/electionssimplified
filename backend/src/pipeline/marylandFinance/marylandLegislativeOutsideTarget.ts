import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import { normalizeMarylandCandidateNameKeys } from "./marylandCandidateCommitteeResolver.js";
import { parseMaryland2026GeneralElectionDate } from "./marylandOutsideReceivingContext.js";

type Scope = "state_upper" | "state_lower";
type RosterCandidate = Readonly<{
  candidateName: string;
  party: string;
  status: string;
  committeeName: string | null;
  officeScope: Scope;
  officeName: "State Senator" | "State Lower Chamber Legislator";
  district: string;
}>;
const fail = (): never => {
  throw new Error("invalid_maryland_legislative_roster");
};
const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
const text = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const districtKey = (s: string) =>
  s
    .trim()
    .toUpperCase()
    .replace(/^0+(?=\d)/, "");
function nameMatches(canonical: string, source: string): boolean {
  const keys = normalizeMarylandCandidateNameKeys(canonical, {
    expandNicknames: true,
  });
  return (
    [...normalizeMarylandCandidateNameKeys(source)].some((k) => keys.has(k)) &&
    !hasMiddleNameConflict({
      candidateName: canonical,
      rowNames: [source],
      normalizePersonName: normalize,
    })
  );
}
function partyKey(s: string): string {
  const n = normalize(s);
  if (["DEMOCRAT", "DEMOCRATIC", "DEMOCRATIC PARTY"].includes(n))
    return "DEMOCRATIC";
  if (["REPUBLICAN", "REPUBLICAN PARTY"].includes(n)) return "REPUBLICAN";
  return n;
}

/** Complete two legislative sections, including non-active candidates and
 * missing committee labels. Those facts are retained, never treated as zeros
 * or permission to bind an ineligible target. Contact fields are not projected. */
export function parseMaryland2026GeneralLegislativeRoster(
  input: string,
): readonly RosterCandidate[] {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 4 * 1024 * 1024
  )
    return fail();
  const html = input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  if (/<!--|<(?:script|style)\b/i.test(html)) return fail();
  const titles = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    text(m[1]!),
  );
  if (
    titles.filter(
      (t) => t === "2026 Gubernatorial General Election State Candidates List",
    ).length !== 1
  )
    return fail();
  const sections = [
    ...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi),
  ].map((m) => m[1]!);
  const result: RosterCandidate[] = [];
  for (const [heading, officeScope, officeName] of [
    ["State Senator, by District", "state_upper", "State Senator"],
    [
      "House of Delegates, by District",
      "state_lower",
      "State Lower Chamber Legislator",
    ],
  ] as const) {
    const selected = sections.filter((s) => {
      const h = [...s.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi)];
      return h.length === 1 && text(h[0]![1]!) === heading;
    });
    if (selected.length !== 1) return fail();
    const section = selected[0]!,
      districts = [...section.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
    if (!districts.length) return fail();
    const candidateBlocks = [
      ...section.matchAll(/<div\b[^>]*\bclass=["']candidate["'][^>]*>/gi),
    ].length;
    const candidateHeadings = [
      ...section.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi),
    ].length;
    let parsedCandidates = 0;
    for (let i = 0; i < districts.length; i++) {
      const h = districts[i]!,
        d = /^Legislative District ([1-9]\d*[A-C]?)$/.exec(text(h[1]!));
      if (!d || (officeScope === "state_upper" && /[A-C]$/.test(d[1]!)))
        return fail();
      const block = section.slice(
        h.index! + h[0].length,
        districts[i + 1]?.index ?? section.length,
      );
      const people = [...block.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
      if (!people.length) return fail();
      for (let j = 0; j < people.length; j++) {
        const person = people[j]!,
          segment = block.slice(
            person.index! + person[0].length,
            people[j + 1]?.index ?? block.length,
          );
        const opening = /<div\b[^>]*\bclass=["']candidate["'][^>]*>/i.exec(
          segment,
        );
        if (!opening) return fail();
        const party = text(segment.slice(0, opening.index)),
          candidateName = text(person[1]!);
        if (!party || !candidateName) return fail();
        const tags = /<\/?div\b[^>]*>/gi;
        tags.lastIndex = opening.index;
        let depth = 0,
          end = -1,
          tag: RegExpExecArray | null;
        while ((tag = tags.exec(segment))) {
          depth += /^<\/div/i.test(tag[0]) ? -1 : 1;
          if (depth === 0) {
            end = tag.index;
            break;
          }
        }
        if (end < 0) return fail();
        const body = segment.slice(opening.index + opening[0].length, end);
        const terms = [
          ...body.matchAll(
            /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
          ),
        ];
        const status = terms.filter((t) => text(t[1]!) === "Status"),
          committee = terms.filter((t) => text(t[1]!) === "Committee Name");
        if (
          status.length !== 1 ||
          committee.length > 1 ||
          !text(status[0]![2]!)
        )
          return fail();
        const committeeName = committee.length ? text(committee[0]![2]!) : null;
        if (committeeName === "") return fail();
        parsedCandidates++;
        result.push(
          Object.freeze({
            candidateName,
            party,
            status: text(status[0]![2]!),
            committeeName,
            officeScope,
            officeName,
            district: districtKey(d[1]!),
          }),
        );
      }
    }
    if (
      parsedCandidates !== candidateBlocks ||
      parsedCandidates !== candidateHeadings
    )
      return fail();
  }
  return Object.freeze(result);
}

export type MarylandLegislativeOutsideCanonical = Readonly<{
  candidateName: string;
  party: string;
  officeScope: string;
  officeName: string;
  districtGeoidCompact: string;
  electionYear: number;
  electionDate: string;
  electionStage: string;
}>;
/** Registry rows and the allocation target must come from the complete normal
 * source readers. This proves an account/office/election association only;
 * parent money, report editions and source currentness remain separate gates. */
export function bindMarylandLegislativeOutsideTarget(input: {
  canonical: MarylandLegislativeOutsideCanonical;
  target: Readonly<{ candidateGuid: string; candidateBallotIssueName: string }>;
  registrationRows: readonly Readonly<Record<string, unknown>>[];
  rosterHtml: string;
  electionDatesHtml: string;
}): {
  binding?: Readonly<{
    sourceCandidateAccountGuid: string;
    sourceCommitteeName: string;
    sourceOwnerName: string;
    officeScope: Scope;
    officeName: RosterCandidate["officeName"];
    district: string;
    electionYear: 2026;
    electionDate: string;
  }>;
  diagnostics: string[];
} {
  try {
    const c = input.canonical,
      date = parseMaryland2026GeneralElectionDate(input.electionDatesHtml);
    const roster = parseMaryland2026GeneralLegislativeRoster(input.rosterHtml);
    if (
      c.electionYear !== 2026 ||
      c.electionStage !== "general" ||
      c.electionDate !== date.electionDate ||
      !/^24\d{1,3}[A-C]?$/.test(c.districtGeoidCompact) ||
      !["state_upper", "state_lower"].includes(c.officeScope)
    )
      throw Error();
    const matches = input.registrationRows.filter(
      (r) =>
        typeof r.filerRegistrationGuid === "string" &&
        r.filerRegistrationGuid.toLowerCase() ===
          input.target.candidateGuid.toLowerCase(),
    );
    if (matches.length !== 1) throw Error();
    const r = matches[0]!;
    if (
      !["CC", "PFC"].includes(String(r.committeeTypeCode)) ||
      typeof r.registrationDocumentGuid !== "string" ||
      !r.registrationDocumentGuid ||
      typeof r.candidateName !== "string" ||
      !r.candidateName.trim() ||
      typeof r.committeeName !== "string" ||
      r.committeeName.trim().replace(/\s+/g, " ").toUpperCase() !==
        input.target.candidateBallotIssueName
          .trim()
          .replace(/\s+/g, " ")
          .toUpperCase() ||
      typeof r.officeSoughtId !== "number" ||
      !Number.isSafeInteger(r.officeSoughtId) ||
      r.officeSoughtId <= 0 ||
      typeof r.jurisdictionId !== "number" ||
      !Number.isSafeInteger(r.jurisdictionId) ||
      r.jurisdictionId <= 0 ||
      typeof r.partyAffiliation !== "string" ||
      !partyKey(r.partyAffiliation) ||
      typeof r.electionYears !== "string" ||
      !r.electionYears
        .split(",")
        .map((s) => s.trim())
        .includes("2026") ||
      typeof r.electionTypeCodes !== "string" ||
      !r.electionTypeCodes
        .split(",")
        .map((s) => s.trim())
        .includes("GBRELEC") ||
      r.isActive !== true ||
      r.accountStatus !== "Active" ||
      r.accountStatusCode !== "FACT" ||
      r.registrationTerminatedDate !== null
    )
      throw Error();
    const sourceOwnerName = r.candidateName;
    const office =
      r.officeSought === "State Senator"
        ? "State Senator"
        : r.officeSought === "House of Delegates"
          ? "State Lower Chamber Legislator"
          : null;
    if (
      !office ||
      c.officeName !== office ||
      !nameMatches(c.candidateName, r.candidateName)
    )
      throw Error();
    // Search every active official seat first: the registry lacks a district.
    // Selecting a local district before disambiguating same-name owners would
    // turn the requested candidate into evidence of their own identity.
    const owners = roster.filter(
      (p) =>
        p.status === "Active" &&
        p.officeName === office &&
        nameMatches(p.candidateName, sourceOwnerName),
    );
    if (owners.length !== 1) throw Error();
    const owner = owners[0]!;
    if (
      owner.officeScope !== c.officeScope ||
      owner.district !== districtKey(c.districtGeoidCompact.slice(2)) ||
      !nameMatches(c.candidateName, owner.candidateName) ||
      partyKey(owner.party) !== partyKey(c.party) ||
      partyKey(owner.party) !== partyKey(r.partyAffiliation)
    )
      throw Error();
    return {
      binding: Object.freeze({
        sourceCandidateAccountGuid: String(r.filerRegistrationGuid),
        sourceCommitteeName: r.committeeName,
        sourceOwnerName,
        officeScope: owner.officeScope,
        officeName: owner.officeName,
        district: owner.district,
        electionYear: 2026,
        electionDate: date.electionDate,
      }),
      diagnostics: [],
    };
  } catch {
    return { diagnostics: ["outside_target_legislative_context_unresolved"] };
  }
}
