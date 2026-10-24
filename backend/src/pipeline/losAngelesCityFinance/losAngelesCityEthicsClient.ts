export const LOS_ANGELES_ETHICS_BASE_URL = "https://ethics.lacity.gov";
export const LOS_ANGELES_ETHICS_ELECTIONS_URL = `${LOS_ANGELES_ETHICS_BASE_URL}/elections/`;
const DEFAULT_TIMEOUT_MS = 45_000;

export type LosAngelesCityEthicsClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryCount?: number;
};

export type LosAngelesEthicsElection = {
  electionId: string;
  description: string;
  electionYear: number;
};
export type LosAngelesEthicsCandidateTotal = {
  electionId: string;
  electionSeatId: string;
  electionSeatCandidateId: string;
  candidatePersonId: string;
  candidateName: string;
  officeName: string;
  reportedThrough: string | null;
  fppcCommitteeId: string;
  /** Complete source-controlled scope; singular id remains a stable link anchor. */
  fppcCommitteeIds?: readonly string[];
  sourceElectionDates?: readonly string[];
  committeeName: string;
  internalCommitteePersonId: string | null;
  totalContributions: number;
  totalExpenditures: number;
  cashOnHand: number;
  matchingFunds: number | null;
  outsideSupportTotal: number;
  outsideOpposeTotal: number;
  membershipSupportTotal: number;
  membershipOpposeTotal: number;
  sourceUrl: string;
};

