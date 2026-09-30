// Which bill a candidate record is about, derived from the description and
// the source URL, so the track record can show a bill's amendment votes and
// its final vote together even when their area tags put them in different
// groups (live: a DC councilmember's three Secure DC amendment votes sat
// under Civil Rights while her vote FOR the final bill sat under Public
// Safety, and the Civil Rights group read as "4 support"). Null when no bill
// identifier can be read; a null never links records.

// Session window for bill numbers: legislatures reuse "HB 1" every session,
// so a bare number keys with the two-year session (odd start year) of the
// record's event date. Named acts and DC-style period-prefixed numbers carry
// their own identity and need no window.
function sessionWindow(eventDate: string): string {
  const year = Number.parseInt(eventDate.slice(0, 4), 10);
  if (!Number.isFinite(year)) {
    return "";
  }
  return String(year % 2 === 0 ? year - 1 : year);
}

// Every source collapses to ONE shape — "<PREFIX><NUMBER>:<session start year>"
// (DC keeps its period-prefixed number as "dc:B25-0345") — so a bill cited by
// its official page and the same bill named in a description key alike.
// Federal prefixes follow congress.gov's own: H.R. (House bill) is "HR",
// S. is "S", H.Res. is "HRES", H.J.Res. is "HJRES", H.Con.Res. is "HCONRES".
const CONGRESS_KIND_PREFIX: Record<string, string> = {
  "house-bill": "HR",
  "senate-bill": "S",
  "house-resolution": "HRES",
  "senate-resolution": "SRES",
  "house-joint-resolution": "HJRES",
  "senate-joint-resolution": "SJRES",
  "house-concurrent-resolution": "HCONRES",
  "senate-concurrent-resolution": "SCONRES",
};

const URL_BILL_PATTERNS: readonly { pattern: RegExp; key: (match: RegExpMatchArray) => string | null }[] = [
  // DC LIMS: /Legislation/B25-0345
  { pattern: /lims\.dccouncil\.gov\/legislation\/([a-z]{1,3}\d{1,2}-\d{3,4})/i, key: (m) => `dc:${m[1]!.toUpperCase()}` },
  // LegiScan: /XX/bill/HB123/2024 (the year is the session's start year).
  { pattern: /legiscan\.com\/[a-z]{2}\/bill\/([a-z]{1,6}\d{1,5})\/(\d{4})/i, key: (m) => `${m[1]!.toUpperCase()}:${sessionWindow(m[2]!)}` },
  // Massachusetts: /Bills/193/H4000 — the 193rd General Court sat 2023-24.
  { pattern: /malegislature\.gov\/bills\/(\d{2,3})\/([hs]\d{1,5})/i, key: (m) => `${m[2]!.toUpperCase()}:${2 * Number.parseInt(m[1]!, 10) + 1637}` },
  // Congress.gov: /bill/118th-congress/house-bill/1470 — the 118th Congress sat 2023-24.
  {
    pattern: /congress\.gov\/bill\/(\d{2,3})(?:st|nd|rd|th)-congress\/([a-z-]+)\/(\d{1,5})/i,
    key: (m) => {
      const prefix = CONGRESS_KIND_PREFIX[m[2]!.toLowerCase()];
      return prefix ? `${prefix}${m[3]}:${1789 + 2 * (Number.parseInt(m[1]!, 10) - 1)}` : null;
    },
  },
];

// Bill numbers as descriptions spell them: "H.R.1470", "HB 4432", "S.B. 68",
// "H.866", "House Bill 4432", "Senate File 12", "Assembly Bill 5", DC
// "B25-0345". The alpha prefix is normalized to letters only so "H.R.1470"
// and "HR 1470" key the same.
const DESCRIPTION_BILL_PATTERNS: readonly RegExp[] = [
  /\b([a-z]{1,3}\d{1,2}-\d{3,4})\b/i,
  /\b(house|senate|assembly)\s+(bill|file|resolution|joint\s+resolution|concurrent\s+resolution)\s+(?:no\.?\s*)?(\d{1,5})\b/i,
  /\b((?:h|s|a|l)\.?\s?(?:con\.?\s?res|j\.?\s?res|res|b|r|f|j|c|con|cr|jr|s)?\.?)\s?(\d{1,5})\b/i,
];

