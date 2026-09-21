import { readBooleanEnv } from "./envReaders.js";

export type StateFinanceFlagPair = {
  /** Master flag `<prefix>_ENABLED`; off hides the source everywhere. */
  isEnabled: () => boolean;
  /** Recurring-sync flag `<prefix>_SYNC_ENABLED`; `force` skips it but never the master flag. */
  isSyncEnabled: (force?: boolean) => boolean;
  /** Extra gate under the same master flag (raw refresh, browser export), keyed by its explicit env name. */
  gate: (envName: string) => (force?: boolean) => boolean;
};

/**
 * The uniform state/city finance flag pair. Every reader consults process.env
 * at call time, so nothing is cached here. Short-circuit order is kept: a
 * sub-gate never reads its own env key while the master flag is off, and an
 * invalid boolean value still throws from readBooleanEnv.
 */
export function defineStateFinanceFlagPair(prefix: string): StateFinanceFlagPair {
  const isEnabled = (): boolean => readBooleanEnv(`${prefix}_ENABLED`, false);
  const gate =
    (envName: string) =>
    (force = false): boolean =>
      isEnabled() && (force || readBooleanEnv(envName, false));
  return { isEnabled, isSyncEnabled: gate(`${prefix}_SYNC_ENABLED`), gate };
}

export function isPresidentialElectionsEnabled(): boolean {
  return readBooleanEnv("PRESIDENTIAL_ELECTIONS_ENABLED", true);
}

export function isPresidentialFeatureEnabled(featureEnvName: string, force = false): boolean {
  return isPresidentialElectionsEnabled() && (force || readBooleanEnv(featureEnvName, false));
}

export function isAutoDistrictResearchEnabled(): boolean {
  return readBooleanEnv("AUTO_DISTRICT_RESEARCH_ENABLED", false);
}

export type AutoDistrictResearchMode = "off" | "ai" | "manual";

/**
 * Which auto district research behavior fires when an address lookup resolves
 * stale districts. Exactly one is active so the AI pipeline and the manual
 * agent queue never both enqueue the same district.
 *
 *   - "ai": drop an election draft into the staging pipeline (PR #169).
 *   - "manual": enqueue a manual research request for an agent to claim.
 *   - "off": no auto research.
 *
 * AUTO_DISTRICT_RESEARCH_MODE is authoritative. When it is unset, the legacy
 * boolean AUTO_DISTRICT_RESEARCH_ENABLED=true maps to "ai" for backward
 * compatibility; otherwise the default is "manual" — enqueueing is
 * Postgres-only, deduped, and fire-and-forget, so it is safe on by default
 * (even against a database missing the queue table, the enqueue just warns).
 * Turn the feature off with AUTO_DISTRICT_RESEARCH_MODE=off in backend/.env.
 * Setting a mode that conflicts with the legacy boolean is an error so a
 * stale boolean cannot silently override an explicit mode.
 */
export function readAutoDistrictResearchMode(): AutoDistrictResearchMode {
  const raw = process.env.AUTO_DISTRICT_RESEARCH_MODE;
  const legacyEnabled = isAutoDistrictResearchEnabled();

  if (raw && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    if (normalized !== "off" && normalized !== "ai" && normalized !== "manual") {
      throw new Error(`Invalid AUTO_DISTRICT_RESEARCH_MODE: ${raw}. Expected one of off, ai, manual.`);
    }
    if (legacyEnabled && normalized !== "ai") {
      throw new Error(
        `Conflicting config: AUTO_DISTRICT_RESEARCH_MODE=${normalized} with AUTO_DISTRICT_RESEARCH_ENABLED=true. ` +
          "Set only AUTO_DISTRICT_RESEARCH_MODE."
      );
    }
    return normalized;
  }

  return legacyEnabled ? "ai" : "manual";
}

export function isCandidateFinanceEnabled(): boolean {
  return readBooleanEnv("CANDIDATE_FINANCE_ENABLED", false);
}

