import { createHash } from "node:crypto";

export type ArizonaReportedKind = "committee" | "ie";
export const AZ_REPORTED_REVISION = "az-native-cycle-components-1";
export class ArizonaReportedHold extends Error {
  constructor(readonly reason: string) { super(`Arizona reported finance held: ${reason}`); this.name = "ArizonaReportedHold"; }
}
export function azHold(reason: string): never { throw new ArizonaReportedHold(reason); }
export const azHash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
export const azCanonical = (value: unknown): string => JSON.stringify(value, (_, v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const azIso = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function azFreeze(value: any): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const v of Object.values(value)) azFreeze(v);
  }
}
export function azLiteral(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) azHold("native_text");
  return value;
}
export function azInteger(value: unknown, zero = true): number {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) azHold("native_integer");
  return value;
}
export const azId = (value: unknown): string => String(azInteger(value, false));
export function azAdd(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) azHold("unsafe_sum");
  return a + b;
}
/** Preserve native decimal lexemes before financial parsing. JSON.parse alone
 * would lose precision before an integer or cent check could reject it. */
export function parseArizonaReportedJson(text: string): any {
  let out = "", quoted = false, escaped = false;
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (quoted) {
      out += c; i++;
      if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; out += c; i++; }
    else if (c === "-" || /[0-9]/.test(c)) {
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!number) azHold("native_json_number");
      out += JSON.stringify(number[0]); i += number[0].length;
    } else { out += c; i++; }
  }
  try { return JSON.parse(out); } catch { return azHold("native_json"); }
}
/** Amounts are native ten-thousandths of a dollar, including signed returns.
 * Fractional cents remain intact for source/parent occurrence comparison. */
export function azUnits(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) azHold("native_amount");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const n = (BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, "0"))) * (value.startsWith("-") ? -1n : 1n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) * 100n || n < -BigInt(Number.MAX_SAFE_INTEGER) * 100n) azHold("unsafe_amount");
  return n;
}
export function azCents(units: bigint): number {
  if (units % 100n) azHold("fractional_cent_allocation");
  const n = Number(units / 100n); if (!Number.isSafeInteger(n)) azHold("unsafe_amount"); return n;
}
export function azNativeDay(value: unknown): string {
  if (typeof value !== "string") azHold("native_day");
  const match = /^\/Date\((-?\d+)\)\/$/.exec(value);
  if (!match) azHold("native_day");
  const time = Number(match[1]); if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime())) azHold("native_day");
  return new Date(time).toISOString().slice(0, 10);
}
const captureDayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" });
let lastCaptureClock = "", lastCaptureDay = "";
export function azCaptureDay(capturedAt: string): string {
  if (!azIso(capturedAt)) azHold("capture_clock");
  if (capturedAt === lastCaptureClock) return lastCaptureDay;
  const parts = captureDayFormatter.formatToParts(new Date(capturedAt));
  const p = (type: string) => parts.find(x => x.type === type)!.value;
  lastCaptureClock = capturedAt; lastCaptureDay = `${p("year")}-${p("month")}-${p("day")}`;
  return lastCaptureDay;
}
export function azCheckDay(day: string, capturedAt: string): void {
  if (day < "2025-01-01" || day > "2026-12-31" || day > azCaptureDay(capturedAt)) azHold("row_outside_capture_window");
}
export function azBag(values: readonly unknown[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) { const k = azCanonical(value); result.set(k, (result.get(k) ?? 0) + 1); }
  return result;
}
export function azSameBag(a: readonly unknown[], b: readonly unknown[]): boolean {
  const x = azBag(a), y = azBag(b);
  return x.size === y.size && [...x].every(([k, n]) => y.get(k) === n);
}

const FIELDS = ["Amount", "City", "CommitteeGroupNumber", "CommitteeID", "CommitteeName", "Employer", "EntityDescription", "FilerName", "FirstName", "LastName", "Memo", "Occupation", "State", "TransactionDate", "TransactionGroupNumber", "TransactionName", "TransactionNameID", "TransactionType", "TransactionTypeDispositionID", "TransactionTypeId", "ZipCode"].sort();
const FINANCIAL_FIELDS = ["TransactionDate", "TransactionName", "TransactionTypeId", "FirstName", "LastName", "Occupation", "Employer", "City", "State", "ZipCode", "Memo"] as const;
export type ArizonaReportedNativeRow = Readonly<{
  raw: Readonly<Record<string, unknown>>; day: string; units: bigint; committeeId: string;
  committeeName: string; name: string | null; typeId: string; typeName: string | null;
}>;
export function parseArizonaReportedRow(value: unknown, capturedAt: string): ArizonaReportedNativeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) azHold("native_row");
  const raw = value as Record<string, unknown>;
  if (azCanonical(Object.keys(raw).sort()) !== azCanonical(FIELDS)) azHold("native_row_schema");
  const day = azNativeDay(raw.TransactionDate); azCheckDay(day, capturedAt);
  const committeeName = azLiteral(raw.CommitteeName)!; if (!committeeName.trim()) azHold("native_filer_name");
  const row = { raw, day, units: azUnits(raw.Amount), committeeId: String(azInteger(raw.CommitteeID)),
    committeeName, name: azLiteral(raw.TransactionName, true), typeId: azId(raw.TransactionTypeId), typeName: azLiteral(raw.TransactionType, true) };
  for (const key of ["CommitteeGroupNumber", "TransactionGroupNumber", "TransactionNameID", "TransactionTypeDispositionID"]) azInteger(raw[key]);
  for (const key of ["City", "State", "ZipCode", "Employer", "Occupation", "FirstName", "LastName", "Memo", "EntityDescription", "FilerName"]) azLiteral(raw[key], true);
  azFreeze(row); return row;
}
export function azFinancialKey(row: ArizonaReportedNativeRow, magnitude = false): unknown {
  return { ...Object.fromEntries(FINANCIAL_FIELDS.map(k => [k, row.raw[k]])),
    Amount: (magnitude && row.units < 0n ? -row.units : row.units).toString() };
}
export function parseArizonaReportedTable(value: any, capturedAt: string): ArizonaReportedNativeRow[] {
  if (!value || azCanonical(Object.keys(value).sort()) !== azCanonical(["data", "draw", "recordsFiltered", "recordsTotal"]) || !Array.isArray(value.data)) azHold("native_table_schema");
  if (azInteger(value.draw, false) !== 1 || azInteger(value.recordsTotal) > 20000 ||
    azInteger(value.recordsTotal) !== azInteger(value.recordsFiltered) || value.data.length !== azInteger(value.recordsFiltered)) azHold("incomplete_native_population");
  return value.data.map((r: unknown) => parseArizonaReportedRow(r, capturedAt));
}
