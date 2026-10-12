import type {
  OregonPacCandidateContext, OregonPacRawEvidence, OregonPacSnapshot,
  OregonVerifiedPacDonor, OregonVerifiedPacProvenance,
} from "./oregonVerifiedPacSource.js";
import { verifyOregonCurrentPacSource } from "./oregonVerifiedPacSource.js";
import {
  verifyOregonVerifiedOutsideSource, validateOregonVerifiedOutsideEvidence,
  type OregonOutsideSourceSnapshot, type OregonVerifiedOutsideEvidence,
} from "./oregonVerifiedOutsideSource.js";
import {
  decodeOregonVerifiedHtmlBytes, decodeOregonVerifiedTransactionSearch,
  decodeOregonVerifiedTransactionWorkbook, decodeOregonVerifiedTransactionDetail,
  decodeOregonVerifiedTransactionHistory, decodeOregonVerifiedSoo,
  decodeOregonVerifiedCandidateDirectory, hashOregonVerifiedBytes,
} from "./oregonVerifiedSourceDecoders.js";
import { oregonVerifiedCandidateOfficeLine } from "./oregonVerifiedCandidateContext.js";
import type { createOregonVerifiedSourceClient } from "./oregonVerifiedSourceClient.js";

export type OregonVerifiedFinanceSourceLoaderInput = {
  candidateContext: OregonPacCandidateContext;
  client: ReturnType<typeof createOregonVerifiedSourceClient>;
  refresh?: boolean;
  readSavedPublicGet?: (url: string) => Promise<OregonPacRawEvidence | undefined>;
  priorPacProvenance?: unknown;
  priorOutsideProvenanceByPayer?: Readonly<Record<string, unknown>>;
};
export type OregonVerifiedFinanceSourceLoaderResult = {
  pac?: { donors: readonly OregonVerifiedPacDonor[]; provenance: OregonVerifiedPacProvenance };
  /** Positive payer proofs only. Omission never authorizes removing a stored payer. */
  positiveOutsideEvidence?: readonly OregonVerifiedOutsideEvidence[];
  diagnostics: readonly string[];
};
const ROOT = "https://secure.sos.state.or.us/orestar/";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const id = (value: unknown): value is string => typeof value === "string"
  && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const person = (value: string): string => {
  const parts = value.split(",");
  return (parts.length === 2 ? parts[1] + " " + parts[0] : value)
    .normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
};
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const html = (evidence: OregonPacRawEvidence): string => decodeOregonVerifiedHtmlBytes(evidence.bytes);
function requireWorkbook(ledger: { workbook?: OregonPacRawEvidence }): OregonPacRawEvidence {
  if (!ledger.workbook) throw new Error("Missing real full current workbook; empty search is not financial zero authority");
  return ledger.workbook;
}
function nativeRows(pages: readonly OregonPacRawEvidence[]) {
  return pages.flatMap(page => decodeOregonVerifiedTransactionSearch(html(page)).rows);
}
function cachedPublicGetIsValid(e: OregonPacRawEvidence, expectedUrl: string): boolean {
  const r = e?.request;
  return !!r && e.bytes instanceof Uint8Array && e.bytes.length > 0
    && e.bytes.length <= 64 * 1024 * 1024 && r.url === expectedUrl
    && r.method === "GET" && r.status === 200 && r.byteCount === e.bytes.length
    && r.requestFields !== null && typeof r.requestFields === "object"
    && Object.keys(r.requestFields).length === 0
    && /^[a-f0-9]{64}$/.test(r.sha256) && r.sha256 === hashOregonVerifiedBytes(e.bytes)
    && Number.isFinite(Date.parse(r.startedAt)) && Number.isFinite(Date.parse(r.endedAt))
    && Date.parse(r.startedAt) <= Date.parse(r.endedAt);
}