export type LosAngelesEthicsIndependentSpendingRow = {
  expenditureId: string;
  spenderId: string;
  spenderName: string;
  candidateName: string;
  officeName: string;
  supportOppose: "support" | "oppose";
  amount: number;
  reportUrl: string | null;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function money(value: string): number | null {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function isoDateFromUs(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[3]) + (match[3]?.length === 2 ? 2000 : 0);
  return `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

async function fetchResponse(
  url: string,
  options: LosAngelesCityEthicsClientOptions,
  asJson: boolean,
): Promise<unknown> {
  const retries = options.retryCount ?? 2;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: { accept: asJson ? "application/json" : "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < retries
        )
          continue;
        throw new Error(
          `Los Angeles Ethics request failed: ${response.status} ${response.statusText}`,
        );
      }
      return asJson ? await response.json() : await response.text();
    } catch (error) {
      if (
        attempt < retries &&
        (error instanceof TypeError ||
          (error instanceof Error && error.name === "AbortError"))
      )
        continue;
      if (error instanceof Error && error.name === "AbortError")
        throw new Error(
          `Los Angeles Ethics request timed out after ${timeoutMs}ms`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Los Angeles Ethics request exhausted retries");
}

export function parseLosAngelesEthicsElectionIndex(
  html: string,
): LosAngelesEthicsElection[] {
  const select =
    /<select\b[^>]*\bname=["']election_id["'][^>]*>([\s\S]*?)<\/select>/i.exec(
      html,
    )?.[1];
  if (!select)
    throw new Error(
      "Los Angeles Ethics election index is missing election_id select",
    );
  const elections: LosAngelesEthicsElection[] = [];
  for (const match of select.matchAll(
    /<option\b[^>]*\bvalue=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/option>/gi,
  )) {
    const description = decodeHtml(match[2] ?? "");
    const year = Number(/\b(20\d{2})\b/.exec(description)?.[1]);
    if (description && Number.isInteger(year))
      elections.push({
        electionId: match[1]!,
        description,
        electionYear: year,
      });
  }
  if (elections.length === 0)
    throw new Error(
      "Los Angeles Ethics election index contains no dated elections",
    );
  return elections;
}

type CandidateMetricTotals = [
  number,
  number,
  number,
  number | null,
  number,
  number,
  number,
  number,
];

function metricTotals(
  candidateMainRow: string,
  matchingFundsOmitted: boolean,
): CandidateMetricTotals {
  const parseMetricCells = (
    cells: string[],
    completedElection: boolean,
  ): CandidateMetricTotals => {
    const withoutCompletedColumns = completedElection
      ? [cells[0]!, cells[1]!, cells[2]!, ...cells.slice(5)]
      : cells;
    const financeCells = matchingFundsOmitted
      ? [
          withoutCompletedColumns[0]!,
          withoutCompletedColumns[1]!,
          withoutCompletedColumns[2]!,
          null,
          ...withoutCompletedColumns.slice(3),
        ]
      : withoutCompletedColumns;
    const totals = financeCells.map((cell, index) => {
      if (cell === null) return null;
      const value = money(cell);
      if (value !== null) return value;
      if (index === 3 && /^ACCEPTED$/i.test(cell)) return null;
      throw new Error("Los Angeles Ethics candidate metric is not money");
    });
    return totals as CandidateMetricTotals;
  };
  const currentCells = [
    ...candidateMainRow.matchAll(/border-top:[^>]*>([\s\S]*?)<\/td>/gi),
  ];
  if (currentCells.length > 0) {
    const cells = currentCells.map((match) => decodeHtml(match[1] ?? ""));
    const expected = matchingFundsOmitted ? [7, 9] : [8, 10];
    if (!expected.includes(cells.length))
      throw new Error(
        `Los Angeles Ethics candidate row has ${cells.length} totals; expected ${expected.join(" or ")}`,
      );
    return parseMetricCells(cells, cells.length === expected[1]);
  }

  // Older election pages render one reported-through cell followed by eight
  // direct metric cells instead of nested tables with border-top totals.
  const legacyCells = [
    ...candidateMainRow.matchAll(
      /<td\s+align=["']right["'][^>]*>([\s\S]*?)<\/td>/gi,
    ),
  ].map((match) => decodeHtml(match[1] ?? ""));
  const expected = matchingFundsOmitted ? [8, 10] : [9, 11];
  if (!expected.includes(legacyCells.length))
    throw new Error(
      `Los Angeles Ethics legacy candidate row has ${Math.max(0, legacyCells.length - 1)} totals; expected ${expected[0]! - 1} or ${expected[1]! - 1}`,
    );
  return parseMetricCells(
    legacyCells.slice(1),
    legacyCells.length === expected[1],
  );
}

export function parseLosAngelesEthicsCandidateTotals(input: {
  html: string;
  electionId: string;
  officeName: string;
}): LosAngelesEthicsCandidateTotal[] {
  const officeAnchor = new RegExp(
    `<a\\s+name=["']S(\\d+)["'][^>]*><\\/a>\\s*<h4><strong>${input.officeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:<\\/strong><\\/h4>`,
    "i",
  ).exec(input.html);
  if (officeAnchor?.index === undefined || !officeAnchor[1])
    throw new Error(
      `Los Angeles Ethics totals missing office section: ${input.officeName}`,
    );
  const start = officeAnchor.index + officeAnchor[0].length;
  const nextSeat = /<a\s+name=["']S\d+["'][^>]*><\/a>/i.exec(
    input.html.slice(start),
  );
  const section = input.html.slice(
    start,
    nextSeat ? start + nextSeat.index : undefined,
  );
  const anchors = [
    ...section.matchAll(/<a\s+name=["']C(\d+)["'][^>]*><\/a>/gi),
  ];
  if (anchors.length === 0)
    throw new Error(
      `Los Angeles Ethics ${input.officeName} section contains no candidates`,
    );
  const calendarText = decodeHtml(input.html);
  const sourceElectionDates = ["Primary", "General"].flatMap(phase => {
    const match = new RegExp(`${phase} Election:\\s*([A-Za-z]+)\\s+(\\d{1,2}),\\s*(20\\d{2})`, "i").exec(calendarText);
    if (!match) return [];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const month = months.findIndex(value => value.toLowerCase() === match[1]!.toLowerCase()) + 1;
    if (!month) return [];
    const date = `${match[3]}-${String(month).padStart(2,"0")}-${match[2]!.padStart(2,"0")}`;
    return Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date ? [date] : [];
  });
  const results: LosAngelesEthicsCandidateTotal[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    const blockStart = anchor.index ?? 0;
    const blockEnd = anchors[index + 1]?.index ?? section.length;
    const block = section.slice(blockStart, blockEnd);
    const mainEnd = block.search(
      new RegExp(`<tr\\s+class=["']C${anchor[1]}_detail`, "i"),
    );
    const main = block.slice(0, mainEnd < 0 ? block.length : mainEnd);
    const candidateName = decodeHtml(
      /class=["']candidatelink["'][^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/i.exec(
        main,
      )?.[1] ?? "",
    );
    const seatCandidateId = /elec_seat_cand_id=(\d+)/i.exec(block)?.[1] ?? null;
    const committee = /(?:^|>)\s*(\d{7})\s*-\s*([^<\r\n]+)/im.exec(block);
    const committeeIds = [
      ...new Set(
        [...block.matchAll(/(?:^|>)\s*(\d{7})\s*-/gim)].map(
          (match) => match[1]!,
        ),
      ),
    ];
    const detailRows = [...block.matchAll(new RegExp(
      `<tr\\b[^>]*\\bclass=["']C${anchor[1]}_detail\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/tr>`, "gi",
    ))].map(match => match[0]);
    const targetIds = new Set([...block.matchAll(/elec_seat_cand_id=(\d+)/gi)].map(match => match[1]!));
    // Current runoff pages combine explicitly labeled Primary and General
    // accounts. Accept only this verified pair under the same candidate and
    // one native IE target; other multi-committee shapes stay unresolved.
    const verifiedPair = committeeIds.length === 2 && sourceElectionDates.length === 2 && sourceElectionDates[0]! < sourceElectionDates[1]! &&
      sourceElectionDates[0]!.slice(0,4) === sourceElectionDates[1]!.slice(0,4) &&
      targetIds.size === 1 && committeeIds.every(id => detailRows.some(row => new RegExp(`(?:^|>)\\s*${id}\\s*-`, "m").test(row)));
    if (
      !candidateName ||
      !seatCandidateId ||
      !committee ||
      (committeeIds.length !== 1 && !verifiedPair)
    )
      continue;
    let totals: CandidateMetricTotals;
    try {
      totals = metricTotals(
        main,
        /^LAUSD District [1-7]$/i.test(input.officeName),
      );
    } catch {
      // One malformed candidate row must not discard every candidate
      // in the election. Caller records unresolved candidates individually.
      continue;
    }
    const reported = isoDateFromUs(
      /<\/td>\s*<td\s+align=["']right["'][^>]*>\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(
        main,
      )?.[1] ?? "",
    );
    committeeIds.sort();
    const anchorCommittee = new RegExp(`(?:^|>)\\s*${committeeIds[0]}\\s*-\\s*([^<\\r\\n]+)`, "im").exec(block);
    if (!anchorCommittee) continue;
    results.push({
      electionId: input.electionId,
      electionSeatId: officeAnchor[1],
      electionSeatCandidateId: seatCandidateId,
      candidatePersonId: anchor[1]!,
      candidateName,
      officeName: input.officeName,
      reportedThrough: reported,
      fppcCommitteeId: committeeIds[0]!,
      fppcCommitteeIds: committeeIds,
      sourceElectionDates: sourceElectionDates.length === 2 ? sourceElectionDates : undefined,
      committeeName: decodeHtml(anchorCommittee[1] ?? ""),
      internalCommitteePersonId: committee[1] === committeeIds[0] ? /\bcmt_per_id=(\d+)/i.exec(block)?.[1] ?? null : null,
      totalContributions: totals[0],
      totalExpenditures: totals[1],
      cashOnHand: totals[2],
      matchingFunds: totals[3],
      outsideSupportTotal: totals[4],
      outsideOpposeTotal: totals[5],
      membershipSupportTotal: totals[6],
      membershipOpposeTotal: totals[7],
      sourceUrl: buildLosAngelesEthicsElectionTotalsUrl(input.electionId),
    });
  }
  return results;
}

export function parseLosAngelesIndependentSpendingRows(
  payload: unknown,
  supportOppose: "support" | "oppose",
): LosAngelesEthicsIndependentSpendingRow[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { data?: unknown }).data)
  )
    throw new Error(
      "Los Angeles Ethics independent-spending response is missing data array",
    );
  const rows: LosAngelesEthicsIndependentSpendingRow[] = [];
  for (const raw of (payload as { data: unknown[] }).data) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const expenditureId = String(row.ie_id ?? "").trim();
    const spenderName = String(row.filer_name ?? "").trim();
    const candidateName =
      `${String(row.cand_fname ?? "").trim()} ${String(row.cand_lname ?? "").trim()}`.trim();
    const officeName = String(row.ofc_desc ?? "").trim();
    const disclosedSide = String(row.support_oppose ?? "")
      .trim()
      .toLowerCase();
    const amount =
      typeof row.ie_amt_xl === "number"
        ? row.ie_amt_xl
        : money(String(row.ie_amt_xl ?? ""));
    const spenderId =
      /\[(\d{4,12})\]\s*(?:<br>|$)/i.exec(String(row.ind_spender ?? ""))?.[1] ??
      `ethics:${spenderName.toUpperCase()}`;
    if (
      !expenditureId ||
      !spenderName ||
      !candidateName ||
      !officeName ||
      amount === null ||
      amount <= 0 ||
      !disclosedSide.startsWith(
        supportOppose === "support" ? "support" : "oppos",
      )
    )
      continue;
    const documentId = String(row.form496_document_id ?? "").trim();
    rows.push({
      expenditureId,
      spenderId,
      spenderName,
      candidateName,
      officeName,
      supportOppose,
      amount,
      reportUrl: /^\d+$/.test(documentId)
        ? `${LOS_ANGELES_ETHICS_BASE_URL}/viewdoc/${documentId}`
        : null,
    });
  }
  return rows;
}

