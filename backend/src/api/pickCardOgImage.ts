import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAsync } from "@resvg/resvg-js";

// The per-share link-preview image for /picks/<token>. Scrapers (iMessage,
// WhatsApp, Facebook, X) show the og:image far larger than the title text, so
// a share only *feels* personal if the picture itself carries the owner's
// name. This renders the same layout as the static frontend/public/og-card.jpg
// (white card, rausch top bar, brand label, bold dark headline) with a
// per-share headline: "See Shu's picks for Nov 3, 2026 Elections".
//
// Rendering is SVG composed here → PNG via resvg (prebuilt native binary, no
// system dependencies). The headline font is vendored at
// backend/assets/fonts/Inter_700Bold.ttf (SIL OFL, license alongside) because
// the deploy host's system fonts are not guaranteed; system fonts stay loaded
// as a fallback so a name outside Inter's coverage (e.g. CJK) degrades to a
// host font instead of tofu.

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN_X = 90;
const USABLE_WIDTH = WIDTH - MARGIN_X * 2;

// Colors mirror frontend/src/index.css: --color-rausch and --color-ink.
const BRAND_COLOR = "#ff385c";
const INK_COLOR = "#222222";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const FONT_PATH = join(moduleDir, "../../assets/fonts/Inter_700Bold.ttf");

// Read at module load: a missing or corrupt font should fail server startup
// loudly, not surface as a per-request 500 the first time a scraper asks.
// resvg loads from the path (its 2.x API takes fontFiles, not buffers); the
// buffer here feeds the metrics parser below.
const fontData = readFileSync(FONT_PATH);

// ---------------------------------------------------------------------------
// Real text measurement. Width ESTIMATES kept producing edge cases (a wall of
// W's is nearly twice the average glyph width; emoji are wider still), and an
// overflowing line clips at the canvas edge. The vendored font is right
// there, so read true advance widths from its cmap + hmtx tables instead of
// guessing. Kerning and ligatures in Inter only ever narrow a line, so
// summing bare advances errs safe. Glyphs Inter lacks (emoji, CJK) render in
// an unknown fallback font and get a pessimistic 1.4em.

const FALLBACK_GLYPH_WIDTH_EM = 1.4;

type FontMetrics = {
  unitsPerEm: number;
  glyphForCodePoint: (codePoint: number) => number | null;
  advanceForGlyph: (glyphId: number) => number;
};

function parseFontMetrics(data: Buffer): FontMetrics {
  const tables = new Map<string, number>();
  const tableCount = data.readUInt16BE(4);
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    tables.set(data.toString("ascii", record, record + 4), data.readUInt32BE(record + 8));
  }
  const offsetOf = (tag: string): number => {
    const offset = tables.get(tag);
    if (offset === undefined) {
      throw new Error(`font is missing required table ${tag}`);
    }
    return offset;
  };

  const unitsPerEm = data.readUInt16BE(offsetOf("head") + 18);
  const numberOfHMetrics = data.readUInt16BE(offsetOf("hhea") + 34);
  const hmtxOffset = offsetOf("hmtx");
  const advanceForGlyph = (glyphId: number): number =>
    data.readUInt16BE(hmtxOffset + Math.min(glyphId, numberOfHMetrics - 1) * 4);

  // Prefer a format 12 unicode subtable (full range), else format 4 (BMP).
  const cmapOffset = offsetOf("cmap");
  let subtable: { offset: number; format: number } | null = null;
  const subtableCount = data.readUInt16BE(cmapOffset + 2);
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmapOffset + 4 + index * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) {
      continue;
    }
    const offset = cmapOffset + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(offset);
    if (format === 12 || (format === 4 && subtable?.format !== 12)) {
      subtable = { offset, format };
    }
  }
  if (!subtable) {
    throw new Error("font has no usable unicode cmap subtable");
  }
  const { offset: sub, format } = subtable;

  const glyphForCodePoint = (codePoint: number): number | null => {
    if (format === 12) {
      const groupCount = data.readUInt32BE(sub + 12);
      let low = 0;
      let high = groupCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const group = sub + 16 + mid * 12;
        const start = data.readUInt32BE(group);
        const end = data.readUInt32BE(group + 4);
        if (codePoint < start) {
          high = mid - 1;
        } else if (codePoint > end) {
          low = mid + 1;
        } else {
          return data.readUInt32BE(group + 8) + (codePoint - start);
        }
      }
      return null;
    }
    // Format 4: segmented BMP mapping.
    if (codePoint > 0xffff) {
      return null;
    }
    const segCountX2 = data.readUInt16BE(sub + 6);
    const endCodes = sub + 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;
    for (let seg = 0; seg < segCountX2; seg += 2) {
      if (codePoint > data.readUInt16BE(endCodes + seg)) {
        continue;
      }
      const start = data.readUInt16BE(startCodes + seg);
      if (codePoint < start) {
        return null;
      }
      const rangeOffset = data.readUInt16BE(idRangeOffsets + seg);
      if (rangeOffset === 0) {
        return (codePoint + data.readInt16BE(idDeltas + seg)) & 0xffff;
      }
      const glyphAddress = idRangeOffsets + seg + rangeOffset + (codePoint - start) * 2;
      const glyph = data.readUInt16BE(glyphAddress);
      return glyph === 0 ? null : (glyph + data.readInt16BE(idDeltas + seg)) & 0xffff;
    }
    return null;
  };

  return { unitsPerEm, glyphForCodePoint, advanceForGlyph };
}

