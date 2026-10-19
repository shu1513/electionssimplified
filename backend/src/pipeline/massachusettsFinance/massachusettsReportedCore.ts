import { createHash } from "node:crypto";
export {
  MassachusettsReportedHold,
  maReportedHold as maHold,
  maReportedLiteral as maLiteral,
  maReportedAdd as maAdd,
  maReportedCents as maCents,
  maReportedDay as maDay,
} from "./massachusettsReportedCommitteeAggregator.js";

export type MassachusettsReportedKind = "committee" | "ie";
export const MA_REPORTED_REVISION = "ma-native-calendar-components-1";
export const maHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const maIso = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function maCanonical(value: unknown): string {
  return JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
export function maFreeze(value: any): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) maFreeze(item);
  }
}