// Read-side only: the "Stock Trades" panel reads imported rows from the
// database. No external calls, no cost.
export function isCandidateStockTradesEnabled(): boolean {
  return readBooleanEnv("CANDIDATE_STOCK_TRADES_ENABLED", false);
}

export function isCandidateFinanceSyncEnabled(force = false): boolean {
  return isCandidateFinanceEnabled() && (force || readBooleanEnv("CANDIDATE_FINANCE_SYNC_ENABLED", false));
}

const arizonaFinance = defineStateFinanceFlagPair("ARIZONA_CAMPAIGN_FINANCE");
export const isArizonaCampaignFinanceEnabled = arizonaFinance.isEnabled;
export const isArizonaCampaignFinanceSyncEnabled = arizonaFinance.isSyncEnabled;

const californiaFinance = defineStateFinanceFlagPair("CALIFORNIA_CAMPAIGN_FINANCE");
export const isCaliforniaCampaignFinanceEnabled = californiaFinance.isEnabled;
export const isCaliforniaCampaignFinanceSyncEnabled = californiaFinance.isSyncEnabled;
export const isCaliforniaCampaignFinanceRawDataRefreshEnabled = californiaFinance.gate(
  "CALIFORNIA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const alaskaFinance = defineStateFinanceFlagPair("ALASKA_CAMPAIGN_FINANCE");
export const isAlaskaCampaignFinanceEnabled = alaskaFinance.isEnabled;
export const isAlaskaCampaignFinanceSyncEnabled = alaskaFinance.isSyncEnabled;

const coloradoFinance = defineStateFinanceFlagPair("COLORADO_CAMPAIGN_FINANCE");
export const isColoradoCampaignFinanceEnabled = coloradoFinance.isEnabled;
export const isColoradoCampaignFinanceSyncEnabled = coloradoFinance.isSyncEnabled;
export const isColoradoTracerRawDataRefreshEnabled = coloradoFinance.gate("COLORADO_TRACER_RAW_DATA_REFRESH_ENABLED");

// Denver municipal finance (SearchLight) is its own module — Denver filers
// are not in state TRACER, so these are independent of the Colorado flags.
const denverFinance = defineStateFinanceFlagPair("DENVER_CAMPAIGN_FINANCE");
export const isDenverCampaignFinanceEnabled = denverFinance.isEnabled;
export const isDenverCampaignFinanceSyncEnabled = denverFinance.isSyncEnabled;

// Austin municipal finance (City Clerk Socrata datasets) is its own module —
// Austin filers are not in state TEC, so these are independent of the Texas
// and Houston flags.
const austinFinance = defineStateFinanceFlagPair("AUSTIN_CAMPAIGN_FINANCE");
export const isAustinCampaignFinanceEnabled = austinFinance.isEnabled;
export const isAustinCampaignFinanceSyncEnabled = austinFinance.isSyncEnabled;

const connecticutFinance = defineStateFinanceFlagPair("CONNECTICUT_CAMPAIGN_FINANCE");
export const isConnecticutCampaignFinanceEnabled = connecticutFinance.isEnabled;
export const isConnecticutCampaignFinanceSyncEnabled = connecticutFinance.isSyncEnabled;
export const isConnecticutEcrisRawDataRefreshEnabled = connecticutFinance.gate(
  "CONNECTICUT_ECRIS_RAW_DATA_REFRESH_ENABLED"
);

const nebraskaFinance = defineStateFinanceFlagPair("NEBRASKA_CAMPAIGN_FINANCE");
export const isNebraskaCampaignFinanceEnabled = nebraskaFinance.isEnabled;
export const isNebraskaCampaignFinanceSyncEnabled = nebraskaFinance.isSyncEnabled;
export const isNebraskaNadcRawDataRefreshEnabled = nebraskaFinance.gate("NEBRASKA_NADC_RAW_DATA_REFRESH_ENABLED");

const indianaFinance = defineStateFinanceFlagPair("INDIANA_CAMPAIGN_FINANCE");
export const isIndianaCampaignFinanceEnabled = indianaFinance.isEnabled;
export const isIndianaCampaignFinanceSyncEnabled = indianaFinance.isSyncEnabled;
export const isIndianaCampaignFinanceRawDataRefreshEnabled = indianaFinance.gate(
  "INDIANA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const newMexicoFinance = defineStateFinanceFlagPair("NEW_MEXICO_CAMPAIGN_FINANCE");
export const isNewMexicoCampaignFinanceEnabled = newMexicoFinance.isEnabled;
export const isNewMexicoCampaignFinanceSyncEnabled = newMexicoFinance.isSyncEnabled;

const newJerseyFinance = defineStateFinanceFlagPair("NEW_JERSEY_CAMPAIGN_FINANCE");
export const isNewJerseyCampaignFinanceEnabled = newJerseyFinance.isEnabled;
export const isNewJerseyCampaignFinanceSyncEnabled = newJerseyFinance.isSyncEnabled;

export const isNewMexicoCfisRawDataRefreshEnabled = newMexicoFinance.gate("NEW_MEXICO_CFIS_RAW_DATA_REFRESH_ENABLED");

export function isNewHampshireCampaignFinanceEnabled(): boolean {
  return readBooleanEnv("NEW_HAMPSHIRE_CAMPAIGN_FINANCE_ENABLED", false);
}

export function isNevadaCampaignFinanceEnabled(): boolean {
  return readBooleanEnv("NEVADA_CAMPAIGN_FINANCE_ENABLED", false);
}

const delawareFinance = defineStateFinanceFlagPair("DELAWARE_CAMPAIGN_FINANCE");
export const isDelawareCampaignFinanceEnabled = delawareFinance.isEnabled;
export const isDelawareCampaignFinanceSyncEnabled = delawareFinance.isSyncEnabled;
export const isDelawareCampaignFinanceRawDataRefreshEnabled = delawareFinance.gate(
  "DELAWARE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const southCarolinaFinance = defineStateFinanceFlagPair("SOUTH_CAROLINA_CAMPAIGN_FINANCE");
export const isSouthCarolinaCampaignFinanceEnabled = southCarolinaFinance.isEnabled;
export const isSouthCarolinaCampaignFinanceSyncEnabled = southCarolinaFinance.isSyncEnabled;

export function isNewHampshireCfsRawDataRefreshEnabled(force = false): boolean {
  return (
    isNewHampshireCampaignFinanceEnabled() &&
    (force || readBooleanEnv("NEW_HAMPSHIRE_CFS_RAW_DATA_REFRESH_ENABLED", false))
  );
}

export function isNorthDakotaCampaignFinanceEnabled(): boolean {
  return readBooleanEnv("NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED", false);
}

// Gates every live CFRS portal call (registry fetch for auto-link, bulk file
// refresh). v1 has no recurring sync, so there is deliberately no sync flag.
export function isNorthDakotaCfrsRawDataRefreshEnabled(force = false): boolean {
  return (
    isNorthDakotaCampaignFinanceEnabled() &&
    (force || readBooleanEnv("NORTH_DAKOTA_CFRS_RAW_DATA_REFRESH_ENABLED", false))
  );
}

const marylandFinance = defineStateFinanceFlagPair("MARYLAND_CAMPAIGN_FINANCE");
export const isMarylandCampaignFinanceEnabled = marylandFinance.isEnabled;
export const isMarylandCampaignFinanceSyncEnabled = marylandFinance.isSyncEnabled;

const missouriFinance = defineStateFinanceFlagPair("MISSOURI_CAMPAIGN_FINANCE");
export const isMissouriCampaignFinanceEnabled = missouriFinance.isEnabled;
export const isMissouriCampaignFinanceSyncEnabled = missouriFinance.isSyncEnabled;
export const isMissouriCampaignFinanceRawDataRefreshEnabled = missouriFinance.gate(
  "MISSOURI_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const montanaFinance = defineStateFinanceFlagPair("MONTANA_CAMPAIGN_FINANCE");
export const isMontanaCampaignFinanceEnabled = montanaFinance.isEnabled;
export const isMontanaCampaignFinanceSyncEnabled = montanaFinance.isSyncEnabled;
export const isMontanaCampaignFinanceRawDataRefreshEnabled = montanaFinance.gate(
  "MONTANA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const alabamaFinance = defineStateFinanceFlagPair("ALABAMA_CAMPAIGN_FINANCE");
export const isAlabamaCampaignFinanceEnabled = alabamaFinance.isEnabled;
export const isAlabamaCampaignFinanceSyncEnabled = alabamaFinance.isSyncEnabled;
export const isAlabamaFcpaRawDataRefreshEnabled = alabamaFinance.gate("ALABAMA_FCPA_RAW_DATA_REFRESH_ENABLED");

const arkansasFinance = defineStateFinanceFlagPair("ARKANSAS_CAMPAIGN_FINANCE");
export const isArkansasCampaignFinanceEnabled = arkansasFinance.isEnabled;
export const isArkansasCampaignFinanceSyncEnabled = arkansasFinance.isSyncEnabled;

const kansasFinance = defineStateFinanceFlagPair("KANSAS_CAMPAIGN_FINANCE");
export const isKansasCampaignFinanceEnabled = kansasFinance.isEnabled;
export const isKansasCampaignFinanceSyncEnabled = kansasFinance.isSyncEnabled;

const idahoFinance = defineStateFinanceFlagPair("IDAHO_CAMPAIGN_FINANCE");
export const isIdahoCampaignFinanceEnabled = idahoFinance.isEnabled;
export const isIdahoCampaignFinanceSyncEnabled = idahoFinance.isSyncEnabled;
export const isIdahoCampaignFinanceRawDataRefreshEnabled = idahoFinance.gate(
  "IDAHO_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const westVirginiaFinance = defineStateFinanceFlagPair("WEST_VIRGINIA_CAMPAIGN_FINANCE");
export const isWestVirginiaCampaignFinanceEnabled = westVirginiaFinance.isEnabled;
export const isWestVirginiaCampaignFinanceSyncEnabled = westVirginiaFinance.isSyncEnabled;
export const isWestVirginiaCampaignFinanceRawDataRefreshEnabled = westVirginiaFinance.gate(
  "WEST_VIRGINIA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

export const isMarylandCfsRawDataRefreshEnabled = marylandFinance.gate("MARYLAND_CFS_RAW_DATA_REFRESH_ENABLED");

const ohioFinance = defineStateFinanceFlagPair("OHIO_CAMPAIGN_FINANCE");
export const isOhioCampaignFinanceEnabled = ohioFinance.isEnabled;
export const isOhioCampaignFinanceSyncEnabled = ohioFinance.isSyncEnabled;
export const isOhioSosRawDataRefreshEnabled = ohioFinance.gate("OHIO_SOS_RAW_DATA_REFRESH_ENABLED");

const northCarolinaFinance = defineStateFinanceFlagPair("NORTH_CAROLINA_CAMPAIGN_FINANCE");
export const isNorthCarolinaCampaignFinanceEnabled = northCarolinaFinance.isEnabled;
export const isNorthCarolinaCampaignFinanceSyncEnabled = northCarolinaFinance.isSyncEnabled;
export const isNorthCarolinaNcsbeRawDataRefreshEnabled = northCarolinaFinance.gate(
  "NORTH_CAROLINA_NCSBE_RAW_DATA_REFRESH_ENABLED"
);

const georgiaFinance = defineStateFinanceFlagPair("GEORGIA_CAMPAIGN_FINANCE");
export const isGeorgiaCampaignFinanceEnabled = georgiaFinance.isEnabled;
export const isGeorgiaCampaignFinanceSyncEnabled = georgiaFinance.isSyncEnabled;
export const isGeorgiaEthicsRawDataRefreshEnabled = georgiaFinance.gate("GEORGIA_ETHICS_RAW_DATA_REFRESH_ENABLED");

const maineFinance = defineStateFinanceFlagPair("MAINE_CAMPAIGN_FINANCE");
export const isMaineCampaignFinanceEnabled = maineFinance.isEnabled;
export const isMaineCampaignFinanceSyncEnabled = maineFinance.isSyncEnabled;
export const isMaineCfisRawDataRefreshEnabled = maineFinance.gate("MAINE_CFIS_RAW_DATA_REFRESH_ENABLED");

const oklahomaFinance = defineStateFinanceFlagPair("OKLAHOMA_CAMPAIGN_FINANCE");
export const isOklahomaCampaignFinanceEnabled = oklahomaFinance.isEnabled;
export const isOklahomaCampaignFinanceSyncEnabled = oklahomaFinance.isSyncEnabled;
export const isOklahomaGuardianRawDataRefreshEnabled = oklahomaFinance.gate(
  "OKLAHOMA_GUARDIAN_RAW_DATA_REFRESH_ENABLED"
);

const texasFinance = defineStateFinanceFlagPair("TEXAS_CAMPAIGN_FINANCE");
export const isTexasCampaignFinanceEnabled = texasFinance.isEnabled;
export const isTexasCampaignFinanceSyncEnabled = texasFinance.isSyncEnabled;

const houstonFinance = defineStateFinanceFlagPair("HOUSTON_CAMPAIGN_FINANCE");
export const isHoustonCampaignFinanceEnabled = houstonFinance.isEnabled;
export const isHoustonCampaignFinanceSyncEnabled = houstonFinance.isSyncEnabled;

const tennesseeFinance = defineStateFinanceFlagPair("TENNESSEE_CAMPAIGN_FINANCE");
export const isTennesseeCampaignFinanceEnabled = tennesseeFinance.isEnabled;
export const isTennesseeCampaignFinanceSyncEnabled = tennesseeFinance.isSyncEnabled;

export const isTexasTecRawDataRefreshEnabled = texasFinance.gate("TEXAS_TEC_RAW_DATA_REFRESH_ENABLED");

const floridaFinance = defineStateFinanceFlagPair("FLORIDA_CAMPAIGN_FINANCE");
export const isFloridaCampaignFinanceEnabled = floridaFinance.isEnabled;
export const isFloridaCampaignFinanceSyncEnabled = floridaFinance.isSyncEnabled;
export const isFloridaCampaignFinanceBrowserExportEnabled = floridaFinance.gate(
  "FLORIDA_CAMPAIGN_FINANCE_BROWSER_EXPORT_ENABLED"
);

const washingtonFinance = defineStateFinanceFlagPair("WASHINGTON_CAMPAIGN_FINANCE");
export const isWashingtonCampaignFinanceEnabled = washingtonFinance.isEnabled;
export const isWashingtonCampaignFinanceSyncEnabled = washingtonFinance.isSyncEnabled;

const newYorkFinance = defineStateFinanceFlagPair("NEW_YORK_CAMPAIGN_FINANCE");
export const isNewYorkCampaignFinanceEnabled = newYorkFinance.isEnabled;
export const isNewYorkCampaignFinanceSyncEnabled = newYorkFinance.isSyncEnabled;

const newYorkCityFinance = defineStateFinanceFlagPair("NEW_YORK_CITY_CAMPAIGN_FINANCE");
export const isNewYorkCityCampaignFinanceEnabled = newYorkCityFinance.isEnabled;
export const isNewYorkCityCampaignFinanceSyncEnabled = newYorkCityFinance.isSyncEnabled;

const losAngelesCityFinance = defineStateFinanceFlagPair("LOS_ANGELES_CITY_CAMPAIGN_FINANCE");
export const isLosAngelesCityCampaignFinanceEnabled = losAngelesCityFinance.isEnabled;
export const isLosAngelesCityCampaignFinanceSyncEnabled = losAngelesCityFinance.isSyncEnabled;

const phoenixFinance = defineStateFinanceFlagPair("PHOENIX_CAMPAIGN_FINANCE");
export const isPhoenixCampaignFinanceEnabled = phoenixFinance.isEnabled;
export const isPhoenixCampaignFinanceSyncEnabled = phoenixFinance.isSyncEnabled;

const sanFranciscoFinance = defineStateFinanceFlagPair("SAN_FRANCISCO_CAMPAIGN_FINANCE");
export const isSanFranciscoCampaignFinanceEnabled = sanFranciscoFinance.isEnabled;
export const isSanFranciscoCampaignFinanceSyncEnabled = sanFranciscoFinance.isSyncEnabled;

const sanDiegoFinance = defineStateFinanceFlagPair("SAN_DIEGO_CAMPAIGN_FINANCE");
export const isSanDiegoCampaignFinanceEnabled = sanDiegoFinance.isEnabled;
export const isSanDiegoCampaignFinanceSyncEnabled = sanDiegoFinance.isSyncEnabled;
export const isSanDiegoCampaignFinanceRawDataRefreshEnabled = sanDiegoFinance.gate(
  "SAN_DIEGO_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const sanJoseFinance = defineStateFinanceFlagPair("SAN_JOSE_CAMPAIGN_FINANCE");
export const isSanJoseCampaignFinanceEnabled = sanJoseFinance.isEnabled;
export const isSanJoseCampaignFinanceSyncEnabled = sanJoseFinance.isSyncEnabled;
export const isSanJoseCampaignFinanceRawDataRefreshEnabled = sanJoseFinance.gate(
  "SAN_JOSE_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const hawaiiFinance = defineStateFinanceFlagPair("HAWAII_CAMPAIGN_FINANCE");
export const isHawaiiCampaignFinanceEnabled = hawaiiFinance.isEnabled;
export const isHawaiiCampaignFinanceSyncEnabled = hawaiiFinance.isSyncEnabled;

const districtOfColumbiaFinance = defineStateFinanceFlagPair("DISTRICT_OF_COLUMBIA_CAMPAIGN_FINANCE");
export const isDistrictOfColumbiaCampaignFinanceEnabled = districtOfColumbiaFinance.isEnabled;
export const isDistrictOfColumbiaCampaignFinanceSyncEnabled = districtOfColumbiaFinance.isSyncEnabled;

const illinoisFinance = defineStateFinanceFlagPair("ILLINOIS_CAMPAIGN_FINANCE");
export const isIllinoisCampaignFinanceEnabled = illinoisFinance.isEnabled;
export const isIllinoisCampaignFinanceSyncEnabled = illinoisFinance.isSyncEnabled;

const kentuckyFinance = defineStateFinanceFlagPair("KENTUCKY_CAMPAIGN_FINANCE");
export const isKentuckyCampaignFinanceEnabled = kentuckyFinance.isEnabled;
export const isKentuckyCampaignFinanceSyncEnabled = kentuckyFinance.isSyncEnabled;

const virginiaFinance = defineStateFinanceFlagPair("VIRGINIA_CAMPAIGN_FINANCE");
export const isVirginiaCampaignFinanceEnabled = virginiaFinance.isEnabled;
export const isVirginiaCampaignFinanceSyncEnabled = virginiaFinance.isSyncEnabled;

const wisconsinFinance = defineStateFinanceFlagPair("WISCONSIN_CAMPAIGN_FINANCE");
export const isWisconsinCampaignFinanceEnabled = wisconsinFinance.isEnabled;
export const isWisconsinCampaignFinanceSyncEnabled = wisconsinFinance.isSyncEnabled;

const utahFinance = defineStateFinanceFlagPair("UTAH_CAMPAIGN_FINANCE");
export const isUtahCampaignFinanceEnabled = utahFinance.isEnabled;
export const isUtahCampaignFinanceSyncEnabled = utahFinance.isSyncEnabled;

const massachusettsFinance = defineStateFinanceFlagPair("MASSACHUSETTS_CAMPAIGN_FINANCE");
export const isMassachusettsCampaignFinanceEnabled = massachusettsFinance.isEnabled;
export const isMassachusettsCampaignFinanceSyncEnabled = massachusettsFinance.isSyncEnabled;

const vermontFinance = defineStateFinanceFlagPair("VERMONT_CAMPAIGN_FINANCE");
export const isVermontCampaignFinanceEnabled = vermontFinance.isEnabled;
export const isVermontCampaignFinanceSyncEnabled = vermontFinance.isSyncEnabled;

const louisianaFinance = defineStateFinanceFlagPair("LOUISIANA_CAMPAIGN_FINANCE");
export const isLouisianaCampaignFinanceEnabled = louisianaFinance.isEnabled;
export const isLouisianaCampaignFinanceSyncEnabled = louisianaFinance.isSyncEnabled;
export const isLouisianaCampaignFinanceRawDataRefreshEnabled = louisianaFinance.gate(
  "LOUISIANA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const michiganFinance = defineStateFinanceFlagPair("MICHIGAN_CAMPAIGN_FINANCE");
export const isMichiganCampaignFinanceEnabled = michiganFinance.isEnabled;
export const isMichiganCampaignFinanceSyncEnabled = michiganFinance.isSyncEnabled;
export const isMichiganMitnRawDataRefreshEnabled = michiganFinance.gate("MICHIGAN_MITN_RAW_DATA_REFRESH_ENABLED");

const minnesotaFinance = defineStateFinanceFlagPair("MINNESOTA_CAMPAIGN_FINANCE");
export const isMinnesotaCampaignFinanceEnabled = minnesotaFinance.isEnabled;
export const isMinnesotaCampaignFinanceSyncEnabled = minnesotaFinance.isSyncEnabled;
export const isMinnesotaCampaignFinanceRawDataRefreshEnabled = minnesotaFinance.gate(
  "MINNESOTA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const pennsylvaniaFinance = defineStateFinanceFlagPair("PENNSYLVANIA_CAMPAIGN_FINANCE");
export const isPennsylvaniaCampaignFinanceEnabled = pennsylvaniaFinance.isEnabled;
export const isPennsylvaniaCampaignFinanceSyncEnabled = pennsylvaniaFinance.isSyncEnabled;
export const isPennsylvaniaCampaignFinanceRawDataRefreshEnabled = pennsylvaniaFinance.gate(
  "PENNSYLVANIA_CAMPAIGN_FINANCE_RAW_DATA_REFRESH_ENABLED"
);

const oregonFinance = defineStateFinanceFlagPair("OREGON_CAMPAIGN_FINANCE");
export const isOregonCampaignFinanceEnabled = oregonFinance.isEnabled;
export const isOregonCampaignFinanceSyncEnabled = oregonFinance.isSyncEnabled;

const rhodeIslandFinance = defineStateFinanceFlagPair("RHODE_ISLAND_CAMPAIGN_FINANCE");
export const isRhodeIslandCampaignFinanceEnabled = rhodeIslandFinance.isEnabled;
export const isRhodeIslandCampaignFinanceSyncEnabled = rhodeIslandFinance.isSyncEnabled;
export const isRhodeIslandErtsRawDataRefreshEnabled = rhodeIslandFinance.gate(
  "RHODE_ISLAND_ERTS_RAW_DATA_REFRESH_ENABLED"
);