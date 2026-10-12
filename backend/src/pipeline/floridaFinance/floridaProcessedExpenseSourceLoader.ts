import { createHash } from "node:crypto";
import type { FloridaFinanceRawRequest } from "./floridaFinanceRawSourceClient.js";
import type { FloridaProcessedRawEvidence } from "./floridaProcessedFinanceSource.js";
import { decodeFloridaCommitteeDetail } from "./floridaCommitteeRegistrySource.js";
import { decodeFloridaEfsExpenditureElectionContext } from "./floridaExplicitIndependentExpenditure.js";
import {
  decodeFloridaCommitteeExpenseCover,
  verifyFloridaProcessedExpenseSource,
  type FloridaProcessedExpenseContext,
  type FloridaProcessedExpensePacket,
  type FloridaProcessedExpenseProof,
} from "./floridaProcessedExpenseSource.js";

export type FloridaProcessedExpenseRequest = (
  request: FloridaFinanceRawRequest,
  options?: { savedFirst?: boolean },
) => Promise<FloridaProcessedRawEvidence>;
export type FloridaProcessedExpenseSourceInput = {
  context: FloridaProcessedExpenseContext;
  before: FloridaProcessedExpensePacket;
  after: FloridaProcessedExpensePacket;
};
export type FloridaProcessedExpenseLoadResult =
  | {
      proof: FloridaProcessedExpenseProof;
      source: FloridaProcessedExpenseSourceInput;
      diagnostics: string[];
    }
  | { proof?: undefined; source?: undefined; diagnostics: string[] };
const DOS = "https://dos.elections.myflorida.com";
const EFS = "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx";
const exact = (value: string) =>
  value.trim().replace(/\s+/gu, " ").toUpperCase();
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(reason: string): never {
  throw new Error(`Florida expense source loader: ${reason}`);
}
function validContext(context: FloridaProcessedExpenseContext): boolean {
  return (
    /^[1-9]\d*$/.test(context.payerAccount) &&
    Number.isSafeInteger(Number(context.payerAccount)) &&
    typeof context.payerName === "string" &&
    Boolean(context.payerName.trim()) &&
    context.payerName.length <= 500 &&
    !/[\x00-\x1f\x7f]/.test(context.payerName) &&
    ["PAC", "IXO"].includes(context.payerType) &&
    context.electionYear === 2026 &&
    context.genericPayerLabel ===
      `${context.payerName} (${context.payerType})` &&
    ((context.electionType === "general" &&
      context.electionSelector === "20261103-GEN" &&
      context.electionDescription === "2026 General Election") ||
      (context.electionType === "special" &&
        context.electionSelector === "20260324-S01" &&
        context.electionDescription ===
          "2026 Special Election - Senate 14 & House 87"))
  );
}
function sameFields(
  a: Readonly<Record<string, string>> | null,
  b: Readonly<Record<string, string>> | null,
): boolean {
  return (
    JSON.stringify(a && Object.entries(a).sort()) ===
    JSON.stringify(b && Object.entries(b).sort())
  );
}
function html(raw: FloridaProcessedRawEvidence): string {
  if (raw.status !== 200 || !raw.contentType.toLowerCase().includes("html"))
    fail("required HTML unavailable");
  return new TextDecoder("utf-8", { fatal: true }).decode(raw.bytesRaw);
}
const nativeFields = (account: string, sequence: number) => ({
  account,
  seqnum: String(sequence),
  queryfor: "2",
  queryorder: "DAT",
  queryoutput: "2",
  query: "Submit Query Now",
});

/** Collects whole current published expenses for an already resolved public payer.
 * No payer resolution, candidate attribution, current-history invention or zero
 * intent occurs here. Financial acceptance always uses the real pure verifier.
 */
