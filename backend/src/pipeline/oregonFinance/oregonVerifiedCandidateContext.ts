/** Exact local-office projection onto the published ORESTAR election office line. */
export function oregonVerifiedCandidateOfficeLine(context: {
  officeName: string;
  district: string | null;
}): string | null {
  const offices: Readonly<Record<string, string>> = {
    Governor: "Governor",
    "Secretary of State": "Secretary of State",
    "Attorney General": "Attorney General",
    "State Treasurer": "State Treasurer",
    "State Senator": "State Senator",
    "State Lower Chamber Legislator": "State Representative",
    "State Representative": "State Representative",
  };
  const office = Object.hasOwn(offices, context.officeName) ? offices[context.officeName] : undefined;
  if (!office) return null;
  if (office !== "State Representative" && office !== "State Senator") {
    return context.district === null ? office : null;
  }
  if (typeof context.district !== "string" || !/^[1-9]\d*$/.test(context.district)) return null;
  const district = Number(context.district);
  if (!Number.isSafeInteger(district)) return null;
  const finalDigit = district % 10;
  const suffix = district % 100 >= 11 && district % 100 <= 13
    ? "th"
    : finalDigit === 1 ? "st" : finalDigit === 2 ? "nd" : finalDigit === 3 ? "rd" : "th";
  return `${office}, ${district}${suffix} District`;
}
