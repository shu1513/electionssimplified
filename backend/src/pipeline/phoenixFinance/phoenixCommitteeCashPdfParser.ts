import {
  phoenixMoneyTokenToCents,
  type PhoenixPdfLine,
  type PhoenixPdfPage,
} from "./phoenixReportPdfParser.js";

export type PhoenixCommitteeCashOccurrence = {
  role: "pac_gift" | "returned_contribution";
  schedule: "A1e" | "A1l";
  pageNumber: number;
  rowOrdinal: number;
  rawName: string;
  /** Civil date as published; no timezone conversion. */
  rawDate: string;
  amountCents: number;
};

export type PhoenixCommitteeCashReport = {
  receivingCopId: string;
  pacGifts: PhoenixCommitteeCashOccurrence[];
  returns: PhoenixCommitteeCashOccurrence[];
  controls: { pacCashCents: number; returnedCashCents: number };
};

function fail(reason: string): never {
  throw new Error(`Phoenix committee cash PDF: ${reason}`);
}

function money(text: string): number {
  const unsigned = String.raw`\$(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.\d{2}`;
  if (!new RegExp(`^(?:${unsigned}|\\(${unsigned}\\))$`).test(text)) {
    return fail("invalid monetary token");
  }
  const digits = text.replace(/[()$,]/g, "");
  const [dollars, fraction] = digits.split(".");
  const exact = BigInt(dollars!) * 100n + BigInt(fraction!);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER))
    return fail("unsafe monetary amount");
  const cents = phoenixMoneyTokenToCents(text);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) !== Number(exact))
    return fail("unsafe monetary amount");
  return cents;
}

function amounts(line: PhoenixPdfLine) {
  return line.cells
    .filter((cell) => cell.text.includes("$") && cell.x >= 350)
    .map((cell) => ({ x: cell.x, cents: money(cell.text) }));
}

function add(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) return fail("unsafe monetary sum");
  return result;
}

function date(raw: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) return fail("missing or invalid civil date");
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return fail("invalid civil date");
  }
  return raw;
}

function copId(page: PhoenixPdfPage): string {
  const ids = page.lines
    .filter((line) => line.y > 700)
    .flatMap((line) => line.cells.map((cell) => cell.text))
    .filter((text) => /^(?:CAN|PAC)-\d{2}-[1-9]\d*$/.test(text));
  if (ids.length !== 1) return fail("missing or ambiguous receiving COPID");
  return ids[0]!;
}

const schedules = [
  {
    schedule: "A1e",
    suffix: "e",
    role: "pac_gift",
    title:
      "MONETARY CONTRIBUTIONS FROM POLITICAL ACTION COMMITTEES: SCHEDULE A(1)(e)",
    anchor: /^Committee Name(?: |$)/,
  },
  {
    schedule: "A1l",
    suffix: "l",
    role: "returned_contribution",
    title: "REFUNDS GIVEN BACK TO CONTRIBUTORS: SCHEDULE A(1)(l)",
    anchor: /^Name Date Contribution Refunded(?: |$)/,
  },
] as const;

/** Source facts only. Current editions, full cycle coverage and return donor
 * ownership remain prerequisites of a separate source qualification layer. */
