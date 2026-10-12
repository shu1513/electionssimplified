import {
  parseMaineMapLightCivilDate,
  parseMaineMapLightCents,
  parseMaineMapLightSourceId,
} from "./maineMapLightCsvPrimitives.js";

const ORIGIN = "https://www.mainecampaignfinancedisclosure.com";
const HEADERS = ["Date", "Name", "Address", "Occupation", "Employer", "Amount"];
const SUMMARY_LABELS = [
  "Balance at the Beginning of the Period", "Total Contributions",
  "Total Monetary Contributions", "Total In-Kind Contributions",
  "Unitemized Total - Contributions of $200 or Less", "Total General Treasury Transfers",
  "Total Bank Interest", "Total Expenditures", "Total Independent Expenditures",
  "Total Loans Received", "Total Debts Owed", "Balance at the End of the Period",
  "Loan Balance", "Debt Balance",
] as const;

export type MaineMapLightReportFinancialRow = {
  occurrence: number;
  transactionId: string;
  sourcePath: string;
  date: string;
  amount: string;
  amountCents: number;
};
export type MaineMapLightReportSchedule = {
  section: string;
  rows: MaineMapLightReportFinancialRow[];
  totalCents: number;
  emptyStatement: string | null;
};
export type MaineMapLightReportControls = {
  sourceUrl: string;
  filerId: string;
  reportId: string;
  reportName: string;
  reportType: "Campaign Finance";
  filerName: string;
  filingStatus: "Filed";
  version: { label: string; kind: "original" | "amendment"; number: number };
  periodStart: string;
  periodEnd: string;
  sourceSubmittedDate: string;
  sourceSubmittedAt: string;
  summaryControls: { label: string; amount: string; amountCents: number }[];
  expenditures: MaineMapLightReportSchedule;
  returnedExpenditures: MaineMapLightReportSchedule;
  independentExpenditures: MaineMapLightReportSchedule;
  returnedIndependentExpenditures: MaineMapLightReportSchedule;
};

function bad(reason: string): never {
  // Never include source HTML, contact cells, or query values in errors.
  throw new Error(`Maine MapLight report controls: ${reason}`);
}
function text(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1].toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) bad("invalid text entity");
      return String.fromCodePoint(code);
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[entity.toLowerCase()];
  }).replace(/\s+/g, " ").trim();
}