/** Raw acquisition and real pure verification only; no headline, zero, or database writes. */
export async function loadOregonVerifiedFinanceSource(
  input: OregonVerifiedFinanceSourceLoaderInput,
): Promise<OregonVerifiedFinanceSourceLoaderResult> {
  const diagnostics: string[] = [];
  const result: OregonVerifiedFinanceSourceLoaderResult = { diagnostics };
  const c = input.candidateContext;
  if (!c || !UUID.test(c.candidateId) || !UUID.test(c.electionId) || !id(c.committeeId)
    || typeof c.candidateName !== "string" || !person(c.candidateName)
    || c.electionYear !== 2026 || c.electionType !== "General"
    || oregonVerifiedCandidateOfficeLine(c) === null) {
    diagnostics.push("Invalid exact local candidate/election/office/numeric-seat context; components preserved");
    return result;
  }
  const windowStart = `${c.electionYear - 1}-01-01`, windowEnd = `${c.electionYear}-12-31`;
  const client = input.client;

  // Saved captures retain original metadata; no timestamp, byte or source-identity rewriting.
  async function openingGet<T>(
    path: string, fetchFresh: () => Promise<OregonPacRawEvidence>,
    decodeAndCheck: (e: OregonPacRawEvidence) => T,
  ): Promise<OregonPacRawEvidence> {
    if (!input.refresh && input.readSavedPublicGet) {
      try {
        const saved = await input.readSavedPublicGet(ROOT + path);
        if (saved) {
          if (!cachedPublicGetIsValid(saved, ROOT + path)) throw new Error("Invalid saved request/hash metadata");
          decodeAndCheck(saved);
          return saved;
        }
      } catch (error) {
        diagnostics.push(`Saved opening ${path} rejected; acquiring fresh: ${message(error)}`);
      }
    }
    const fresh = await fetchFresh();
    decodeAndCheck(fresh);
    return fresh;
  }
  function detail(transactionId: string, opening: boolean) {
    const fetchFresh = () => client.fetchTransactionDetail({ transactionId });
    const check = (e: OregonPacRawEvidence) => {
      const decoded = decodeOregonVerifiedTransactionDetail(html(e));
      if (decoded.transactionId !== transactionId) throw new Error("Wrong exact financial detail ID");
      return decoded;
    };
    return opening ? openingGet(`gotoPublicTransactionDetail.do?tranRsn=${transactionId}`, fetchFresh, check) : fetchFresh();
  }
  function history(transactionId: string, opening: boolean) {
    const fetchFresh = () => client.fetchTransactionHistory({ transactionId });
    const check = (e: OregonPacRawEvidence) => {
      const decoded = decodeOregonVerifiedTransactionHistory(html(e));
      if (decoded.transactionId !== transactionId) throw new Error("Wrong exact public history ID");
      return decoded;
    };
    return opening ? openingGet(`ceTransactionHistory.do?tranRsn=${transactionId}`, fetchFresh, check) : fetchFresh();
  }
  function soo(publicCommitteeId: string, opening: boolean, qualifiedSooRsn?: string) {
    const fetchFresh = () => qualifiedSooRsn
      ? client.fetchSoo({ qualifiedSooRsn }) : client.fetchSoo({ publicCommitteeId });
    const check = (e: OregonPacRawEvidence) => {
      const decoded = decodeOregonVerifiedSoo(html(e));
      if (decoded.committeeId !== publicCommitteeId
        || qualifiedSooRsn && decoded.sourceSooRsn !== null && decoded.sourceSooRsn !== qualifiedSooRsn)
        throw new Error("Wrong exact public/qualified SOO identity");
      return decoded;
    };
    return opening ? openingGet(`sooDetail.do?${qualifiedSooRsn ? "sooRsn=" + qualifiedSooRsn : "cneCommitteeId=" + publicCommitteeId}`, fetchFresh, check) : fetchFresh();
  }

  try {
    const query = { committeeId: c.committeeId, electionYear: c.electionYear };
    const contributions = await client.fetchCurrentTransactionLedger({ ...query, transactionType: "C" });
    const otherDisbursements = await client.fetchCurrentTransactionLedger({ ...query, transactionType: "OD" });
    if (nativeRows(otherDisbursements.pages).length) {
      diagnostics.push("PAC preserved: nonempty current Other Disbursements; refund/netting scope unresolved");
    } else {
      const workbook = requireWorkbook(contributions);
      const rows = decodeOregonVerifiedTransactionWorkbook(workbook.bytes, { expectedCommitteeId: c.committeeId, mode: "current" }).rows;
      const typed = rows.filter(row => row.subType === "Cash Contribution" && row.bookType === "Political Committee");
      if (typed.some(row => !id(row.payeeCommitteeId))) throw new Error("Typed cash has no exact donor public ID");
      const donorIds = [...new Set(typed.map(row => row.payeeCommitteeId!))];
      const before: OregonPacSnapshot = {
        contributions: { pages: contributions.pages, workbook },
        otherDisbursements: { pages: otherDisbursements.pages },
        receivingSoo: await soo(c.committeeId, true), typedCashDetails: [], donorSoos: [],
      };
      for (const row of typed) before.typedCashDetails = [...before.typedCashDetails, await detail(row.transactionId, true)];
      for (const donorId of donorIds) before.donorSoos = [...before.donorSoos, await soo(donorId, true)];
      const receivingSoo = await soo(c.committeeId, false);
      const typedCashDetails: OregonPacRawEvidence[] = [], donorSoos: OregonPacRawEvidence[] = [];
      for (const row of typed) typedCashDetails.push(await detail(row.transactionId, false));
      for (const donorId of donorIds) donorSoos.push(await soo(donorId, false));
      const closingContributions = await client.fetchCurrentTransactionLedger({ ...query, transactionType: "C" });
      const closingDisbursements = await client.fetchCurrentTransactionLedger({ ...query, transactionType: "OD" });
      const verified = verifyOregonCurrentPacSource({
        candidateContext: c, windowStart, windowEnd, before,
        after: {
          contributions: { pages: closingContributions.pages, workbook: requireWorkbook(closingContributions) },
          otherDisbursements: { pages: closingDisbursements.pages }, receivingSoo, typedCashDetails, donorSoos,
        }, priorProvenance: input.priorPacProvenance,
      });
      diagnostics.push(...verified.diagnostics.map(d => `PAC: ${d}`));
      if (verified.pacDonors?.length && verified.provenance) {
        result.pac = { donors: verified.pacDonors, provenance: verified.provenance };
      } else if (verified.pacDonors) {
        diagnostics.push("PAC preserved: no positively verified named registered PAC gifts; no zero published");
      }
    }
  } catch (error) {
    diagnostics.push(`PAC source failure; component preserved: ${message(error)}`);
  }

  // Global details discover exact public payer IDs; native internal filer RSNs are never cast.
  const payerIds = new Set<string>();
  try {
    const global = await client.fetchCurrentTransactionLedger({ electionYear: c.electionYear, transactionType: "E", independentOnly: true });
    const workbook = global.workbook;
    if (workbook) {
      const rows = decodeOregonVerifiedTransactionWorkbook(workbook.bytes, { mode: "current" }).rows;
      for (const row of rows) {
        const decoded = decodeOregonVerifiedTransactionDetail(html(await detail(row.transactionId, true)));
        if (decoded.filerCommitteeId !== row.filerCommitteeId || decoded.date !== row.date || decoded.amountCents !== row.amountCents)
          throw new Error(`Global public detail/workbook mismatch ${row.transactionId}`);
        if (decoded.mechanisms.some(m => m.mechanism === "independent" && person(m.targetName) === person(c.candidateName))) {
          if (!id(decoded.filerCommitteeId)) throw new Error("Missing actual public payer ID");
          payerIds.add(decoded.filerCommitteeId);
        }
      }
    } else if (nativeRows(global.pages).length) {
      throw new Error("Missing complete global Independent workbook");
    }
    for (const [payerId, prior] of Object.entries(input.priorOutsideProvenanceByPayer ?? {})) {
      if (validateOregonVerifiedOutsideEvidence(prior, c) && prior.payer.committeeId === payerId) payerIds.add(payerId);
      else diagnostics.push(`Outside payer ${payerId}: invalid prior authority; omission never means deletion`);
    }
    if (!payerIds.size) {
      diagnostics.push("Outside preserved: no discovered/prior positive payer; empty discovery is not zero authority");
      return result;
    }
    const openingDirectory = await client.fetchCandidateDirectory({ yearActive: c.electionYear });
    if (openingDirectory.pages.length !== 1) throw new Error("Unsupported full native candidate directory pagination");
    const directory = decodeOregonVerifiedCandidateDirectory(html(openingDirectory.pages[0]));
    const matches = directory.rows.filter(row => person(row.candidateName) === person(c.candidateName));
    if (matches.length !== 1 || matches[0].committeeId !== c.committeeId)
      throw new Error("Missing/ambiguous exact full candidate context in complete native directory");
    const sourceSooRsn = matches[0].sourceSooRsn;
    const positives: OregonVerifiedOutsideEvidence[] = [];
    for (const payerId of payerIds) {
      try {
        const query = { committeeId: payerId, electionYear: c.electionYear, transactionType: "E" as const, independentOnly: true as const };
        const independent = await client.fetchCurrentTransactionLedger(query);
        const workbook = requireWorkbook(independent);
        const rows = decodeOregonVerifiedTransactionWorkbook(workbook.bytes, { expectedCommitteeId: payerId, mode: "current" }).rows;
        const before: OregonOutsideSourceSnapshot = {
          independent: { pages: independent.pages, workbook }, financialDetails: [], histories: [],
          payerSoo: await soo(payerId, true), candidateDirectory: openingDirectory.pages,
          receivingSoo: await soo(c.committeeId, true), qualifiedTargetSoo: await soo(c.committeeId, true, sourceSooRsn),
        };
        for (const row of rows) {
          before.financialDetails = [...before.financialDetails, await detail(row.transactionId, true)];
          before.histories = [...before.histories, await history(row.transactionId, true)];
        }
        const payerSoo = await soo(payerId, false), receivingSoo = await soo(c.committeeId, false);
        const qualifiedTargetSoo = await soo(c.committeeId, false, sourceSooRsn);
        const financialDetails: OregonPacRawEvidence[] = [], histories: OregonPacRawEvidence[] = [];
        for (const row of rows) {
          financialDetails.push(await detail(row.transactionId, false));
          histories.push(await history(row.transactionId, false));
        }
        const closingDirectory = await client.fetchCandidateDirectory({ yearActive: c.electionYear });
        const closingIndependent = await client.fetchCurrentTransactionLedger(query);
        const verified = verifyOregonVerifiedOutsideSource({
          candidateContext: c, payerCommitteeId: payerId, windowStart, windowEnd, before,
          after: {
            independent: { pages: closingIndependent.pages, workbook: requireWorkbook(closingIndependent) },
            financialDetails, histories, payerSoo, candidateDirectory: closingDirectory.pages, receivingSoo, qualifiedTargetSoo,
          }, priorProvenance: input.priorOutsideProvenanceByPayer?.[payerId],
        });
        diagnostics.push(...verified.diagnostics.map(d => `Outside payer ${payerId}: ${d}`));
        if (verified.evidence) positives.push(verified.evidence);
      } catch (error) {
        diagnostics.push(`Outside payer ${payerId} omitted; existing evidence preserved: ${message(error)}`);
      }
    }
    if (positives.length) result.positiveOutsideEvidence = positives;
  } catch (error) {
    diagnostics.push(`Outside discovery/context failure; component preserved: ${message(error)}`);
  }
  return result;
}
