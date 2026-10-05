// Display casing for contest titles. Some sources publish titles in capital
// letters ("BUNCOMBE COUNTY SHERIFF"); readers pass the stored title through
// this on the way out so it reads "Buncombe County Sheriff". Only the letter
// case changes: words, numbers and punctuation stay as stored. The stored
// title itself is untouched: it is the contest's identity and what the
// ballot order rules read. A title with any lowercase letter is taken as
// already cased and returned unchanged.

const SMALL_WORDS = new Set(["of", "the", "and", "to", "in", "for", "at"]);

const UPPERCASE_ABBREVIATIONS = new Set([
  "US",
  "USA",
  "DC",
  "ISD",
  "CISD",
  "USD",
  "CUSD",
  "MSD",
  "MUD",
  "ESD",
  "II",
  "III",
  "IV",
  "VI",
  "VII",
  "VIII",
  "IX",
]);

// Postal codes stay upper case when they are a whole word ("NC STATE
// SENATE"). Codes that are also ordinary title words or name parts are left
// out: AL, CO (county), CT (court), DE (De Soto), IN, LA (La Crosse), ME,
// MT (mount), OR.
const STATE_POSTAL_CODES = new Set([
  "AK",
  "AZ",
  "AR",
  "CA",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IA",
  "KS",
  "KY",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);

const WORD_PARTS = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;
const COMPOUND_SEPARATORS = /([-/\u2013\u2014])/;

function capitalize(word: string): string {
  return (
    word
      .toLowerCase()
      // First letter, and any letter after inner punctuation ("COUNTY,PLACE").
      .replace(/(^|[^\p{L}\p{N}'\u2019])(\p{Ll})/gu, (_match, before: string, letter: string) => before + letter.toUpperCase())
      // "O'BRIEN" -> "O'Brien"; "COMMISSIONER'S" keeps its lowercase "s".
      .replace(/^(\p{Lu}['\u2019])(\p{Ll})/u, (_match, prefix: string, letter: string) => prefix + letter.toUpperCase())
      // "MCDOWELL" -> "McDowell".
      .replace(/^Mc(\p{Ll})(?=\p{Ll}{2})/u, (_match, letter: string) => `Mc${letter.toUpperCase()}`)
  );
}

type PartContext = {
  // The part is a whole word, not one side of a hyphen or slash.
  wholeWord: boolean;
  // A connecting word here stays lowercase (it is inside the title).
  smallWordAllowed: boolean;
  // The part is joined by a hyphen to a number that follows ("CI-132").
  beforeNumber: boolean;
};

function casePart(part: string, context: PartContext): string {
  const [, lead, core, trail] = WORD_PARTS.exec(part) ?? [];
  if (!core) {
    return part;
  }
  if (/^\p{N}/u.test(core)) {
    // Numbers stay as stored ("06", "24D"); only an ordinal's suffix lowers.
    const ordinal = /^(\d+)(ST|ND|RD|TH)$/.exec(core);
    return ordinal ? `${lead}${ordinal[1]}${ordinal[2].toLowerCase()}${trail}` : part;
  }
  if (
    // Dotted initials: "U.S.", "A.M.".
    /^\p{Lu}(?:\.\p{Lu})+$/u.test(core) ||
    UPPERCASE_ABBREVIATIONS.has(core) ||
    (context.beforeNumber && core.length <= 3) ||
    (context.wholeWord && STATE_POSTAL_CODES.has(core))
  ) {
    return part;
  }
  const lower = core.toLowerCase();
  if (context.smallWordAllowed && !lead && SMALL_WORDS.has(lower)) {
    return `${lower}${trail}`;
  }
  return `${lead}${capitalize(core)}${trail}`;
}

function wordCore(word: string | undefined): string {
  return word ? (WORD_PARTS.exec(word)?.[2] ?? "") : "";
}

export function displayElectionTitle(title: string): string {
  if (/\p{Ll}/u.test(title) || !/\p{Lu}/u.test(title)) {
    return title;
  }
  // Words sit at the even indexes, the whitespace between them at the odd.
  const tokens = title.split(/(\s+)/);
  // True at the start of the title and after a dash or colon, where a
  // connecting word is capitalized like any other.
  let segmentStart = true;
  for (let index = 0; index < tokens.length; index += 2) {
    const word = tokens[index];
    if (!word) {
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(word)) {
      segmentStart = segmentStart || /^[-\u2013\u2014:]+$/.test(word);
      continue;
    }
    const parts = word.split(COMPOUND_SEPARATORS);
    const wholeWord = parts.length === 1;
    // "AT LARGE" reads as a seat name, so its "At" stays capitalized.
    const atLarge = word === "AT" && wordCore(tokens[index + 2]) === "LARGE";
    for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
      parts[partIndex] = casePart(parts[partIndex], {
        wholeWord,
        smallWordAllowed: wholeWord && !segmentStart && !atLarge,
        beforeNumber: parts[partIndex + 1] === "-" && /^\d/.test(parts[partIndex + 2] ?? ""),
      });
    }
    tokens[index] = parts.join("");
    segmentStart = word.endsWith(":");
  }
  return tokens.join("");
}