// Small private tree for the observed SSR section/table/description-list markup.
// No contact fields are projected out of this tree.
type Node = { tag: string; attrs: Record<string, string>; children: Node[]; parts: (Node | string)[]; parent?: Node };
function tree(html: string): Node {
  const root: Node = { tag: "root", attrs: {}, children: [], parts: [] };
  let current = root;
  const stripped = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const tokens = /<![^>]*>|<(?<end>\/)?(?<tag>[a-z][\w:-]*)\b(?<attrs>(?:"[^"]*"|'[^']*'|[^'">])*)>|(?<data>[^<]+)|</gi;
  for (const match of stripped.matchAll(tokens)) {
    const g = match.groups!;
    if (g.data) { current.parts.push(g.data); continue; }
    if (!g.tag) { if (match[0] === "<") bad("malformed HTML"); continue; }
    const tag = g.tag.toLowerCase();
    if (g.end) {
      if (current.tag !== tag || !current.parent) bad("unbalanced HTML");
      current = current.parent;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of g.attrs.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g)) {
      const key = a[1].toLowerCase();
      if (key in attrs) bad("duplicate HTML attribute");
      attrs[key] = text(a[2] ?? a[3] ?? a[4]);
    }
    const node: Node = { tag, attrs, children: [], parts: [], parent: current };
    current.children.push(node); current.parts.push(node);
    if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag) && !/\/\s*$/.test(g.attrs)) current = node;
  }
  if (current !== root) bad("unclosed HTML");
  return root;
}
function nodes(node: Node, tag: string): Node[] {
  return node.children.flatMap(child => [ ...(child.tag === tag ? [child] : []), ...nodes(child, tag) ]);
}
function content(node: Node): string {
  return text(node.parts.map(part => typeof part === "string" ? part : content(part)).join(" "));
}
function one<T>(items: T[], reason: string): T {
  if (items.length !== 1) bad(reason);
  return items[0];
}
function section(root: Node, label: string): Node {
  let node = one(nodes(root, "h2").filter(h => content(h) === label), "missing or repeated section");
  while (node.tag !== "section") {
    if (!node.parent) bad("missing section boundary");
    node = node.parent;
  }
  if (nodes(node, "h2").length !== 1) bad("nested section ambiguity");
  return node;
}
function fields(sectionNode: Node): Map<string, Node> {
  const result = new Map<string, Node>();
  for (const dt of nodes(sectionNode, "dt")) {
    const label = content(dt);
    if (result.has(label)) bad("repeated report field");
    const dd = one(dt.parent?.children.filter(n => n.tag === "dd") ?? [], "missing report field value");
    result.set(label, dd);
  }
  return result;
}
function field(fieldsMap: Map<string, Node>, label: string): Node {
  const node = fieldsMap.get(label);
  if (!node || !content(node)) bad("missing required report field");
  return node;
}
function timestamp(node: Node): string {
  const value = one(nodes(node, "time"), "missing or repeated timestamp").attrs.datetime;
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) bad("invalid timestamp");
  parseMaineMapLightCivilDate(value.slice(0, 10), bad);
  const clock = value.slice(11, 19).split(":").map(Number);
  if (clock[0] > 23 || clock[1] > 59 || clock[2] > 59) bad("invalid timestamp clock");
  const label = content(one(nodes(node, "time"), "missing timestamp"));
  const displayed = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})(?: |$)/.exec(label);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  if (!displayed || `${displayed[3]}-${String(months.indexOf(displayed[1]) + 1).padStart(2, "0")}-${displayed[2].padStart(2, "0")}` !== value.slice(0, 10)) bad("timestamp display mismatch");
  return value;
}
function date(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) bad("invalid schedule date");
  return parseMaineMapLightCivilDate(`${m[3]}-${m[1]}-${m[2]}`, bad);
}
function schedule(root: Node, label: string, empty: string): MaineMapLightReportSchedule {
  const s = section(root, label), tables = nodes(s, "table");
  if (!tables.length) {
    const statement = one(nodes(s, "em"), "missing explicit empty statement");
    if (content(statement) !== empty || content(s) !== `${label} ${empty}`) bad("unknown empty schedule schema");
    return { section: label, rows: [], totalCents: 0, emptyStatement: empty };
  }
  const table = one(tables, "multiple schedule tables");
  if (content(s) !== `${label} ${content(table)}`) bad("unprojected schedule content");
  if (table.children.map(n => n.tag).join(",") !== "thead,tbody,tfoot") bad("unknown schedule table structure");
  const thead = one(nodes(table, "thead"), "missing schedule header");
  const headerRow = one(nodes(thead, "tr"), "invalid schedule header");
  if (JSON.stringify(headerRow.children.map(content)) !== JSON.stringify(HEADERS) || headerRow.children.some(n => n.tag !== "th" || n.attrs.scope !== "col")) bad("unknown schedule headers");
  const tbody = one(nodes(table, "tbody"), "missing schedule body");
  if (tbody.parts.some(part => typeof part === "string" && text(part))) bad("unprojected financial body content");
  const rows = tbody.children.map((tr, index) => {
    if (tr.tag !== "tr" || tr.children.length !== HEADERS.length || tr.children.some(n => n.tag !== "td")) bad("invalid financial row width");
    const cells = tr.children;
    if (cells.some((cell, i) => cell.attrs["data-label"] !== HEADERS[i] || cell.attrs.colspan || cell.attrs.rowspan)) bad("financial column drift");
    const link = one(nodes(cells[0], "a"), "missing financial activity identity");
    let url: URL;
    try { url = new URL(link.attrs.href, ORIGIN); } catch { bad("invalid activity URL"); }
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !/^\/public\/activities\/a_[a-z0-9]{26}$/.test(url.pathname)) bad("invalid activity identity");
    const transactionId = parseMaineMapLightSourceId(url.pathname.split("/").at(-1)!, "a", bad);
    const amount = content(cells[5]);
    return { occurrence: index + 1, transactionId, sourcePath: url.pathname, date: date(content(cells[0])), amount, amountCents: parseMaineMapLightCents(amount, bad) };
  });
  if (!rows.length || nodes(tbody, "tr").length !== rows.length) bad("empty or nested financial rows");
  const footer = one(nodes(table, "tfoot"), "missing financial footer");
  const footerRow = one(nodes(footer, "tr"), "invalid financial footer");
  if (footerRow.children.length !== 2 || footerRow.children[0].tag !== "th" || content(footerRow.children[0]) !== "Total" || footerRow.children[0].attrs.colspan !== "5" || footerRow.children[1].tag !== "td") bad("unknown financial footer schema");
  const totalCents = parseMaineMapLightCents(content(footerRow.children[1]), bad);
  const sum = rows.reduce((n, row) => { const next = n + row.amountCents; if (!Number.isSafeInteger(next)) bad("unsafe financial sum"); return next; }, 0);
  if (sum !== totalCents) bad("financial footer mismatch");
  return { section: label, rows, totalCents, emptyStatement: null };
}

