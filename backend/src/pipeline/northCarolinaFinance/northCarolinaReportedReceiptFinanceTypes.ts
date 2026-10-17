import type { NorthCarolinaCandidateFinanceDueRow } from "./northCarolinaCandidateFinanceBatchSync.js";
import type { Qualified } from "./northCarolinaReportedReceiptSourceTypes.js";

/** Current canonical receiving context, never a source or eligibility override. */
export type NorthCarolinaReportedReceiptFinanceReceiver = NorthCarolinaCandidateFinanceDueRow & {
  linkId: string;
  electionDate: string;
};
export type NorthCarolinaReportedReceiptFinanceComponent = {
  receiver: NorthCarolinaReportedReceiptFinanceReceiver;
  packet: Qualified;
};
