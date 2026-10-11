export type IndianaFinanceEligibleOfficeKey = `${string}::${string}`;

export const INDIANA_FINANCE_ELIGIBLE_OFFICE_KEYS = [
  "statewide::Governor",
  "statewide::Lieutenant Governor",
  "statewide::Secretary of State",
  "statewide::Attorney General",
  "statewide::State Treasurer",
  "statewide::State Auditor",
  // Indiana renamed the Auditor of State to Comptroller in 2023; VoteApp
  // stores the office under its current name.
  "statewide::Comptroller",
  "statewide::Superintendent of Public Instruction",
  "state_upper::State Senator",
  "state_lower::State Lower Chamber Legislator",
] as const satisfies readonly IndianaFinanceEligibleOfficeKey[];

const INDIANA_FINANCE_ELIGIBLE_OFFICE_KEY_SET = new Set<string>(
  INDIANA_FINANCE_ELIGIBLE_OFFICE_KEYS
);

export function toIndianaFinanceOfficeKey(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
}): IndianaFinanceEligibleOfficeKey | null {
  const officeScope = input.officeScope?.trim();
  const officeCanonicalName = input.officeCanonicalName?.trim();
  if (!officeScope || !officeCanonicalName) {
    return null;
  }
  return `${officeScope}::${officeCanonicalName}`;
}

export function isIndianaFinanceEligibleOffice(input: {
  officeScope: string | null | undefined;
  officeCanonicalName: string | null | undefined;
}): boolean {
  const key = toIndianaFinanceOfficeKey(input);
  return key !== null && INDIANA_FINANCE_ELIGIBLE_OFFICE_KEY_SET.has(key);
}
