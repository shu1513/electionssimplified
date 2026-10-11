import type { TennesseeFinanceLinkInput } from "./tennesseeFinanceWriter.js";

export function normalizeTennesseeFullPersonName(value: string): string {
  const trimmed = value.replace(/\s+/g," ").trim();
  const parts = trimmed.split(",");
  return (parts.length === 2 ? `${parts[1]!.trim()} ${parts[0]!.trim()}` : trimmed).toUpperCase();
}

/** Public search accepts surname tokens; results still require exact full ownership. */
export function tennesseeCandidateSearchToken(ownerName: string): string {
  const parts=ownerName.split(",");
  return (parts.length===2 && parts.every(part=>part.trim()) ? parts[0]! : ownerName).replace(/\s+/g," ").trim();
}

export type TennesseeLocalNameAuthority = {
  method: "exact_full_name" | "reviewed_official_name_equivalence";
  localName: string;
  sourceName: string;
  ruleId?: string;
  candidateId?: string;
  campCandidateId?: string;
  electionYear?: number;
  officeName?: string;
  district?: string;
  sourceUrls?: readonly string[];
};

/** Finite reviewed identity evidence; no generic nickname/suffix inference. */
export function resolveTennesseeLocalNameAuthority(link: TennesseeFinanceLinkInput, sourceName: string): TennesseeLocalNameAuthority | undefined {
  const local = normalizeTennesseeFullPersonName(link.candidateNameNormalized);
  const source = normalizeTennesseeFullPersonName(sourceName);
  if (local === source) return { method: "exact_full_name",localName: link.candidateNameNormalized,sourceName };
  // The SOS Blue Book names Dewey “Rusty” Crowe, District3; the current official
  // Senate directory names Rusty Crowe, District3. Indexed PDF text was reviewed;
  // a blocked PDF download is not represented as acquired source bytes.
  if (link.candidateId !== "b13cdb24-792f-4f80-8231-64e83fe9118d" || link.campCandidateId !== "794"
    || link.electionYear !== 2026 || link.officeName !== "State Senator" || !/^0*3$/.test(link.district ?? "")
    || source !== "RUSTY CROWE" || !["DEWEY RUSTY CROWE",'DEWEY "RUSTY" CROWE',"DEWEY “RUSTY” CROWE"].includes(local)) return undefined;
  return { method: "reviewed_official_name_equivalence",localName: link.candidateNameNormalized,sourceName,
    ruleId: "tn-2026-crowe-official-name",candidateId: link.candidateId,campCandidateId: "794",electionYear: 2026,
    officeName: "State Senator",district: "3",sourceUrls: [
      "https://publications.tnsosfiles.com/pub/blue_book/19-20/19-20legislative.pdf",
      "https://www.capitol.tn.gov/Archives/Senate/106GA/publications/ChamberBook106.pdf",
      "https://wapp.capitol.tn.gov/apps/LegislatorInfo/member?district=s3",
    ] };
}
