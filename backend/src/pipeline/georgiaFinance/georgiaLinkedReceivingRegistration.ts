import {
  fetchGeorgiaCandidateIndexRows,
  GeorgiaEthicsClientError,
  type GeorgiaCandidateIndexRow,
  type GeorgiaEthicsTransport,
} from "./georgiaEthicsClient.js";
import {
  georgiaCandidateIndexRowMatchesElectionYear,
  georgiaLastNameSearchToken,
} from "./georgiaCandidateCommitteeResolver.js";

// The linked receiver and native cycle are shared with the legacy direct
// sync. Direct cover totals/report sweeps are deliberately not prerequisites
// for the independent reported components.
export type GeorgiaLinkedReceivingRegistration = {
  receivingCommitteeId: string;
  registrationGuid: string;
};
export type GeorgiaLinkedReceivingRegistrationResult =
  | { status: "qualified"; context: GeorgiaLinkedReceivingRegistration }
  | { status: "held"; reason: "invalid_receiving_identity" | "missing_or_ambiguous_receiving_registration" }
  | { status: "unavailable"; reason: "receiving_index_unavailable" };

export function selectGeorgiaLinkedReceivingRegistration(input: {
  committeeId: string;
  electionYear: number;
  rows: readonly GeorgiaCandidateIndexRow[];
}): GeorgiaLinkedReceivingRegistrationResult {
  if (!/^[1-9]\d*$/.test(input.committeeId) || !Number.isSafeInteger(Number(input.committeeId))) {
    return { status: "held", reason: "invalid_receiving_identity" };
  }
  const rows = input.rows.filter(row => row.filerEntityId === Number(input.committeeId) &&
    georgiaCandidateIndexRowMatchesElectionYear(row, input.electionYear));
  if (rows.length !== 1 || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(rows[0]!.guid.trim())) {
    return { status: "held", reason: "missing_or_ambiguous_receiving_registration" };
  }
  return { status: "qualified", context: { receivingCommitteeId: input.committeeId,
    registrationGuid: rows[0]!.guid.trim().toLowerCase() } };
}

export async function fetchGeorgiaLinkedReceivingRegistration(input: {
  transport: GeorgiaEthicsTransport;
  candidateName: string;
  committeeId: string;
  electionYear: number;
}): Promise<GeorgiaLinkedReceivingRegistrationResult> {
  try {
    const rows = await fetchGeorgiaCandidateIndexRows(input.transport, "peachfile", {
      filerName: georgiaLastNameSearchToken(input.candidateName),
    });
    return selectGeorgiaLinkedReceivingRegistration({ ...input, rows });
  } catch (error) {
    if (error instanceof GeorgiaEthicsClientError) return { status: "unavailable", reason: "receiving_index_unavailable" };
    throw error;
  }
}
