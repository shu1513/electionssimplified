import { describe, expect, it, vi } from "vitest";

import {
  AuthenticatedAddressDistrictUpdateError,
  updateAuthenticatedAddressDistricts,
} from "../../../src/pipeline/users/userAddressDistrictUpdater.js";
import type { AddressResolutionResult } from "../../../src/pipeline/address/addressResolverService.js";

const userId = "11111111-1111-4111-8111-111111111111";
const districtId = "22222222-2222-4222-8222-222222222222";

const resolvedAddress: AddressResolutionResult = {
  matched_address: "123 MAIN ST, DENVER, CO, 80203",
  coordinates: { lat: 39.7392, lng: -104.9903 },
  address_match_count: 1,
  district_keys: [],
  districts: [
    {
      id: districtId,
      district_type: "county",
      geoid_compact: "08031",
      name: "Denver County",
      state: "CO",
      state_fips: "08",
      population: 715522,
      representation_power_score: 50.4,
    },
  ],
  missing_district_keys: [],
  warnings: [],
};

describe("updateAuthenticatedAddressDistricts", () => {
  it("resolves an address, replaces saved districts, and returns the updated ballot", async () => {
    const resolveAddressToDistricts = vi.fn().mockResolvedValue(resolvedAddress);
    const replaceUserDistricts = vi.fn().mockResolvedValue({ districtCount: 1 });
    const lookupBallotSummariesByDistrictIds = vi.fn().mockResolvedValue({
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });

    const result = await updateAuthenticatedAddressDistricts(
      { resolveAddressToDistricts, replaceUserDistricts, lookupBallotSummariesByDistrictIds },
      userId,
      "123 Main St Denver CO 80203"
    );

    expect(result).toEqual({
      matched_address: resolvedAddress.matched_address,
      address_match_count: resolvedAddress.address_match_count,
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });
    expect(resolveAddressToDistricts).toHaveBeenCalledWith("123 Main St Denver CO 80203");
    expect(replaceUserDistricts).toHaveBeenCalledWith(userId, [districtId]);
    expect(lookupBallotSummariesByDistrictIds).toHaveBeenCalledWith([districtId]);
  });

  it("refuses a partial resolution instead of replacing saved districts with the subset", async () => {
    // One district resolved, one Census key with no matching districts row
    // (vintage drift / incomplete load): saving the subset would silently
    // drop the user's still-valid districts.
    const resolveAddressToDistricts = vi.fn().mockResolvedValue({
      ...resolvedAddress,
      missing_district_keys: [{ district_type: "state_lower", geoid_compact: "08007" }],
    });
    const replaceUserDistricts = vi.fn();
    const lookupBallotSummariesByDistrictIds = vi.fn();

    await expect(
      updateAuthenticatedAddressDistricts(
        { resolveAddressToDistricts, replaceUserDistricts, lookupBallotSummariesByDistrictIds },
        userId,
        "123 Main St Denver CO 80203"
      )
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(AuthenticatedAddressDistrictUpdateError);
      expect((error as AuthenticatedAddressDistrictUpdateError).code).toBe("partial_district_resolution");
      return true;
    });

    expect(replaceUserDistricts).not.toHaveBeenCalled();
    expect(lookupBallotSummariesByDistrictIds).not.toHaveBeenCalled();
  });

  it("treats every key missing as an unsupported address, not a retryable gap", async () => {
    // Territories hit this: the Census geocoder answers for Puerto Rico but
    // the district loaders cover 50 states + DC, so every key is unmapped —
    // permanently. A retryable 503 would tell those users to try again
    // forever; 422 no_supported_districts is the honest answer.
    const resolveAddressToDistricts = vi.fn().mockResolvedValue({
      ...resolvedAddress,
      districts: [],
      missing_district_keys: [{ district_type: "county", geoid_compact: "72127" }],
    });
    const replaceUserDistricts = vi.fn();
    const lookupBallotSummariesByDistrictIds = vi.fn();

    await expect(
      updateAuthenticatedAddressDistricts(
        { resolveAddressToDistricts, replaceUserDistricts, lookupBallotSummariesByDistrictIds },
        userId,
        "123 Calle Sol San Juan PR 00901"
      )
    ).rejects.toSatisfy((error) => {
      expect((error as AuthenticatedAddressDistrictUpdateError).code).toBe("no_supported_districts");
      return true;
    });

    expect(replaceUserDistricts).not.toHaveBeenCalled();
  });

  it("refuses when a supported district was skipped with only a warning to show for it", async () => {
    // A supported district that never became a key (missing GEOID,
    // MTFCC/layer conflict) cannot appear in missing_district_keys — the
    // warning is the only trace. Without this check the saved set would be
    // replaced by the partial subset.
    const resolveAddressToDistricts = vi.fn().mockResolvedValue({
      ...resolvedAddress,
      warnings: [
        {
          layer_name: "2024 State Legislative Districts - Lower",
          mtfcc: "G5220",
          reason: "geography feature is missing GEOID",
        },
      ],
    });
    const replaceUserDistricts = vi.fn();
    const lookupBallotSummariesByDistrictIds = vi.fn();

    await expect(
      updateAuthenticatedAddressDistricts(
        { resolveAddressToDistricts, replaceUserDistricts, lookupBallotSummariesByDistrictIds },
        userId,
        "123 Main St Denver CO 80203"
      )
    ).rejects.toSatisfy((error) => {
      expect((error as AuthenticatedAddressDistrictUpdateError).code).toBe("partial_district_resolution");
      return true;
    });

    expect(replaceUserDistricts).not.toHaveBeenCalled();
  });

  it("ignores warnings from layers the app does not track", async () => {
    // layers=all makes the geocoder return every Census layer; a malformed
    // tract or block feature says nothing about the user's districts and
    // must not block the update.
    const resolveAddressToDistricts = vi.fn().mockResolvedValue({
      ...resolvedAddress,
      warnings: [{ layer_name: "Census Tracts", reason: "geography feature is missing GEOID" }],
    });
    const replaceUserDistricts = vi.fn().mockResolvedValue({ districtCount: 1 });
    const lookupBallotSummariesByDistrictIds = vi.fn().mockResolvedValue({
      district_ids: [districtId],
      districts: resolvedAddress.districts,
      elections: [],
    });

    const result = await updateAuthenticatedAddressDistricts(
      { resolveAddressToDistricts, replaceUserDistricts, lookupBallotSummariesByDistrictIds },
      userId,
      "123 Main St Denver CO 80203"
    );

    expect(result.matched_address).toBe(resolvedAddress.matched_address);
    expect(replaceUserDistricts).toHaveBeenCalledWith(userId, [districtId]);
  });

  it("does not replace saved districts when the resolved address has no supported districts", async () => {
    const resolveAddressToDistricts = vi.fn().mockResolvedValue({ ...resolvedAddress, districts: [] });
    const replaceUserDistricts = vi.fn();
    const lookupBallotSummariesByDistrictIds = vi.fn();

    await expect(
      updateAuthenticatedAddressDistricts(
        { resolveAddressToDistricts, replaceUserDistricts, lookupBallotSummariesByDistrictIds },
        userId,
        "123 Main St Denver CO 80203"
      )
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(AuthenticatedAddressDistrictUpdateError);
      expect((error as AuthenticatedAddressDistrictUpdateError).code).toBe("no_supported_districts");
      expect((error as Error).message).toBe("Resolved address did not match any supported districts");
      return true;
    });

    expect(replaceUserDistricts).not.toHaveBeenCalled();
    expect(lookupBallotSummariesByDistrictIds).not.toHaveBeenCalled();
  });
});