const fontMetrics = parseFontMetrics(fontData);
const advanceCache = new Map<number, number>();

function codePointWidthEm(codePoint: number): number {
  const cached = advanceCache.get(codePoint);
  if (cached !== undefined) {
    return cached;
  }
  const glyph = fontMetrics.glyphForCodePoint(codePoint);
  const width =
    glyph === null || glyph === 0
      ? FALLBACK_GLYPH_WIDTH_EM
      : fontMetrics.advanceForGlyph(glyph) / fontMetrics.unitsPerEm;
  advanceCache.set(codePoint, width);
  return width;
}

/** Measured width of a single rendered line, in px at the given font size.
 * Exported so tests can assert real fit instead of re-deriving estimates. */
export function measureTextPx(text: string, fontSize: number): number {
  let em = 0;
  for (const character of text) {
    em += codePointWidthEm(character.codePointAt(0) ?? 0);
  }
  return em * fontSize;
}

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-11-03" → "Nov 3, 2026". String math, not Date: a Date round-trip
 * would shift the day near midnight depending on the server timezone. */
export function formatElectionDateShort(electionDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(electionDate);
  if (!match) {
    return electionDate;
  }
  const [, year, month, day] = match;
  const monthName = MONTH_ABBREVIATIONS[Number(month) - 1];
  return monthName ? `${monthName} ${Number(day)}, ${year}` : electionDate;
}

/** The exact share pitch. The unnamed form covers shares whose owner kept
 * their name off the card (show_owner_name = false). */
export function pickCardOgHeadline(firstName: string | null, electionDate: string): string {
  const date = formatElectionDateShort(electionDate);
  return firstName
    ? `See ${firstName}'s picks for ${date} Elections`
    : `See the picks for ${date} Elections`;
}