/** Observed filed report facts only. Does not certify latest edition, cash scope, or accepted money. */
export function parseMaineMapLightReportControls(html: string, publicCanonicalReportURL: string): MaineMapLightReportControls {
  if (typeof html !== "string" || html.length > 8 * 1024 * 1024) bad("invalid report body");
  let url: URL;
  try { url = new URL(publicCanonicalReportURL); } catch { bad("invalid report URL"); }
  const path = /^\/public\/filers\/(f_[a-z0-9]{26})\/filings\/(d_[a-z0-9]{26})$/.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !path) bad("noncanonical report URL");
  const root = tree(html), information = fields(section(root, "Filing Information"));
  const value = (label: string) => content(field(information, label));
  if (value("Report ID") !== path[2]) bad("report ID does not match source URL");
  if (content(one(nodes(root, "h1"), "missing or repeated report title")) !== `${value("Report Name")} - ${value("Filer Name")}`) bad("report title identity mismatch");
  if (value("Report Type") !== "Campaign Finance" || value("Filing Status") !== "Filed") bad("unsupported report type or status");
  const versionLabel = value("Version of Report"), version = /^(Original|Amendment) (\d+)$/.exec(versionLabel);
  if (!version || !Number.isSafeInteger(Number(version[2])) || (version[1] === "Original" ? Number(version[2]) !== 0 : Number(version[2]) < 1)) bad("unknown report version");
  const times = nodes(field(information, "Reporting Period"), "time");
  if (times.length !== 2 || content(field(information, "Reporting Period")) !== `${content(times[0])} - ${content(times[1])}`) bad("invalid report period");
  const periodStart = timestamp({ tag: "root", attrs: {}, children: [times[0]], parts: [] }).slice(0, 10);
  const periodEnd = timestamp({ tag: "root", attrs: {}, children: [times[1]], parts: [] }).slice(0, 10);
  if (periodStart > periodEnd) bad("reversed report period");
  const submitted = field(information, "Date Submitted");
  const summary = fields(section(root, "Filing Summary"));
  if (summary.size !== SUMMARY_LABELS.length || [...summary.keys()].some(k => !SUMMARY_LABELS.includes(k as typeof SUMMARY_LABELS[number]))) bad("unknown summary controls");
  const summaryControls = SUMMARY_LABELS.map(label => { const amount = content(field(summary, label)); return { label, amount, amountCents: parseMaineMapLightCents(amount, bad) }; });
  return {
    sourceUrl: url.href, filerId: path[1], reportId: path[2], reportName: value("Report Name"),
    reportType: "Campaign Finance", filerName: value("Filer Name"), filingStatus: "Filed",
    version: { label: versionLabel, kind: version[1] === "Original" ? "original" : "amendment", number: Number(version[2]) },
    periodStart, periodEnd, sourceSubmittedDate: content(submitted), sourceSubmittedAt: timestamp(submitted), summaryControls,
    expenditures: schedule(root, "Expenditures", "No expenditures to report"),
    returnedExpenditures: schedule(root, "Returned Expenditures", "No returned expenditures to report"),
    independentExpenditures: schedule(root, "Independent Expenditures", "No independent expenditures to report"),
    returnedIndependentExpenditures: schedule(root, "Returned Independent Expenditures", "No returned independent expenditures to report"),
  };
}
