import { createRequire } from "node:module";
import {
  firstNamesConflict,
  firstNameVariants,
} from "../finance/personFirstNameNicknames.js";
import {
  hasMiddleNameConflict,
  personNameParseVariants,
  personNamesMatchWithMiddleEvidence,
} from "../finance/personNameMiddleEvidence.js";

export const VIRGINIA_REPORTED_ORIGIN =
  "https://cfreports.elections.virginia.gov";
export const VIRGINIA_REPORTED_URLS = {
  ie: `${VIRGINIA_REPORTED_ORIGIN}/IE`,
  campaign: `${VIRGINIA_REPORTED_ORIGIN}/`,
  roster: "https://www.elections.virginia.gov/casting-a-ballot/candidate-list/",
} as const;
export type VirginiaReportedComponent = "committee" | "ie";

export class VirginiaReportedSourceError extends Error {
  constructor(readonly code: string) {
    super(`Virginia reported finance held: ${code}`);
    this.name = "VirginiaReportedSourceError";
  }
}
export function vaCheck(value: unknown, code: string): asserts value {
  if (!value) throw new VirginiaReportedSourceError(code);
}
export const vaText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();
export const vaKey = (value: string): string => vaText(value).toUpperCase();
export function vaAdd(a: number, b: number): number {
  const sum = a + b;
  vaCheck(
    Number.isSafeInteger(a) &&
      Number.isSafeInteger(b) &&
      Number.isSafeInteger(sum),
    "amount_overflow",
  );
  return sum;
}

/** Parse filed signs and exact cents; never round producer decimals. */
export function vaCents(value: string): number {
  let text = value.trim(),
    negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    vaCheck(!negative, "amount_sign");
    negative = true;
    text = text.slice(1);
  }
  if (text.startsWith("$")) text = text.slice(1);
  if (text.startsWith("-")) {
    vaCheck(!negative, "amount_sign");
    negative = true;
    text = text.slice(1);
  }
  vaCheck(/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text), "amount_format");
  const [whole, fractional = ""] = text.replace(/,/g, "").split(".");
  vaCheck(!/[1-9]/.test(fractional.slice(2)), "fractional_cent");
  const cents =
    (BigInt(whole!) * 100n + BigInt(fractional.slice(0, 2).padEnd(2, "0"))) *
    (negative ? -1n : 1n);
  vaCheck(
    cents <= BigInt(Number.MAX_SAFE_INTEGER) &&
      cents >= BigInt(Number.MIN_SAFE_INTEGER),
    "amount_overflow",
  );
  return Number(cents);
}

/** A filing calendar date is not an observation timestamp. */
export function vaDate(value: string): string {
  const raw = value.trim(),
    us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw),
    iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  vaCheck(us || iso, "date_format");
  const year = Number(us?.[3] ?? iso![1]),
    month = Number(us?.[1] ?? iso![2]),
    day = Number(us?.[2] ?? iso![3]),
    date = new Date(Date.UTC(year, month - 1, day));
  vaCheck(
    year >= 1900 &&
      year <= 2100 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day,
    "date_value",
  );
  return date.toISOString().slice(0, 10);
}
export function vaSubmittedDay(value: string): string {
  const match =
    /^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/.exec(
      value.trim(),
    );
  vaCheck(match, "registration_date_format");
  if (match[2])
    vaCheck(
      Number(match[3]) < 60 &&
        Number(match[4] ?? 0) < 60 &&
        (match[5]
          ? Number(match[2]) >= 1 && Number(match[2]) <= 12
          : Number(match[2]) <= 23),
      "registration_time_value",
    );
  return vaDate(match[1]!);
}

const normalizePerson = (value: string) =>
  value
    .replace(/["\u201c\u201d][^"\u201c\u201d]*["\u201c\u201d]/g, " ")
    .replace(/^(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(?:JR|SR|II|III|IV)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const equivalentFirst = (a: string, b: string) =>
  a === b || firstNameVariants(a).includes(b);
export function vaPersonMatches(
  aliases: readonly string[],
  sourceName: string,
  structuredGivenNames: readonly string[] = [],
): boolean {
  const names = aliases.filter((name) => name.trim()),
    firsts = [
      ...new Set(
        personNameParseVariants(sourceName, normalizePerson).map(
          (name) => name.first,
        ),
      ),
    ];
  return (
    firsts.length > 0 &&
    names.length > 0 &&
    structuredGivenNames.every((given) =>
      firsts.every(
        (first) =>
          !firstNamesConflict(
            normalizePerson(given).split(" ")[0] ?? "",
            first,
          ),
      ),
    ) &&
    names.every(
      (candidateName) =>
        !hasMiddleNameConflict({
          candidateName,
          rowNames: [sourceName],
          normalizePersonName: normalizePerson,
          firstNamesEquivalent: equivalentFirst,
        }),
    ) &&
    names.some((candidateName) =>
      personNamesMatchWithMiddleEvidence({
        candidateName,
        rowNames: [sourceName],
        normalizePersonName: normalizePerson,
        firstNamesEquivalent: equivalentFirst,
      }),
    )
  );
}

export function vaPublicUrl(value: string, base: string): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new VirginiaReportedSourceError("source_url");
  }
  vaCheck(
    [
      VIRGINIA_REPORTED_ORIGIN,
      "https://www.elections.virginia.gov",
      "https://cf.elections.virginia.gov",
      "https://law.lis.virginia.gov",
    ].includes(url.origin) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "source_origin",
  );
  return url.href;
}
const require = createRequire(import.meta.url);
export function vaDocument(raw: Uint8Array, xml = false): Document {
  const { JSDOM, VirtualConsole } = require("jsdom") as {
    JSDOM: new (
      text: string,
      options: object,
    ) => { window: { document: Document } };
    VirtualConsole: new () => unknown;
  };
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  vaCheck(!text.includes("\0"), "source_nul");
  const document = new JSDOM(text, {
    contentType: xml ? "text/xml" : "text/html",
    virtualConsole: new VirtualConsole(),
  }).window.document;
  vaCheck(!document.querySelector("parsererror"), "source_xml");
  return document;
}
export const vaNodeText = (node: Node): string =>
  vaText(node.textContent ?? "");
export function vaField(
  node: ParentNode,
  selector: string,
  empty = false,
): string {
  const nodes = node.querySelectorAll(selector);
  vaCheck(nodes.length === 1, "native_field_count");
  const text = vaNodeText(nodes[0]!);
  vaCheck(empty || text, "native_field_empty");
  return text;
}
export const vaPostal = (value: string): string =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
export function vaHouseSeat(value: string): string | null {
  const tokens = vaKey(value)
    .replace(/(\d+)(?:ST|ND|RD|TH)\b/g, "$1")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ");
  const digits = tokens.filter((t) => /^\d+$/.test(t));
  if (
    digits.length !== 1 ||
    Number(digits[0]) < 1 ||
    Number(digits[0]) > 100 ||
    !tokens.every(
      (t) =>
        /^\d+$/.test(t) ||
        [
          "MEMBER",
          "HOUSE",
          "OF",
          "DELEGATES",
          "DISTRICT",
          "NO",
          "NUMBER",
          "VA",
          "VIRGINIA",
        ].includes(t),
    )
  )
    return null;
  return String(Number(digits[0]));
}