function escapeXml(text: string): string {
  return (
    text
      // Characters XML 1.0 rejects even escaped — first-name validation only
      // checks trim + length, so any of these reach this boundary and would
      // fail the SVG parse (a 500) if kept: C0 controls, DEL, and the
      // noncharacters U+FFFE/U+FFFF. Lone surrogates are dropped too rather
      // than left to lossy UTF-8 conversion at the native boundary.
      .replace(/[\u0000-\u001f\u007f\ufffe\uffff]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

// Splitting must respect grapheme boundaries: word.slice() indexes UTF-16
// units and would cut an emoji's surrogate pair in half, leaving lone
// surrogates in the SVG.
const graphemeSegmenter = new Intl.Segmenter();

function splitGraphemes(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map((segment) => segment.segment);
}

// A single word wider than a whole line (an 80-char first name with no
// spaces — garbage input, but length validation admits it) is hard-split
// into measured chunks that each get their own line.
function chunkWord(word: string, fontSize: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const grapheme of splitGraphemes(word)) {
    if (current.length > 0 && measureTextPx(current + grapheme, fontSize) > USABLE_WIDTH) {
      chunks.push(current);
      current = "";
    }
    current += grapheme;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

// Greedy word wrap against measured widths.
function wrapHeadline(text: string, fontSize: number): string[] {
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
  };
  for (const word of text.split(" ")) {
    if (measureTextPx(word, fontSize) > USABLE_WIDTH) {
      flush();
      lines.push(...chunkWord(word, fontSize));
      continue;
    }
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (current.length === 0 || measureTextPx(candidate, fontSize) <= USABLE_WIDTH) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  flush();
  return lines;
}

// Largest first: the common "See Shu's picks for Nov 3, 2026 Elections" fits
// two 72px lines; sizes below exist for long first names (≤80 chars, enforced
// at registration). 40px wraps the worst legal case within four lines.
const HEADLINE_FONT_SIZES = [72, 60, 50, 40];
const MAX_HEADLINE_LINES = 4;
const LINE_HEIGHT_FACTOR = 1.2;

function layoutHeadline(text: string): { fontSize: number; lines: string[]; fits: boolean } {
  let fallback: { fontSize: number; lines: string[] } | null = null;
  for (const fontSize of HEADLINE_FONT_SIZES) {
    const lines = wrapHeadline(text, fontSize);
    // Wrapping already guarantees per-line width, so fit is line count alone.
    if (lines.length <= MAX_HEADLINE_LINES) {
      return { fontSize, lines, fits: true };
    }
    fallback = { fontSize, lines: lines.slice(0, MAX_HEADLINE_LINES) };
  }
  // Only reachable when the caller's name truncation is exhausted too;
  // dropping tail lines at the smallest size beats a 500.
  return fallback
    ? { ...fallback, fits: false }
    : { fontSize: HEADLINE_FONT_SIZES.at(-1) ?? 40, lines: [text], fits: false };
}

export type PickCardOgImageInput = {
  firstName: string | null;
  electionDate: string;
};

/** Exported separately from the PNG step so tests can assert on markup
 * (escaping, wording) without decoding pixels. */
export function buildPickCardOgSvg(input: PickCardOgImageInput): string {
  // Non-breaking spaces inside the date keep "Nov 3, 2026" on one line; the
  // wrapper only splits on regular spaces.
  const date = formatElectionDateShort(input.electionDate);
  const composeHeadline = (firstName: string | null) =>
    pickCardOgHeadline(firstName, input.electionDate).replace(date, date.replace(/ /g, " "));

  // When even the smallest font size cannot hold the whole headline, shorten
  // the NAME with an ellipsis rather than dropping tail lines: "See WWWW…"
  // without "picks for Nov 3, 2026 Elections" has lost the image's entire
  // message. Trimming is grapheme-wise for the same reason chunking is.
  let layout = layoutHeadline(composeHeadline(input.firstName));
  if (!layout.fits && input.firstName) {
    const graphemes = splitGraphemes(input.firstName);
    while (!layout.fits && graphemes.length > 1) {
      graphemes.pop();
      layout = layoutHeadline(composeHeadline(`${graphemes.join("")}…`));
    }
  }
  const { fontSize, lines } = layout;
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_FACTOR);

  // Center the headline block in the space under the brand label (y 170–600),
  // so one-line and four-line headlines both sit visually balanced.
  const blockTop = 170;
  const blockHeight = 600 - blockTop;
  const textHeight = lines.length * lineHeight;
  // First baseline: top offset plus ~0.8em ascent of the first line.
  const firstBaseline = Math.round(blockTop + (blockHeight - textHeight) / 2 + fontSize * 0.8);

  const headlineTspans = lines
    .map(
      (line, index) =>
        `<text x="${MARGIN_X}" y="${firstBaseline + index * lineHeight}" font-family="Inter" font-size="${fontSize}" font-weight="700" fill="${INK_COLOR}">${escapeXml(line)}</text>`
    )
    .join("\n  ");

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
  <rect width="${WIDTH}" height="28" fill="${BRAND_COLOR}"/>
  <text x="${MARGIN_X}" y="132" font-family="Inter" font-size="42" font-weight="700" fill="${BRAND_COLOR}">Elections Simplified</text>
  ${headlineTspans}
</svg>`;
}

// Rendering costs ~100ms of CPU, and the endpoint is public: without a
// cache, every request renders (Cloudflare treats each distinct query
// string as a separate cache key, so origin traffic is easy to force).
// The image depends only on first name + election date, so a small
// keyed cache turns any amount of repeat traffic into lookups. Promises
// are cached, not buffers, so concurrent misses for the same card share
// one render. ~30KB per entry bounds the cache at a few MB.
const RENDER_CACHE_MAX_ENTRIES = 200;
const renderCache = new Map<string, Promise<Buffer>>();

async function renderPng(input: PickCardOgImageInput): Promise<Buffer> {
  const rendered = await renderAsync(buildPickCardOgSvg(input), {
    fitTo: { mode: "width", value: WIDTH },
    font: {
      fontFiles: [FONT_PATH],
      defaultFontFamily: "Inter",
      loadSystemFonts: true,
    },
  });
  return Buffer.from(rendered.asPng());
}

export function renderPickCardOgImage(input: PickCardOgImageInput): Promise<Buffer> {
  const key = `${input.firstName ?? ""}\u0000${input.electionDate}`;
  const cached = renderCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = renderPng(input);
  renderCache.set(key, pending);
  // A failed render must not be pinned as the permanent answer for this card.
  pending.catch(() => renderCache.delete(key));
  if (renderCache.size > RENDER_CACHE_MAX_ENTRIES) {
    // Maps iterate in insertion order, so the first key is the oldest entry.
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) {
      renderCache.delete(oldest);
    }
  }
  return pending;
}