export function parsePhoenixCommitteeCashReport(
  pages: readonly PhoenixPdfPage[],
): PhoenixCommitteeCashReport {
  if (
    !pages.length ||
    new Set(pages.map((page) => page.pageNumber)).size !== pages.length ||
    pages.some(
      (page) => !Number.isSafeInteger(page.pageNumber) || page.pageNumber <= 0,
    )
  ) {
    return fail("invalid physical page identities");
  }
  const summaryPages = pages.filter((page) =>
    page.lines.some((line) => /^SUMMARY OF RECEIPTS/.test(line.text)),
  );
  if (summaryPages.length !== 1)
    return fail("missing or ambiguous receipts summary");
  const summary = summaryPages[0]!;
  const receivingCopId = copId(summary);
  const control = (label: RegExp): number => {
    const matches = summary.lines.filter(
      (line) =>
        label.test(line.text) &&
        amounts(line).some((cell) => cell.x >= 400 && cell.x < 462),
    );
    if (matches.length !== 1) return fail("missing or ambiguous cash control");
    const values = amounts(matches[0]!).filter(
      (cell) => cell.x >= 400 && cell.x < 462,
    );
    if (values.length !== 1) return fail("invalid cash control");
    return values[0]!.cents;
  };
  const controls = {
    pacCashCents: control(/^\(e\) Political Action Committees(?: |$)/),
    returnedCashCents: control(
      /^\(l\) Refunds Given Back to Contributors(?: |$)/,
    ),
  };
  const result: PhoenixCommitteeCashReport = {
    receivingCopId,
    pacGifts: [],
    returns: [],
    controls,
  };
  for (const spec of schedules) {
    const selected = pages.filter((page) =>
      page.lines.some((line) => line.text === spec.title),
    );
    // A near heading with the same schedule cannot silently become an absent page.
    for (const page of pages) {
      if (
        page.lines.some((line) =>
          line.text.includes(`SCHEDULE A(1)(${spec.suffix})`),
        ) &&
        !selected.includes(page)
      ) {
        return fail("unsupported schedule heading");
      }
    }
    const occurrences: PhoenixCommitteeCashOccurrence[] = [];
    const sequence = new Map<number, number>();
    let finalTotal: number | undefined;
    for (const page of selected) {
      if (copId(page) !== receivingCopId)
        return fail("receiving COPID mismatch");
      const footers = page.lines
        .map((line) =>
          new RegExp(
            `^SCHEDULE A\\(1\\)\\(${spec.suffix}\\), page ([1-9]\\d*) of ([1-9]\\d*)$`,
          ).exec(line.text),
        )
        .filter((match) => match !== null);
      if (footers.length !== 1)
        return fail("missing or ambiguous schedule pagination");
      const current = Number(footers[0]![1]);
      const count = Number(footers[0]![2]);
      if (
        !Number.isSafeInteger(current) ||
        !Number.isSafeInteger(count) ||
        current > count ||
        sequence.has(current)
      )
        return fail("invalid schedule pagination");
      sequence.set(current, count);
      const lines = [...page.lines].sort((a, b) => b.y - a.y);
      const anchors = lines
        .map((line, index) => (spec.anchor.test(line.text) ? index : -1))
        .filter((index) => index >= 0);
      const usedMoney = new Set<PhoenixPdfLine>();
      for (const [ordinal, index] of anchors.entries()) {
        const anchor = lines[index]!;
        const values = amounts(anchor);
        if (
          values.length !== 3 ||
          values[0]!.x < 350 ||
          values[0]!.x >= 410 ||
          values[1]!.x < 430 ||
          values[1]!.x >= 480 ||
          values[2]!.x < 500 ||
          values[2]!.x >= 555
        )
          return fail("invalid schedule monetary columns");
        usedMoney.add(anchor);
        const end = anchors[ordinal + 1] ?? lines.length;
        const body = lines.slice(index + 1, end);
        const streetIndex = body.findIndex((line) =>
          /^Street Address(?: |$)/.test(line.text),
        );
        if (streetIndex < 1) return fail("missing name field boundary");
        const nameLines = body.slice(0, streetIndex);
        const nameMax = spec.schedule === "A1e" ? 350 : 250;
        const rawName = nameLines
          .flatMap((line) =>
            line.cells
              .filter((cell) => cell.x >= 50 && cell.x < nameMax)
              .map((cell) => cell.text),
          )
          .join(" ")
          .trim();
        if (!rawName || nameLines.some((line) => anchor.y - line.y > 25))
          return fail("missing or shifted name field");
        let dateCells;
        if (spec.schedule === "A1e") {
          const dateLabel = body.findIndex(
            (line) =>
              line.text === "Committee ID Number Date Contribution Received",
          );
          if (dateLabel < 0) return fail("missing PAC receipt date label");
          const dateLine = body[dateLabel + 1];
          if (!dateLine || body[dateLabel]!.y - dateLine.y > 18)
            return fail("shifted receipt date");
          dateCells = dateLine.cells.filter(
            (cell) => cell.x >= 180 && cell.x < 350,
          );
        } else {
          dateCells = nameLines.flatMap((line) =>
            line.cells.filter((cell) => cell.x >= 250 && cell.x < 350),
          );
        }
        if (dateCells.length !== 1)
          return fail("missing or ambiguous schedule date");
        occurrences.push({
          role: spec.role,
          schedule: spec.schedule,
          pageNumber: page.pageNumber,
          rowOrdinal: ordinal + 1,
          rawName,
          rawDate: date(dateCells[0]!.text),
          amountCents: values[0]!.cents,
        });
      }
      const totals = lines.filter((line) =>
        /^Enter total only if last page of schedule(?: |$)/.test(line.text),
      );
      if (totals.length !== 1)
        return fail("missing or ambiguous schedule total field");
      const totalValues = amounts(totals[0]!);
      usedMoney.add(totals[0]!);
      if (current === count) {
        if (
          finalTotal !== undefined ||
          totalValues.length !== 2 ||
          totalValues[0]!.x < 430 ||
          totalValues[0]!.x >= 480 ||
          totalValues[1]!.x < 500 ||
          totalValues[1]!.x >= 555
        )
          return fail("invalid final schedule total");
        finalTotal = totalValues[0]!.cents;
      } else if (totalValues.length) return fail("nonfinal schedule total");
      const firstRowY = anchors.length ? lines[anchors[0]!]!.y : totals[0]!.y;
      const totalY = totals[0]!.y;
      if (
        lines.some(
          (line) =>
            (amounts(line).length && !usedMoney.has(line)) ||
            (line.y <= firstRowY &&
              line.y >= totalY &&
              line.cells.some(
                (cell) =>
                  cell.x >= 350 && cell.x < 555 && !cell.text.includes("$"),
              )),
        )
      )
        return fail("unparsed schedule monetary activity");
    }
    const expected =
      spec.schedule === "A1e"
        ? controls.pacCashCents
        : controls.returnedCashCents;
    if (selected.length) {
      if (
        [...sequence.values()].some((count) => count !== selected.length) ||
        [...sequence.keys()].some((n) => n > selected.length) ||
        finalTotal !== expected
      )
        return fail("incomplete schedule or total mismatch");
    } else if (expected !== 0) return fail("missing positive schedule");
    if (
      occurrences.reduce((sum, row) => add(sum, row.amountCents), 0) !==
      expected
    )
      return fail("itemized cash/control mismatch");
    (spec.schedule === "A1e" ? result.pacGifts : result.returns).push(
      ...occurrences.sort(
        (a, b) => a.pageNumber - b.pageNumber || a.rowOrdinal - b.rowOrdinal,
      ),
    );
  }
  return result;
}
