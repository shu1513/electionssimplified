/** Small shared parsing primitives for the two observed Maine MapLight CSV schemas. */
type MaineMapLightCsvFailure = (message: string) => never;

export function parseMaineMapLightCsvRecords(
  csv: string,
  fail: MaineMapLightCsvFailure,
): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let state: "unquoted" | "quoted" | "closed" = "unquoted";
  let atFieldStart = true;
  const finishField = () => {
    record.push(field);
    field = "";
    state = "unquoted";
    atFieldStart = true;
  };
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (state === "quoted") {
      if (char !== '"') field += char;
      else if (csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else state = "closed";
      continue;
    }
    if (char === ",") {
      finishField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      finishField();
      records.push(record);
      record = [];
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
      continue;
    }
    if (state === "closed") fail("unexpected character after quoted field");
    if (char === '"') {
      if (!atFieldStart) fail("quote inside unquoted field");
      state = "quoted";
    } else field += char;
    atFieldStart = false;
  }
  if (state === "quoted") fail("unterminated quoted field");
  if (record.length || field || !atFieldStart) {
    finishField();
    records.push(record);
  }
  return records;
}

export function parseMaineMapLightCivilDate(
  value: string,
  fail: MaineMapLightCsvFailure,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("invalid transaction date");
  const [year, month, day] = value.split("-").map(Number);
  if (
    year < 1900 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    fail("invalid transaction date");
  return value;
}

export function parseMaineMapLightCents(
  value: string,
  fail: MaineMapLightCsvFailure,
): number {
  // Preserve signed facts. No rounding, implicit exponent, or malformed grouping.
  const matched = /^(?:(-)\$?|\$(-)?|)(\d+|\d{1,3}(?:,\d{3})+)?\.(\d{2})$/.exec(
    value,
  );
  if (!matched || (!matched[3] && !value.includes("$")))
    fail("invalid exact-cent amount");
  const dollars = Number((matched[3] ?? "0").replace(/,/g, ""));
  const amount = dollars * 100 + Number(matched[4]);
  if (!Number.isSafeInteger(amount))
    fail("amount exceeds safe exact-cent range");
  return matched[1] || matched[2] ? -amount : amount;
}

export function parseMaineMapLightSourceId(
  value: string,
  prefix: "a" | "f",
  fail: MaineMapLightCsvFailure,
): string {
  if (!new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value))
    fail("invalid source ID");
  return value;
}

export function requireMaineMapLightIdentityText(
  value: string,
  fail: MaineMapLightCsvFailure,
): string {
  if (!value.trim()) fail("missing source identity text");
  return value;
}
