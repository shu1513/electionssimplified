import { createHash } from "node:crypto";

export type HawaiiReportedKind = "committee" | "ie";
export const HI_REPORTED_REVISION = "hi-published-ledger-components-1";

export class HawaiiReportedHold extends Error {
  constructor(public readonly code: string) {
    super(`Hawaii reported finance held: ${code}`);
  }
}
export function hiHold(code: string): never { throw new HawaiiReportedHold(code); }
export const hiHash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const hiLiteral = (value: string): string => value.normalize("NFC").trim().replace(/\s+/g, " ");
export const hiNameKey = (value: string): string => hiLiteral(value).normalize("NFKC").toUpperCase();
export function hiText(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) hiHold("invalid_text");
  return hiLiteral(value);
}
export function hiRequired(value: unknown): string {
  const text = hiText(value);
  if (!text || text.length > 2_000) hiHold("missing_source_text");
  return text;
}
export function hiAdd(a: number, b: number): number {
  const result = a + b;
  if (![a, b, result].every(Number.isSafeInteger)) hiHold("unsafe_money");
  return result;
}
/** Exact source cents. JSON floating-point numbers never confer money authority. */
export function hiCents(value: unknown): number {
  const raw = hiRequired(value);
  if (/\d\s+\d/.test(raw)) hiHold("invalid_money");
  let text = raw.replace(/\s/g, ""), negative = false;
  if (text.startsWith("(") && text.endsWith(")")) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith("-")) { if (negative) hiHold("invalid_money"); negative = true; text = text.slice(1); }
  if (text.startsWith("$")) text = text.slice(1);
  if (text.startsWith("-")) { if (negative) hiHold("invalid_money"); negative = true; text = text.slice(1); }
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) hiHold("invalid_money");
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  const cents = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")));
  if (!Number.isSafeInteger(cents)) hiHold("unsafe_money");
  return negative ? -cents : cents;
}
export function hiDay(value: unknown): string {
  const raw = hiRequired(value), match = /^(\d{4}-\d\d-\d\d)(?:T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?)?$/.exec(raw);
  if (!match || (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59))) hiHold("invalid_source_date");
  const day = match[1]!, parsed = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) hiHold("invalid_source_date");
  return day;
}
/** Filing calendar days follow Hawaii time. Replay uses the original capture
 * instant, so an originally future-dated row cannot age into valid authority. */
export function hiHawaiiDay(instant: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) hiHold("invalid_capture_clock");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Honolulu", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).map(p => [p.type, p.value]));
  return hiDay(`${parts.year}-${parts.month}-${parts.day}`);
}
export const hiCanonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function hiFreeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) hiFreeze(child);
  }
}