// Named measures: two or more capitalized words followed by a measure noun
// ("Secure DC amendment", "Secure DC crime law", "Street Vendor Advancement
// Amendment Act", "Clean Slate Act"). One lowercase word may sit between the
// name and the noun ("Secure DC crime law"). Single capitalized words are
// not names ("District's emergency measure").
const NAMED_MEASURE_PATTERN =
  /\b((?:[A-Z][A-Za-z0-9'’.-]*\s+){1,6}[A-Z][A-Za-z0-9'’.-]*)\s+(?:[a-z]+\s+)?(?:[Aa]mendment|[Aa]ct|[Ll]aw|[Bb]ill|[Oo]rdinance|[Mm]easure|[Rr]esolution|[Ii]nitiative|[Pp]roposition)\b/;
const NAME_STOP_WORDS = new Set(["the", "a", "an", "voted", "vote", "for", "against", "on", "to", "of", "in", "and", "d.c.'s", "d.c.’s"]);

function normalizeName(name: string): string {
  return name
    .split(/\s+/)
    .filter((token) => !NAME_STOP_WORDS.has(token.toLowerCase()))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .trim();
}

export function recordBillKey(record: { description: string; source_url: string; event_date: string }): string | null {
  for (const { pattern, key } of URL_BILL_PATTERNS) {
    const match = record.source_url.match(pattern);
    if (match) {
      const key_ = key(match);
      if (key_) {
        return key_;
      }
    }
  }
  const dc = record.description.match(DESCRIPTION_BILL_PATTERNS[0]!);
  if (dc) {
    return `dc:${dc[1]!.toUpperCase()}`;
  }
  const spelled = record.description.match(DESCRIPTION_BILL_PATTERNS[1]!);
  if (spelled) {
    const chamber = spelled[1]![0]!.toUpperCase();
    const kind = spelled[2]!.replace(/\s+/g, " ").toLowerCase();
    // A spelled-out "House Resolution" is H.Res., not the House bill H.R.
    const kindCode =
      kind === "bill" ? "B" : kind === "file" ? "F" : kind === "resolution" ? "RES" : kind === "joint resolution" ? "JRES" : "CONRES";
    return `${chamber}${kindCode}${spelled[3]}:${sessionWindow(record.event_date)}`;
  }
  const abbreviated = record.description.match(DESCRIPTION_BILL_PATTERNS[2]!);
  if (abbreviated) {
    const prefix = abbreviated[1]!.replace(/[^a-z]/gi, "").toUpperCase();
    return `${prefix}${abbreviated[2]}:${sessionWindow(record.event_date)}`;
  }
  const named = record.description.match(NAMED_MEASURE_PATTERN);
  if (named) {
    const name = normalizeName(named[1]!);
    if (name.split(" ").length >= 2) {
      return `name:${name}`;
    }
  }
  return null;
}

// Records of ONE candidate that share a bill key, keyed by record id. A
// record with no key, or the only record on its bill, has no entry.
export function relatedRecordsByBill<T extends { id: string; description: string; source_url: string; event_date: string }>(
  records: readonly T[]
): Map<string, T[]> {
  const byKey = new Map<string, T[]>();
  for (const record of records) {
    const key = recordBillKey(record);
    if (!key) {
      continue;
    }
    const group = byKey.get(key) ?? [];
    group.push(record);
    byKey.set(key, group);
  }
  const related = new Map<string, T[]>();
  for (const group of byKey.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const record of group) {
      related.set(
        record.id,
        group.filter((other) => other.id !== record.id)
      );
    }
  }
  return related;
}