export function createFloridaProcessedExpenseSourceLoader(options: {
  request: FloridaProcessedExpenseRequest;
  refresh?: boolean;
  maxReportSlots?: number;
  maxRequests?: number;
  rowLimit?: number;
}) {
  const maxSlots = options.maxReportSlots ?? 64;
  const maxRequests = options.maxRequests ?? 300;
  const rowLimit = options.rowLimit ?? 1000;
  const refresh = options.refresh === true;
  const request = options.request;
  if (
    ![maxSlots, maxRequests, rowLimit].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    maxSlots > 64 ||
    maxRequests > 1000 ||
    rowLimit > 100000
  )
    fail("invalid acquisition bounds");
  return {
    async load(input: {
      context: FloridaProcessedExpenseContext;
    }): Promise<FloridaProcessedExpenseLoadResult> {
      const context = structuredClone(input.context);
      const discoveryDiagnostics: string[] = [];
      let requests = 0;
      try {
        if (!validContext(context))
          fail("unsupported exact payer/election context");
        async function capture(
          expected: FloridaFinanceRawRequest,
          closing: boolean,
        ): Promise<FloridaProcessedRawEvidence> {
          if (++requests > maxRequests) fail("request budget exhausted");
          const raw = structuredClone(
            await request(structuredClone(expected), {
              savedFirst: !closing && !refresh,
            }),
          );
          if (
            raw.url !== expected.url ||
            raw.method !== expected.method ||
            !sameFields(raw.financeFields, expected.financeFields) ||
            !(raw.bytesRaw instanceof Uint8Array) ||
            raw.bytesRaw.length > 4 * 1024 * 1024 ||
            !/^[a-f0-9]{64}$/.test(raw.sha256) ||
            sha(raw.bytesRaw) !== raw.sha256 ||
            !Number.isInteger(raw.status) ||
            raw.status < 100 ||
            raw.status > 599 ||
            typeof raw.contentType !== "string" ||
            !raw.contentType.trim() ||
            !Number.isFinite(Date.parse(raw.startedAt)) ||
            !Number.isFinite(Date.parse(raw.completedAt)) ||
            Date.parse(raw.startedAt) > Date.parse(raw.completedAt)
          )
            fail("invalid request-bound raw capture");
          return raw;
        }
        async function collect(
          closing: boolean,
        ): Promise<FloridaProcessedExpensePacket> {
          const ownership = await capture(
            {
              url: `${DOS}/committees/ComDetail.asp?account=${context.payerAccount}`,
              method: "GET",
              financeFields: null,
            },
            closing,
          );
          const owner = decodeFloridaCommitteeDetail(ownership, {
            committeeId: context.payerAccount,
          });
          if (
            exact(owner.committeeName) !== exact(context.payerName) ||
            owner.committeeType !== context.payerType
          )
            fail("wrong source payer owner/type");
          const activity = await capture(
            {
              url: `${DOS}/cgi-bin/TreSel.exe`,
              method: "POST",
              financeFields: {
                account: context.payerAccount,
                election: "All",
                submit: "Campaign Finance Activity",
              },
            },
            closing,
          );
          const cover = decodeFloridaCommitteeExpenseCover(
            html(activity),
            context.payerAccount,
          );
          if (cover.periods.length > maxSlots)
            fail("visible periods exceed status discovery bound");
          const allDatesExport = await capture(
            {
              url: `${DOS}/cgi-bin/TreFin.exe`,
              method: "POST",
              financeFields: nativeFields(context.payerAccount, 0),
            },
            closing,
          );
          const periodExports: FloridaProcessedRawEvidence[] = [];
          for (const period of cover.periods) {
            if (period.nativeSequence !== null)
              periodExports.push(
                await capture(
                  {
                    url: `${DOS}/cgi-bin/TreFin.exe`,
                    method: "POST",
                    financeFields: nativeFields(
                      context.payerAccount,
                      period.nativeSequence,
                    ),
                  },
                  closing,
                ),
              );
          }
          const genericExport = await capture(
            {
              url: `${DOS}/cgi-bin/expend.exe`,
              method: "POST",
              financeFields: {
                election: context.electionSelector,
                search_on: "4",
                CanFName: "",
                CanLName: "",
                CanNameSrch: "2",
                office: "All",
                cdistrict: "",
                cgroup: "",
                party: "All",
                ComName: context.payerName,
                ComNameSrch: "2",
                committee: "All",
                cfname: "",
                clname: "",
                namesearch: "2",
                ccity: "",
                cstate: "",
                czipcode: "",
                cpurpose: "",
                cdollar_minimum: "",
                cdollar_maximum: "",
                rowlimit: String(rowLimit),
                csort1: "DAT",
                csort2: "CAN",
                cdatefrom: "",
                cdateto: "",
                queryformat: "2",
                Submit: "Submit",
              },
            },
            closing,
          );
          // Native selectors and EFS sequences are independent. Scan the full
          // bounded EFS range, including later slots that may duplicate coverage.
          const slotBound = maxSlots;
          const matches = new Map<string, FloridaProcessedRawEvidence[]>();
          let unboundSlots = 0;
          for (let sequence = 1; sequence <= slotBound; sequence++) {
            const raw = await capture(
              {
                url: `${EFS}?AcctNum=${context.payerAccount}&SeqNum=${sequence}`,
                method: "GET",
                financeFields: null,
              },
              closing,
            );
            // A missing optional probe is not a zero report. Required coverage
            // still must be independently closed by exactly one actual response.
            if (raw.status !== 200) {
              unboundSlots++;
              continue;
            }
            let report;
            try {
              report = decodeFloridaEfsExpenditureElectionContext(html(raw));
            } catch {
              unboundSlots++;
              continue;
            }
            if (
              report.account !== context.payerAccount ||
              report.sequence !== sequence
            )
              fail("wrong actual EFS account/sequence");
            const key = `${report.periodStart}/${report.periodEnd}`;
            const isVisible = cover.periods.some(
              (period) => `${period.periodStart}/${period.periodEnd}` === key,
            );
            if (!isVisible) {
              if (report.fileStatus === "Filed Report")
                fail("filed current report absent from native activity");
              unboundSlots++;
              continue;
            }
            const rows = matches.get(key) ?? [];
            rows.push(raw);
            matches.set(key, rows);
          }
          const currentReports = cover.periods.map((period) => {
            const rows =
              matches.get(`${period.periodStart}/${period.periodEnd}`) ?? [];
            if (rows.length !== 1)
              fail(
                `current coverage ${period.periodStart}/${period.periodEnd} has ${rows.length} EFS matches within ${slotBound} slots`,
              );
            return rows[0]!;
          });
          if (unboundSlots)
            discoveryDiagnostics.push(
              `${closing ? "Closing" : "Opening"}: ${unboundSlots} unused status candidates grant no report or zero authority.`,
            );
          return {
            ownership,
            activity,
            currentReports,
            periodExports,
            allDatesExport,
            genericExport,
          };
        }
        const before = await collect(false);
        const after = await collect(true);
        const result = verifyFloridaProcessedExpenseSource({
          context,
          before,
          after,
        });
        const diagnostics = [...result.diagnostics, ...discoveryDiagnostics];
        if (!result.proof) return { diagnostics };
        return {
          proof: result.proof,
          source: structuredClone({ context, before, after }),
          diagnostics,
        };
      } catch (error) {
        return {
          diagnostics: [
            error instanceof Error
              ? error.message
              : "Expense source unavailable",
            ...discoveryDiagnostics,
          ],
        };
      }
    },
  };
}
