import { createHash } from "node:crypto";
import type { FloridaFinanceRawRequest } from "./floridaFinanceRawSourceClient.js";
import {
  decodeFloridaEfsCurrentReport,
  decodeFloridaNativeActivity,
  decodeFloridaProcessedCandidateOwnership,
  verifyFloridaProcessedFinanceSource,
  type FloridaProcessedCandidateContext,
  type FloridaProcessedFinanceProof,
  type FloridaProcessedRawEvidence,
  type FloridaProcessedSourcePacket,
} from "./floridaProcessedFinanceSource.js";

export type FloridaProcessedSourceRequest = (
  request: FloridaFinanceRawRequest,
  options?: { savedFirst?: boolean },
) => Promise<FloridaProcessedRawEvidence>;

const DOS = "https://dos.elections.myflorida.com";
const EFS = "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx";
const display = (value: string) => value.trim().replace(/\s+/g, " ");
function civil(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("invalid Florida processed source window");
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}
function html(raw: FloridaProcessedRawEvidence): string {
  if (
    raw.status !== 200 ||
    !raw.contentType.toLowerCase().includes("html") ||
    createHash("sha256").update(raw.bytesRaw).digest("hex") !== raw.sha256
  )
    throw new Error("invalid Florida processed HTML response");
  return new TextDecoder("utf-8", { fatal: true }).decode(raw.bytesRaw);
}

/** Collects independent current publication packets. Discovery numbers are not
 * report authority: each EFS response must bind its actual account and coverage.
 * Saved openings retain their original capture times; closings are always fresh.
 * This loader neither resolves local ownership nor classifies committee donors.
 */
