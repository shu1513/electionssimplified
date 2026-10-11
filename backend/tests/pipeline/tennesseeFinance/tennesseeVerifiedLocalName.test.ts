import { describe, expect, it } from "vitest";
import { resolveTennesseeLocalNameAuthority, tennesseeCandidateSearchToken } from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedLocalName.js";
import type { TennesseeFinanceLinkInput } from "../../../src/pipeline/tennesseeFinance/tennesseeFinanceWriter.js";

const link: TennesseeFinanceLinkInput = {
  candidateId:"b13cdb24-792f-4f80-8231-64e83fe9118d", electionId:"46bbb4ea-0d82-47a3-b62c-8e861a465e58",
  campCandidateId:"794", electionYear:2026, officeName:"State Senator", district:"03",
  candidateNameNormalized:'DEWEY "RUSTY" CROWE',ownerName:"CROWE, RUSTY",linkSource:"tncamp_search",
};
describe("Tennessee finite local name authority", () => {
  it("derives acquisition token without changing identity rules", () => {
    expect(tennesseeCandidateSearchToken("CROWE, RUSTY")).toBe("CROWE");
    expect(tennesseeCandidateSearchToken("Full Owner Name")).toBe("Full Owner Name");
    expect(tennesseeCandidateSearchToken("One, Two, Three")).toBe("One, Two, Three");
    expect(resolveTennesseeLocalNameAuthority({...link,candidateNameNormalized:"Rusty Crowe"},"Crowe")).toBeUndefined();
  });
  it("accepts full names including comma order without inferring nicknames", () => {
    expect(resolveTennesseeLocalNameAuthority({...link,candidateNameNormalized:"Jane Doe"}," DOE, JANE ")?.method).toBe("exact_full_name");
    expect(resolveTennesseeLocalNameAuthority({...link,candidateNameNormalized:"Jane Ann Doe"},"Jane Doe")).toBeUndefined();
    expect(resolveTennesseeLocalNameAuthority({...link,candidateNameNormalized:"William Doe"},"Bill Doe")).toBeUndefined();
  });
  it.each(['DEWEY "RUSTY" CROWE',"Dewey “Rusty” Crowe","DEWEY RUSTY CROWE"])("binds reviewed Crowe form %s to official sources", name => {
    const authority = resolveTennesseeLocalNameAuthority({...link,candidateNameNormalized:name},"CROWE, RUSTY");
    expect(authority).toMatchObject({method:"reviewed_official_name_equivalence",ruleId:"tn-2026-crowe-official-name",
      candidateId:link.candidateId,campCandidateId:"794",electionYear:2026,district:"3",localName:name});
    expect(authority?.sourceUrls).toHaveLength(3);
  });
  it.each([
    {candidateId:"11111111-1111-4111-8111-111111111111"},{campCandidateId:"795"},{electionYear:2028},
    {officeName:"State Representative"},{district:"4"},{candidateNameNormalized:"Dewey Crowe"},
  ])("rejects scope/name changes %j", override => {
    expect(resolveTennesseeLocalNameAuthority({...link,...override},"Rusty Crowe")).toBeUndefined();
  });
  it("rejects another source target", () => {
    expect(resolveTennesseeLocalNameAuthority(link,"Rusty E Crowe")).toBeUndefined();
  });
});
