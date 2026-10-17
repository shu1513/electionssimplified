import type { NorthCarolinaReportedCommitteeReceiptResult } from "./northCarolinaReportedCommitteeReceiptAggregator.js";

export type Scope = { cacheDir?: string; receivingCommitteeId: string; electionYear: number };
export type CaptureScope = Scope & { orgGroupId: number };
export type Binding =
  | { role: "inventory_open" | "inventory_close" }
  | { role: "report_cover" | "native_csv"; reportId: string }
  | { role: "receipt_page" | "expenditure_page"; reportId: string; page: number };
export type Original = Readonly<Binding & {
  ordinal: number;
  file: string;
  url: string;
  status: number;
  eof: boolean;
  byteSize: number;
  sha256: string;
  startedAt: string;
  completedAt: string;
}>;
export type Manifest = {
  version: 1;
  generation: string;
  receivingCommitteeId: string;
  electionYear: number;
  orgGroupId: number;
  sourceRetrievedAt: string;
  sourceCompletedAt: string;
  originals: readonly Original[];
};
export type Pointer = { version: 1; generation: string; manifestSha256: string };
export type Facts = {
  receivingCommitteeId: string;
  electionYear: number;
  sourceGeneration: string;
  sourceRetrievedAt: string;
  sourceCompletedAt: string;
  sourceUrl: string;
  /** All validated current-report receipt occurrences; explicit zero is valid. */
  sourceReceiptOccurrenceCount: number;
  sourceReportCount: number;
  sourceByteSize: number;
  sourceManifestSha256: string;
  sourceControls: readonly Original[];
};
export type Qualified = {
  aggregation: Extract<NorthCarolinaReportedCommitteeReceiptResult, { status: "qualified" }>;
  source: Readonly<Facts>;
};
declare const generationHandle: unique symbol;
/** Only the cache's live, exclusive lease can authorize append or publication. */
export type Generation = Readonly<{
  generation: string;
  directory: string;
  ordinaryCacheDir: string;
}> & { readonly [generationHandle]: true };