export function createFloridaProcessedFinanceSourceLoader(options: {
  request: FloridaProcessedSourceRequest;
  refresh?: boolean;
  maxReportSlots?: number;
  maxRequests?: number;
  rowLimit?: number;
}) {
  const maxSlots = options.maxReportSlots ?? 100;
  const maxRequests = options.maxRequests ?? 500;
  const rowLimit = options.rowLimit ?? 10000;
  if (
    ![maxSlots, maxRequests, rowLimit].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    maxSlots > 1000 ||
    maxRequests > 10000 ||
    rowLimit > 100000
  )
    throw new Error("invalid Florida processed acquisition bounds");

  return {
    async load(input: {
      context: FloridaProcessedCandidateContext;
      windowStart: string;
      windowEnd: string;
    }): Promise<{
      proof?: FloridaProcessedFinanceProof;
      diagnostics: string[];
    }> {
      // Retain the entire caller generation before the first network await.
      const context = { ...input.context };
      const windowStart = input.windowStart,
        windowEnd = input.windowEnd;
      let requests = 0;
      try {
        if (
          !/^[1-9]\d*$/.test(context.sourceAccount) ||
          !Number.isSafeInteger(Number(context.sourceAccount)) ||
          context.electionYear !== 2026
        )
          throw new Error(
            "unsupported Florida processed account/election scope",
          );
        const from = civil(windowStart),
          to = civil(windowEnd);
        if (windowStart > windowEnd)
          throw new Error("invalid Florida processed source window");
        // Exact source-form receiving label, with all given-name words retained.
        const name = /^([^,]+),\s*(.+?)\s+\([A-Z]{2,3}\)\([A-Z]{2,3}\)$/.exec(
          context.genericRecipientName,
        );
        if (
          !name ||
          display(`${name[2]} ${name[1]}`) !== display(context.candidateName)
        )
          throw new Error("unsupported exact Florida receiving-name query");
        const genericFields = {
          election: "20261103-GEN",
          search_on: "2",
          CanFName: display(name[2]),
          CanLName: display(name[1]),
          CanNameSrch: "2",
          office: "All",
          cdistrict: "",
          cgroup: "",
          party: "All",
          ComName: "",
          ComNameSrch: "2",
          committee: "All",
          cfname: "",
          clname: "",
          namesearch: "2",
          ccity: "",
          cstate: "",
          czipcode: "",
          coccupation: "",
          cdollar_minimum: "",
          cdollar_maximum: "",
          rowlimit: String(rowLimit),
          csort1: "NAM",
          csort2: "CAN",
          cdatefrom: from,
          cdateto: to,
          queryformat: "2",
          Submit: "Submit",
        };
        async function capture(
          request: FloridaFinanceRawRequest,
          closing: boolean,
        ) {
          if (++requests > maxRequests)
            throw new Error("Florida processed request budget exhausted");
          const raw = await options.request(request, {
            savedFirst: !closing && !options.refresh,
          });
          return {
            ...raw,
            bytesRaw: new Uint8Array(raw.bytesRaw),
            financeFields: raw.financeFields && { ...raw.financeFields },
          };
        }
        async function packet(
          closing: boolean,
        ): Promise<FloridaProcessedSourcePacket> {
          const ownership = await capture(
            {
              url: `${DOS}/candidates/CanDetail.asp?account=${context.sourceAccount}`,
              method: "GET",
              financeFields: null,
            },
            closing,
          );
          const owner = decodeFloridaProcessedCandidateOwnership(
            html(ownership),
          );
          if (
            owner.account !== context.sourceAccount ||
            owner.CanCom !== "Cand" ||
            owner.elecdesc !== `${context.electionYear} General Election` ||
            display(owner.office ?? "") !== context.officeName ||
            !display(owner.candname ?? "").startsWith(
              `${context.candidateName} (`,
            )
          )
            throw new Error("Florida processed acquisition owner mismatch");
          const activity = await capture(
            {
              url: `${DOS}/cgi-bin/TreSel.exe`,
              method: "POST",
              financeFields: {
                ...owner,
                generate: "Campaign Finance Activity",
              },
            },
            closing,
          );
          const decodedActivity = decodeFloridaNativeActivity(html(activity));
          const sequences = decodedActivity.periods.flatMap((p) =>
            p.nativeSequence === null ? [] : [p.nativeSequence],
          );
          const maximum = Math.max(0, ...sequences);
          if (!maximum || maximum > maxSlots)
            throw new Error(
              "Florida processed status discovery unavailable or over bound",
            );
          const currentReports: FloridaProcessedRawEvidence[] = [];
          const seenCoverage = new Set<string>();
          for (let sequence = 1; sequence <= maximum; sequence++) {
            const raw = await capture(
              {
                url: `${EFS}?AcctNum=${context.sourceAccount}&SeqNum=${sequence}`,
                method: "GET",
                financeFields: null,
              },
              closing,
            );
            const report = decodeFloridaEfsCurrentReport(html(raw));
            const coverage = `${report.periodStart}/${report.periodEnd}`;
            if (
              report.account !== context.sourceAccount ||
              report.sequence !== sequence ||
              report.candidateName !== context.candidateName ||
              report.electionYear !== context.electionYear ||
              seenCoverage.has(coverage) ||
              !decodedActivity.periods.some(
                (p) =>
                  p.periodStart === report.periodStart &&
                  p.periodEnd === report.periodEnd,
              )
            )
              throw new Error(
                "Florida processed EFS discovery account/coverage mismatch",
              );
            seenCoverage.add(coverage);
            currentReports.push(raw);
          }
          if (seenCoverage.size !== decodedActivity.periods.length)
            throw new Error(
              "Florida processed current coverage missing (including unselectable waiver)",
            );
          const native = async (sequence: number) =>
            capture(
              {
                url: `${DOS}/cgi-bin/TreFin.exe`,
                method: "POST",
                financeFields: {
                  account: context.sourceAccount,
                  seqnum: String(sequence),
                  queryfor: "1",
                  queryorder: "DAT",
                  queryoutput: "2",
                  query: "Submit Query Now",
                },
              },
              closing,
            );
          const periodExports: FloridaProcessedRawEvidence[] = [];
          for (const sequence of sequences)
            periodExports.push(await native(sequence));
          const allDatesExport = await native(0);
          const genericExport = await capture(
            {
              url: `${DOS}/cgi-bin/contrib.exe`,
              method: "POST",
              financeFields: genericFields,
            },
            closing,
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
        const before = await packet(false);
        const after = await packet(true);
        return verifyFloridaProcessedFinanceSource({
          context,
          windowStart,
          windowEnd,
          before,
          after,
        });
      } catch (error) {
        return {
          diagnostics: [
            error instanceof Error
              ? error.message
              : "Florida processed acquisition unavailable",
          ],
        };
      }
    },
  };
}
