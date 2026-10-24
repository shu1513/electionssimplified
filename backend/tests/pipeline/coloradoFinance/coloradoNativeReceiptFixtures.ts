import type { ColoradoNativeReceiptsPacket } from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptSource.js";
import type { ColoradoSourceFacts } from "../../../src/pipeline/coloradoFinance/coloradoReportedIeSource.js";
export function receiptPacket(): ColoradoNativeReceiptsPacket {
  const receiver = {
    linkId: "00000000-0000-4000-8000-000000000001",
    candidateId: "00000000-0000-4000-8000-000000000002",
    electionId: "00000000-0000-4000-8000-000000000003",
    candidateName: "Ada Example",
    fullName: "Ada Example",
    linkCandidateName: "ADA EXAMPLE",
    party: "Democratic",
    officeName: "Governor",
    linkOffice: "Governor",
    linkSource: "manual",
    electionYear: 2026,
    electionDate: "2026-11-03",
    receivingId: "202600001",
    receivingName: "Example Campaign",
    tracerCandidateId: "202600002",
  };
  const facts = (count: number, minute: number): ColoradoSourceFacts => {
    const start = Date.parse(`2026-10-23T10:0${minute}:00.000Z`),
      originals = Array.from({ length: count }, (_, i) => ({
        file: `${String(i + 1).padStart(4, "0")}.response`,
        sha256: "a".repeat(64),
        bytes: 100,
        startedAt: new Date(start + i).toISOString(),
        completedAt: new Date(start + i + 1).toISOString(),
      }));
    return {
      packetDirectory: `packet-00000000-0000-4000-8000-${String(minute).padStart(12, "0")}`,
      observedAt: originals[0]!.startedAt,
      completedAt: originals.at(-1)!.completedAt,
      manifestSha256: "b".repeat(64),
      originals,
    };
  };
  return {
    receiver,
    identity: {
      candidateName: "Ada Example",
      party: "DEM",
      officeName: "Governor",
      candidateId: receiver.tracerCandidateId,
      receivingId: receiver.receivingId,
      cycleYear: 2026,
      cycleStart: "2022-12-09",
      cycleEnd: "2026-12-03",
    },
    groups: [
      {
        key: "EXAMPLE POLITICAL COMMITTEE",
        name: "Example Political Committee",
        cashCents: 10000,
        occurrences: 1,
      },
    ],
    controls: {
      allRows: 1,
      individualRows: 0,
      nonitemizedRows: 0,
      unmatchedRows: 0,
      committeeRows: 1,
      cashCents: 10000,
      regularReports: 1,
      coveredNotices: 0,
    },
    facts: {
      revision: "co-native-cash-v1",
      cycleStart: "2022-12-09",
      regularThrough: "2026-10-14",
      sourceThrough: "2026-10-23",
      registry: facts(219, 0),
      receipts: facts(45, 1),
    },
  };
}
export function receiptStored(p = receiptPacket()) {
  return {
    link_id: p.receiver.linkId,
    election_year: p.receiver.electionYear,
    candidate_id: p.receiver.candidateId,
    election_id: p.receiver.electionId,
    receiver_context: p.receiver,
    native_identity: p.identity,
    source_facts: p.facts,
    aggregation_controls: p.controls,
    source_observed_at: p.facts.registry.observedAt,
    source_completed_at: p.facts.receipts.completedAt,
    last_synced_at: "2026-10-23T11:00:00.000Z",
    donors: p.groups.map((g) => ({
      reported_key: g.key,
      reported_name: g.name,
      cash_cents: String(g.cashCents),
      occurrence_count: g.occurrences,
    })),
  };
}
