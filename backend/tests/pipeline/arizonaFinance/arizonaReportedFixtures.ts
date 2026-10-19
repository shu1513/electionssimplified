export const capturedAt = "2026-10-19T18:00:00.000Z";
/** Entirely synthetic native-shaped records; no real filing identities. */
export function nativeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { Amount: "10.0000", City: "Example City", CommitteeGroupNumber: "1", CommitteeID: "101", CommitteeName: "Example Candidate Committee",
    Employer: null, EntityDescription: null, FilerName: null, FirstName: null, LastName: "Example PAC", Memo: null, Occupation: null,
    State: "AZ", TransactionDate: `/Date(${Date.UTC(2026, 0, 2)})/`, TransactionGroupNumber: "0", TransactionName: "Example PAC",
    TransactionNameID: "0", TransactionType: "Contributions from PACs", TransactionTypeDispositionID: "1", TransactionTypeId: "115", ZipCode: "00000", ...overrides };
}
