import { TextDecoder } from "node:util";

export const NM_REPORTED_ORIGIN = "https://login.cfis.sos.state.nm.us";
export const NM_REPORTED_PATHS = {
  registry: "/api/Organization/SearchCandidates",
  transactions: "/api/Search/TransactionSearchInformation",
  contribution: "/api/Public/GetTransactionDetailsByTransactionID",
  expenditure: "/api/Public/GetExpenditureDetails",
  history: "/api/Public/GetHistoryTransactionDetailsByTransactionID",
  receiver: "/api/Organization/GetCandidatesInformation",
  donor: "/api/Organization/GetCommitteeInformation",
  cycle: "/api/Public/GetAdministrationElectionCycleInformation",
} as const;
export type NewMexicoReportedKind =
  "registry" | "receiver" | "committee" | "ie";
export type NmNativeObject = Record<string, unknown>;

export class NewMexicoReportedSourceError extends Error {
  constructor(readonly code: string) {
    super(`New Mexico reported finance held: ${code}`);
    this.name = "NewMexicoReportedSourceError";
  }
}
export function nmCheck(value: unknown, code: string): asserts value {
  if (!value) throw new NewMexicoReportedSourceError(code);
}
export function nmObject(value: unknown): NmNativeObject {
  nmCheck(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "native_object",
  );
  return value as NmNativeObject;
}
export function nmString(value: unknown, code = "native_string"): string {
  nmCheck(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 4096 &&
      !/[\u0000-\u001f]/.test(value),
    code,
  );
  return value;
}
export function nmId(value: unknown): number {
  nmCheck(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "native_id",
  );
  return value;
}
export function nmEmptyDistrictId(value: unknown): number | null {
  if (value === null || value === 0) return null;
  return nmId(value);
}
export const nmKey = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
export function nmAdd(a: number, b: number): number {
  nmCheck(
    Number.isSafeInteger(a) &&
      Number.isSafeInteger(b) &&
      Number.isSafeInteger(a + b),
    "money_overflow",
  );
  return a + b;
}

/** Decimal tokens come from the unchanged JSON original, before Number can
 * round them. Fractional cents are unavailable, never rounded or truncated. */
export function nmCents(value: unknown): number {
  nmCheck(typeof value === "string", "exact_money_token_required");
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  nmCheck(
    match && !/[1-9]/.test((match[3] ?? "").slice(2)),
    "fractional_or_invalid_money",
  );
  const cents =
    (BigInt(match[2]!) * 100n +
      BigInt((match[3] ?? "").padEnd(2, "0").slice(0, 2))) *
    (match[1] ? -1n : 1n);
  nmCheck(
    cents <= BigInt(Number.MAX_SAFE_INTEGER) &&
      cents >= BigInt(Number.MIN_SAFE_INTEGER),
    "money_overflow",
  );
  return Number(cents);
}

/** Preserve exact native Amount/TransactionAmount tokens in the parsed model.
 * This does not edit the original. The lexical pass also rejects duplicate
 * decoded keys, including escaped duplicates, at every nesting depth. */
export function parseNewMexicoReportedJson(raw: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    JSON.parse(text);
  } catch {
    throw new NewMexicoReportedSourceError("native_json");
  }
  const stack: ({ type: "object"; keys: Set<string> } | { type: "array" })[] =
    [];
  const pieces: string[] = [];
  let copied = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") stack.push({ type: "object", keys: new Set() });
    else if (char === "[") stack.push({ type: "array" });
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === "\\") i += 2;
        else if (text[i] === '"') break;
        else i++;
      }
      const end = i + 1;
      let colon = end;
      while (/\s/.test(text[colon] ?? "") && colon < text.length) colon++;
      if (text[colon] !== ":") continue;
      const object = stack.at(-1);
      nmCheck(object?.type === "object", "native_json_structure");
      const key = JSON.parse(text.slice(start, end)) as string;
      nmCheck(!object.keys.has(key), "duplicate_native_json_key");
      object.keys.add(key);
      if (key !== "Amount" && key !== "TransactionAmount") continue;
      let valueStart = colon + 1;
      while (/\s/.test(text[valueStart] ?? "") && valueStart < text.length)
        valueStart++;
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        text.slice(valueStart),
      );
      if (!number) {
        nmCheck(
          text.slice(valueStart, valueStart + 4) === "null",
          "native_money_number_required",
        );
        continue;
      }
      pieces.push(text.slice(copied, valueStart), JSON.stringify(number[0]));
      copied = valueStart + number[0].length;
      i = copied - 1;
    }
  }
  pieces.push(text.slice(copied));
  return JSON.parse(pieces.join("")) as unknown;
}

export function nmDate(value: unknown, observedAt: string): string {
  const text = nmString(value, "native_transaction_date");
  const date =
    /^((?:20\d{2})-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(
      text,
    )?.[1];
  const parsed = new Date((date ?? "invalid") + "T00:00:00Z");
  nmCheck(
    date &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === date,
    "native_transaction_date",
  );
  const observation = new Date(observedAt);
  nmCheck(Number.isFinite(observation.getTime()), "original_observation_clock");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(observation);
  const localDay = ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("-");
  nmCheck(date <= localDay, "future_at_original_observation");
  return date;
}

export function nmCountedRows(
  value: unknown,
  expectedOffset: number,
  pageSize: number,
  expectedTotal?: number,
): { rows: NmNativeObject[]; total: number } {
  nmCheck(
    Array.isArray(value) && value.length > 0,
    "native_population_without_count",
  );
  const rows = value.map(nmObject),
    total = nmId(rows[0]!.TotalRows);
  nmCheck(
    (expectedTotal === undefined || total === expectedTotal) &&
      rows.every((row) => row.TotalRows === total),
    "native_count_changed",
  );
  nmCheck(
    expectedOffset < total &&
      rows.length === Math.min(pageSize, total - expectedOffset),
    "incomplete_native_page",
  );
  return { rows, total };
}
