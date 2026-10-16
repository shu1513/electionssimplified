import type { GeorgiaCandidateFinanceDueRow } from "./georgiaCandidateFinanceDueList.js";
import type { GeorgiaLinkedReceivingRegistration } from "./georgiaLinkedReceivingRegistration.js";
import type { GeorgiaReportedSourceFacts } from "./georgiaReportedFinanceSourceCache.js";
import type { GeorgiaReportedCommitteeAggregation, GeorgiaReportedIeAggregation } from "./georgiaReportedFinanceAggregation.js";

export type GeorgiaReportedFinanceReceiver = GeorgiaCandidateFinanceDueRow & {
  linkId: string;
  electionDate: string;
};
export type GeorgiaReportedComponentInput<T> = {
  receiver: GeorgiaReportedFinanceReceiver;
  context: GeorgiaLinkedReceivingRegistration;
  source: GeorgiaReportedSourceFacts;
  aggregation: T;
};
export type GeorgiaReportedCommitteeComponent = GeorgiaReportedComponentInput<GeorgiaReportedCommitteeAggregation> & {
  heldReceivingCount: number;
};
export type GeorgiaReportedIeComponent = GeorgiaReportedComponentInput<GeorgiaReportedIeAggregation>;
