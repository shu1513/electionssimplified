import type { BallotSummaryResult } from "../address/ballotLookup.js";
import { warningAffectsSupportedDistrict } from "../address/addressDistrictResolver.js";
import type { AddressResolutionResult } from "../address/addressResolverService.js";
import type { ReplaceUserDistrictsResult } from "./userDistrictReplacer.js";

export type AuthenticatedAddressDistrictUpdateResult = BallotSummaryResult & {
  matched_address: string;
  // Geocoder candidate count; above 1 means the input was ambiguous and the
  // first match was used, so the client should surface the matched address.
  address_match_count: number;
};

export type AuthenticatedAddressDistrictUpdaterDependencies = {
  resolveAddressToDistricts: (address: string) => Promise<AddressResolutionResult>;
  replaceUserDistricts: (userId: string, districtIds: readonly string[]) => Promise<ReplaceUserDistrictsResult>;
  lookupBallotSummariesByDistrictIds: (districtIds: readonly string[]) => Promise<BallotSummaryResult>;
};

export type AuthenticatedAddressDistrictUpdateErrorCode = "no_supported_districts" | "partial_district_resolution";

export class AuthenticatedAddressDistrictUpdateError extends Error {
  constructor(
    readonly code: AuthenticatedAddressDistrictUpdateErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AuthenticatedAddressDistrictUpdateError";
  }
}

export async function updateAuthenticatedAddressDistricts(
  dependencies: AuthenticatedAddressDistrictUpdaterDependencies,
  userId: string,
  address: string
): Promise<AuthenticatedAddressDistrictUpdateResult> {
  const resolved = await dependencies.resolveAddressToDistricts(address);

  // Nothing usable resolved: the address is outside supported coverage
  // (e.g. territories — the district loaders cover 50 states + DC while the
  // Census geocoder also answers for Puerto Rico). Checked first so those
  // addresses get a definitive "unsupported" instead of the retryable data-
  // gap error below, which would tell them to try again forever. Nothing is
  // replaced either way.
  const districtIds = resolved.districts.map((district) => district.id);
  if (districtIds.length === 0) {
    throw new AuthenticatedAddressDistrictUpdateError(
      "no_supported_districts",
      "Resolved address did not match any supported districts"
    );
  }

  // Something resolved but not everything: a key the districts table cannot
  // map (vintage drift after redistricting, an incomplete load), or a
  // supported district's geography that never became a key (missing GEOID,
  // MTFCC/layer conflict — those skip key emission and surface only as
  // warnings). Replacing the saved set with the partial subset would
  // silently drop valid districts — shrinking the user's ballot and
  // notifications — so refuse and leave the saved districts untouched. The
  // authenticated resolve path logs the diagnostics for the operator, and
  // the update succeeds once the districts data is repaired.
  const blockingWarnings = resolved.warnings.filter(warningAffectsSupportedDistrict);
  if (resolved.missing_district_keys.length > 0 || blockingWarnings.length > 0) {
    throw new AuthenticatedAddressDistrictUpdateError(
      "partial_district_resolution",
      "Some districts for this address are temporarily unavailable, so your saved districts were left unchanged. Try again later."
    );
  }

  await dependencies.replaceUserDistricts(userId, districtIds);
  const ballot = await dependencies.lookupBallotSummariesByDistrictIds(districtIds);
  return {
    matched_address: resolved.matched_address,
    address_match_count: resolved.address_match_count,
    ...ballot,
  };
}