export function buildLosAngelesEthicsElectionTotalsUrl(
  electionId: string,
): string {
  if (!/^\d+$/.test(electionId))
    throw new Error(`Invalid Los Angeles Ethics election id: ${electionId}`);
  return `${LOS_ANGELES_ETHICS_BASE_URL}/cfcs/Display/DisplayPanels.cfc?method=ElectionTotalsResults&useBS4Tabs=yes&showdates=yes&election_id=${electionId}`;
}

export async function getLosAngelesEthicsElections(
  options: LosAngelesCityEthicsClientOptions = {},
): Promise<LosAngelesEthicsElection[]> {
  return parseLosAngelesEthicsElectionIndex(
    String(
      await fetchResponse(LOS_ANGELES_ETHICS_ELECTIONS_URL, options, false),
    ),
  );
}
export async function getLosAngelesEthicsCandidateTotals(
  input: { electionId: string; officeName: string },
  options: LosAngelesCityEthicsClientOptions = {},
): Promise<LosAngelesEthicsCandidateTotal[]> {
  const html = String(
    await fetchResponse(
      buildLosAngelesEthicsElectionTotalsUrl(input.electionId),
      options,
      false,
    ),
  );
  return parseLosAngelesEthicsCandidateTotals({ ...input, html });
}
export async function getLosAngelesIndependentSpending(
  input: {
    electionSeatCandidateId: string;
    supportOppose: "support" | "oppose";
  },
  options: LosAngelesCityEthicsClientOptions = {},
): Promise<LosAngelesEthicsIndependentSpendingRow[]> {
  if (!/^\d+$/.test(input.electionSeatCandidateId))
    throw new Error("Invalid Los Angeles election seat candidate id");
  const url = new URL(`${LOS_ANGELES_ETHICS_BASE_URL}/dataresults`);
  url.searchParams.set("dtQuery", "cmpIndExpenditureSearch");
  url.searchParams.set("search_type_id", "14");
  url.searchParams.set(
    "support_oppose_flg",
    input.supportOppose === "support" ? "S" : "O",
  );
  url.searchParams.set("mc_flg", "0");
  url.searchParams.set("elec_seat_cand_id", input.electionSeatCandidateId);
  url.searchParams.set("layout", "compact");
  return parseLosAngelesIndependentSpendingRows(
    await fetchResponse(url.toString(), options, true),
    input.supportOppose,
  );
}
