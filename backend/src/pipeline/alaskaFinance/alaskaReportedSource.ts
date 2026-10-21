import { createHash } from "node:crypto";
import { collectAlaskaPopulation } from "./alaskaReportedClient.js";
import {
  AlaskaOriginalArchive,
  akFreshOriginal,
  akManifestHash,
  akSuccessfulOriginal,
  type AlaskaOriginal,
  type AlaskaOriginalMeta,
} from "./alaskaReportedOriginals.js";
import {
  akCsvObjects,
  akCsvPopulationComplete,
  akNativePopulationComplete,
  akRecordedPopulations,
  akSameScope,
  type AlaskaQueryScope,
  type AlaskaRecordedPopulation,
} from "./alaskaReportedProtocol.js";
import {
  akAdd,
  akCandidateChoice,
  akCents,
  akCheck,
  akColumn,
  akDate,
  akDocument,
  akField,
  akKey,
  akMoneyRows,
  akNodeText,
  akPersonMatches,
  akRenderedText,
  akSubmittedDay,
  ALASKA_REPORTED_URLS,
  type AlaskaReportedComponent,
  type AlaskaNativeGridRow,
} from "./alaskaReportedNative.js";
import {
  qualifyAlaskaReportedReceiver,
  type AlaskaCandidateRegistration,
  type AlaskaHouseNominee,
  type AlaskaReportedReceiver,
  type AlaskaReportedReceivingContext,
} from "./alaskaReportedReceiver.js";

export type AlaskaReportedGroup = {
  key: string;
  reportedName: string;
  stance: "committee" | "support" | "oppose";
  amountCents: number;
  occurrenceCount: number;
};
export type AlaskaReportedControls = {
  totalAmountCents: number;
  occurrenceCount: number;
  sourceRows: number;
  excludedRows: number;
  debtRows: number;
  supportCents: number;
  opposeCents: number;
};
export type AlaskaReportedSourceFacts = {
  manifestSha256: string;
  observedAt: string;
  completedAt: string;
  observations: AlaskaOriginalMeta[];
};
export type AlaskaReportedPacket = {
  component: AlaskaReportedComponent;
  receiver: AlaskaReportedReceiver;
  receiving: AlaskaReportedReceivingContext;
  groups: AlaskaReportedGroup[];
  controls: AlaskaReportedControls;
  source: AlaskaReportedSourceFacts;
};
const verified = new WeakSet<object>();
export const isVerifiedAlaskaReportedPacket = (
  value: AlaskaReportedPacket,
): boolean => verified.has(value);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const signature = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value: string): number => {
  akCheck(
    /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
    "source_count",
  );
  return Number(value);
};
const allRows = (p: AlaskaRecordedPopulation) =>
  p.pages.flatMap(({ grid }) => grid.rows);
const cell = (
  p: AlaskaRecordedPopulation,
  row: AlaskaNativeGridRow,
  name: string,
) => row.cells[akColumn(p.pages[0]!.grid.headers, name)]!;
const scope = (
  kind: AlaskaQueryScope["kind"],
  year: number,
  name = "",
  nameType = "",
  status: AlaskaQueryScope["status"] = "Default",
): AlaskaQueryScope => ({ kind, year, name, nameType, status });
const populationOriginals = (p: AlaskaRecordedPopulation) => [
  ...p.pages.map((page) => page.original),
  ...(p.exportDialog ? [p.exportDialog] : []),
  ...(p.csv ? [p.csv] : []),
];
type IeRecord = {
  row: AlaskaNativeGridRow;
  population: AlaskaRecordedPopulation;
  parent: AlaskaNativeGridRow;
  parents: AlaskaRecordedPopulation;
  year: string;
  election: string;
};

export function matchesAlaskaReportedPac(input: {
  name: string;
  address: string;
  date: string;
  payment: string;
  registry: readonly Record<string, string>[];
  entities: readonly Record<string, string>[];
}): boolean {
  const matches = input.registry.filter(
    (r) => akKey(r.Name!) === akKey(input.name),
  );
  if (
    !matches.length ||
    input.entities.some((r) => akKey(r.Name!) === akKey(input.name)) ||
    new Set(matches.map((r) => r.Type)).size !== 1 ||
    matches[0]!.Type !== "PAC"
  )
    return false;
  const normalize = (s: string) =>
      s
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim(),
    address = ` ${normalize(input.address)} `;
  const postal = matches.filter(
    (r) =>
      [r.Address, r.City, r.State, r.Zip].every(Boolean) &&
      address.includes(` ${normalize(r.Address!)} `) &&
      address.includes(` ${normalize([r.City, r.State, r.Zip].join(" "))} `) &&
      akSubmittedDay(r.Submitted!) < akDate(input.date),
  );
  if (!postal.length) return false;
  akCheck(
    !/\b(?:loan|borrowed|promissory|repayment)\b/i.test(input.payment),
    "ambiguous_pac_loan",
  );
  return true;
}

const rosterRoot = (year: number) =>
  `${ALASKA_REPORTED_URLS.roster}?election=${String(year).slice(-2)}genr`;
const rosterIndexUrl = (value: string) => {
  const url = new URL(value);
  url.searchParams.sort();
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^frm-page-\d+$/.test(key) && url.searchParams.get(key) === "1")
      url.searchParams.delete(key);
  return url.href;
};
/** Pagination links this roster page publishes for the cycle. */
function rosterPageLinks(
  document: Document,
  base: string,
  year: number,
): string[] {
  const links: string[] = [];
  for (const link of document.querySelectorAll("a[href]")) {
    const next = new URL(link.getAttribute("href")!, base);
    if (
      next.origin !== new URL(ALASKA_REPORTED_URLS.roster).origin ||
      next.pathname !== "/candidates/" ||
      next.searchParams.get("election") !== `${String(year).slice(-2)}genr` ||
      ![...next.searchParams.keys()].some((key) => /^frm-page-\d+$/.test(key))
    )
      continue;
    next.hash = "";
    links.push(next.href);
  }
  return links;
}

/** Verify the actual published roster and its navigation, not a DB name echo. */
export function parseAlaskaHouseRoster(
  originals: readonly AlaskaOriginal[],
  year: number,
): AlaskaHouseNominee[] {
  const pages = new Map<string, AlaskaOriginal>();
  for (const original of originals)
    if (
      new URL(original.meta.url).origin ===
        "https://www.elections.alaska.gov" &&
      new URL(original.meta.url).searchParams.get("election") ===
        `${String(year).slice(-2)}genr` &&
      akSuccessfulOriginal(original, "html") &&
      akFreshOriginal(original)
    )
      pages.set(rosterIndexUrl(original.meta.url), original);
  const root = rosterRoot(year),
    pending = [root],
    seen = new Set<string>(),
    nominees: AlaskaHouseNominee[] = [],
    seats = new Set<string>();
  while (pending.length) {
    const url = rosterIndexUrl(pending.shift()!);
    if (seen.has(url)) continue;
    seen.add(url);
    akCheck(seen.size <= 20, "roster_page_limit");
    const original = pages.get(url);
    akCheck(original, "official_roster_unavailable");
    const document = akDocument(original.raw, url);
    try {
      akCheck(
        [...document.querySelectorAll("h2,h3,h4")].some((node) =>
          akNodeText(node).includes(`${year} General Election`),
        ),
        "official_roster_cycle",
      );
      pending.push(...rosterPageLinks(document, url, year));
      let district: string | null = null;
      for (const node of document.querySelectorAll("h2,h3,h4,table")) {
        if (node.tagName !== "TABLE") {
          const match = /^HOUSE DISTRICT\s+(\d{1,2})$/i.exec(akNodeText(node));
          district = match ? String(Number(match[1])) : null;
          if (district) {
            akCheck(!seats.has(district), "duplicate_roster_seat");
            seats.add(district);
          }
          continue;
        }
        if (
          !district ||
          akNodeText(node.querySelector("th") ?? node) !==
            "Candidate Name on Ballot"
        )
          continue;
        const width = node.querySelectorAll("th").length;
        for (const row of node.querySelectorAll("tr")) {
          const cells = [...row.children].filter((n) => n.tagName === "TD");
          if (!cells.length) continue;
          akCheck(cells.length === width, "roster_row_width");
          // The bold ballot name is separate from addresses/contact details.
          const names = [
            ...new Set(
              [...cells[0]!.querySelectorAll("strong,b")]
                .map(akNodeText)
                .filter(Boolean),
            ),
          ];
          akCheck(names.length === 1, "roster_ballot_name");
          nominees.push({ name: names[0]!, district, year });
        }
      }
    } finally {
      document.defaultView?.close();
    }
  }
  akCheck(
    seats.size === 40 &&
      [...seats].every((s) => Number(s) >= 1 && Number(s) <= 40) &&
      nominees.length >= 40,
    "complete_house_roster",
  );
  return nominees;
}

/** One run shares verified originals; each receiver/component has its own seal. */
export class AlaskaReportedSource {
  private originals: AlaskaOriginal[] = [];
  private populations: AlaskaRecordedPopulation[] = [];
  private ready: Promise<void> | null = null;
  private queries = new Map<string, Promise<AlaskaRecordedPopulation>>();
  private ieYears = new Map<
    number,
    Promise<{ records: IeRecord[]; originals: AlaskaOriginal[] }>
  >();
  constructor(
    private readonly archive = new AlaskaOriginalArchive(),
    private readonly refresh = false,
  ) {}
  private init(): Promise<void> {
    return (this.ready ??= this.reload());
  }
  private async reload(): Promise<void> {
    this.originals = await this.archive.read();
    this.populations = [];
    const directories = new Map<string, AlaskaOriginal[]>();
    for (const original of this.originals) {
      const records = directories.get(original.directory) ?? [];
      records.push(original);
      directories.set(original.directory, records);
    }
    for (const records of directories.values()) {
      this.populations.push(...akRecordedPopulations(records));
      await new Promise<void>((done) => setImmediate(done));
    }
  }
  private query(
    wanted: AlaskaQueryScope,
    format: "native" | "csv" | "cycle",
    year = wanted.year,
  ): Promise<AlaskaRecordedPopulation> {
    const key = JSON.stringify([wanted, format, year]);
    let promise = this.queries.get(key);
    if (!promise) {
      promise = (async () => {
        await this.init();
        const complete = (p: AlaskaRecordedPopulation) =>
          format === "csv"
            ? akCsvPopulationComplete(p)
            : akNativePopulationComplete(p) ||
              (format === "cycle" &&
                akCsvPopulationComplete(p) &&
                akCsvObjects(p.csv!.raw).every(
                  (r) =>
                    akCandidateChoice(r["Candidate/Proposition"]!).year !==
                    year,
                ));
        const saved = this.populations
          .filter(
            (p) =>
              akSameScope(p.scope, wanted) &&
              populationOriginals(p).every((o) => akFreshOriginal(o)) &&
              complete(p),
          )
          .sort((a, b) =>
            b.pages[0]!.original.meta.startedAt.localeCompare(
              a.pages[0]!.original.meta.startedAt,
            ),
          )[0];
        if (saved && !this.refresh) return saved;
        akCheck(this.refresh, "saved_population_unavailable");
        const result = await collectAlaskaPopulation(
          this.archive,
          wanted,
          format,
          year,
        );
        await this.reload();
        return result;
      })();
      this.queries.set(key, promise);
    }
    return promise;
  }
  private async detail(href: string): Promise<AlaskaOriginal> {
    const saved = this.originals
      .filter(
        (o) =>
          o.meta.url === href &&
          o.meta.method === "GET" &&
          akSuccessfulOriginal(o, "html") &&
          akFreshOriginal(o),
      )
      .sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt))[0];
    // Saved genuine report bytes first, including during a population refresh.
    if (saved) return saved;
    akCheck(this.refresh, "saved_detail_unavailable");
    const record = await this.archive.observe(href);
    akCheck(akSuccessfulOriginal(record, "html"), "native_detail_unavailable");
    this.originals.push(record);
    return record;
  }
  async get(
    receiver: AlaskaReportedReceiver,
    component: AlaskaReportedComponent,
  ): Promise<AlaskaReportedPacket> {
    await this.init();
    const used: AlaskaOriginal[] = [],
      year = receiver.electionYear;
    try {
      parseAlaskaHouseRoster(this.originals, year);
    } catch (error) {
      if (!this.refresh) throw error;
      // Follow the same link closure the parser walks, so a page link that
      // only a later roster page publishes is observed too.
      const pending = [rosterRoot(year)],
        seen = new Set<string>();
      while (pending.length) {
        const url = pending.shift()!,
          key = rosterIndexUrl(url);
        if (seen.has(key)) continue;
        seen.add(key);
        akCheck(seen.size <= 20, "roster_page_limit");
        const page = await this.archive.observe(url);
        akCheck(
          akSuccessfulOriginal(page, "html"),
          "official_roster_unavailable",
        );
        this.originals.push(page);
        const document = akDocument(page.raw, url);
        try {
          pending.push(...rosterPageLinks(document, url, year));
        } finally {
          document.defaultView?.close();
        }
      }
    }
    const nominees = parseAlaskaHouseRoster(this.originals, year);
    used.push(
      ...this.originals.filter(
        (o) =>
          new URL(o.meta.url).origin === "https://www.elections.alaska.gov" &&
          new URL(o.meta.url).searchParams.get("election") ===
            `${String(year).slice(-2)}genr` &&
          akSuccessfulOriginal(o, "html") &&
          akFreshOriginal(o),
      ),
    );
    let registrations: AlaskaCandidateRegistration[] | null = null;
    if (component === "committee") {
      const population = await this.query(scope("candidates", year), "native");
      used.push(...populationOriginals(population));
      registrations = allRows(population).map((row) => ({
        href: row.href,
        name: cell(population, row, "Name"),
        firstName: cell(population, row, "First Name"),
        lastName: cell(population, row, "Last Name"),
        year: integer(cell(population, row, "Report Year")),
        office: cell(population, row, "Office"),
      }));
    }
    const receiving = qualifyAlaskaReportedReceiver(
        receiver,
        nominees,
        registrations,
      ),
      events: Array<Omit<AlaskaReportedGroup, "key" | "occurrenceCount">> = [],
      controls: AlaskaReportedControls = {
        totalAmountCents: 0,
        occurrenceCount: 0,
        sourceRows: 0,
        excludedRows: 0,
        debtRows: 0,
        supportCents: 0,
        opposeCents: 0,
      };
    if (component === "committee") {
      akCheck(receiving.registrationHref, "native_receiving_registration");
      const original = await this.detail(receiving.registrationHref);
      used.push(original);
      const document = akDocument(original.raw, receiving.registrationHref);
      try {
        akCheck(
          akField(document, "Election Year:") === String(year) &&
            akField(document, "Office Type:") === "House" &&
            akPersonMatches(
              receiver.candidateAliases,
              `${akField(document, "Candidate Legal First Name:")} ${akField(document, "Candidate Legal Last Name:")}`,
              [receiver.firstName],
            ),
          "native_registration_election_person_office",
        );
      } finally {
        document.defaultView?.close();
      }
    }
    if (component === "committee")
      await this.committee(receiver, receiving, used, events, controls);
    else await this.ie(receiver, nominees, used, events, controls);
    const grouped = new Map<string, AlaskaReportedGroup>();
    for (const event of events) {
      const key = akKey(event.reportedName),
        id = `${event.stance}:${key}`,
        group = grouped.get(id) ?? {
          key,
          reportedName: event.reportedName,
          stance: event.stance,
          amountCents: 0,
          occurrenceCount: 0,
        };
      group.amountCents = akAdd(group.amountCents, event.amountCents);
      group.occurrenceCount++;
      grouped.set(id, group);
    }
    const groups = [...grouped.values()];
    akCheck(
      groups.every((g) => g.amountCents >= 0),
      "negative_group_net",
    );
    for (const group of groups) {
      controls.totalAmountCents = akAdd(
        controls.totalAmountCents,
        group.amountCents,
      );
      controls.occurrenceCount = akAdd(
        controls.occurrenceCount,
        group.occurrenceCount,
      );
      if (group.stance === "support")
        controls.supportCents = akAdd(controls.supportCents, group.amountCents);
      if (group.stance === "oppose")
        controls.opposeCents = akAdd(controls.opposeCents, group.amountCents);
    }
    const observations = [
      ...new Map(
        used.map((o) => [`${o.directory}/${o.meta.file}`, o.meta]),
      ).values(),
    ].sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) ||
        a.completedAt.localeCompare(b.completedAt),
    );
    akCheck(
      observations.length > 0 &&
        observations.every((o) => o.status === 200 && o.eof),
      "source_observation_closure",
    );
    const source = {
      manifestSha256: akManifestHash(observations),
      observedAt: observations.map((o) => o.startedAt).sort()[0]!,
      completedAt: observations
        .map((o) => o.completedAt)
        .sort()
        .at(-1)!,
      observations,
    };
    const packet = freeze({
      component,
      receiver: structuredClone(receiver),
      receiving,
      groups,
      controls,
      source,
    });
    verified.add(packet);
    return packet;
  }
  private async committee(
    receiver: AlaskaReportedReceiver,
    receiving: AlaskaReportedReceivingContext,
    used: AlaskaOriginal[],
    events: Array<Omit<AlaskaReportedGroup, "key" | "occurrenceCount">>,
    controls: AlaskaReportedControls,
  ): Promise<void> {
    const groups = await this.query(
        scope("groups", -1, "", "", "Complete"),
        "csv",
      ),
      entities = await this.query(
        scope("entities", -1, "", "", "Complete"),
        "csv",
      );
    used.push(...populationOriginals(groups), ...populationOriginals(entities));
    const registry = akCsvObjects(groups.csv!.raw),
      entityRows = akCsvObjects(entities.csv!.raw);
    for (const row of registry) {
      akCheck(row.Name && row.Type, "group_registration_fields");
      akSubmittedDay(row.Submitted!);
    }
    // A saved full person query may use the source's comma/legal spelling.
    // Requalify that query and every returned report against canonical names.
    const savedScope = this.populations
      .filter(
        (p) =>
          p.scope.kind === "campaign" &&
          p.scope.year === -1 &&
          p.scope.status === "Default" &&
          p.scope.nameType === "CandidateName" &&
          akPersonMatches(receiver.candidateAliases, p.scope.name, [
            receiver.firstName,
          ]) &&
          akNativePopulationComplete(p),
      )
      .sort((a, b) =>
        b.pages[0]!.original.meta.startedAt.localeCompare(
          a.pages[0]!.original.meta.startedAt,
        ),
      )[0]?.scope;
    const family = await this.query(
      savedScope ??
        scope("campaign", -1, receiving.candidateName, "CandidateName"),
      "native",
    );
    used.push(...populationOriginals(family));
    const seenParents = new Set<string>(),
      duplicates = new Map<string, string>();
    for (const parent of allRows(family)) {
      akCheck(
        !seenParents.has(parent.href),
        "duplicate_current_receiving_parent",
      );
      seenParents.add(parent.href);
      const original = await this.detail(parent.href);
      used.push(original);
      const document = akDocument(original.raw, parent.href);
      try {
        const candidate = akField(document, "Candidate Name:"),
          year = akField(document, "Election Year:"),
          election = akField(document, "Election:");
        akCheck(
          akPersonMatches(receiver.candidateAliases, candidate, [
            receiver.firstName,
          ]) &&
            akPersonMatches(
              receiver.candidateAliases,
              cell(family, parent, "Name"),
              [receiver.firstName],
            ),
          "receiving_report_person",
        );
        akCheck(/^20\d{2}$/.test(year), "receiving_report_year");
        const rows = akMoneyRows(document, "tblIncome", 5),
          total = rows.reduce(
            (sum, row) => akAdd(sum, akCents(akNodeText(row[4]!))),
            0,
          );
        akCheck(
          total === akCents(cell(family, parent, "Total Income")),
          "receiving_parent_income_closure",
        );
        for (const row of rows) {
          const amount = akCents(akNodeText(row[4]!)),
            date = akDate(akNodeText(row[0]!));
          if (Number(year) !== receiver.electionYear) continue;
          akCheck(
            ["State Primary", "State General"].includes(election),
            "receiving_state_election",
          );
          controls.sourceRows++;
          const leaves: string[] = [];
          const visit = (n: Node) => {
            if (n.nodeType === 3) {
              const value = (n.textContent ?? "").trim();
              if (value) leaves.push(value);
            } else n.childNodes.forEach(visit);
          };
          visit(row[2]!);
          const name = leaves[0] === "Name:" ? leaves[1] : leaves[0];
          akCheck(name, "income_contributor_name");
          if (
            !matchesAlaskaReportedPac({
              name,
              address: akRenderedText(row[2]!),
              date,
              payment: akNodeText(row[1]!),
              registry,
              entities: entityRows,
            })
          ) {
            controls.excludedRows++;
            continue;
          }
          const duplicate = signature(row.map(akNodeText)),
            previous = duplicates.get(duplicate);
          akCheck(
            !previous || previous === parent.href,
            "cross_report_receipt_duplicate",
          );
          duplicates.set(duplicate, parent.href);
          events.push({
            reportedName: name,
            stance: "committee",
            amountCents: amount,
          });
        }
      } finally {
        document.defaultView?.close();
        await new Promise<void>((done) => setImmediate(done));
      }
    }
  }
  private async ie(
    receiver: AlaskaReportedReceiver,
    nominees: AlaskaHouseNominee[],
    used: AlaskaOriginal[],
    events: Array<Omit<AlaskaReportedGroup, "key" | "occurrenceCount">>,
    controls: AlaskaReportedControls,
  ): Promise<void> {
    const search = await this.query(
      scope("ie", -1, receiver.lastName, "Candidate"),
      "cycle",
      receiver.electionYear,
    );
    used.push(...populationOriginals(search));
    if (!akNativePopulationComplete(search)) {
      akCheck(
        akCsvPopulationComplete(search) &&
          akCsvObjects(search.csv!.raw).every(
            (r) =>
              akCandidateChoice(r["Candidate/Proposition"]!).year !==
              receiver.electionYear,
          ),
        "ie_lifetime_scope_incomplete",
      );
      return;
    }
    const current = allRows(search).filter((row) => {
      if (cell(search, row, "Type") !== "Candidate") return false;
      const choice = akCandidateChoice(
        cell(search, row, "Candidate/Proposition"),
      );
      return choice.year === receiver.electionYear;
    });
    const years = [
        ...new Set(
          current.map((row) => integer(cell(search, row, "Report Year"))),
        ),
      ],
      universe: IeRecord[] = [];
    for (const year of years) {
      let pending = this.ieYears.get(year);
      if (!pending) {
        pending = this.ieYear(year);
        this.ieYears.set(year, pending);
      }
      const result = await pending;
      universe.push(...result.records);
      used.push(...result.originals);
    }
    await this.aggregateIe(
      receiver,
      nominees,
      search,
      current,
      universe,
      events,
      controls,
    );
  }
  private async ieYear(
    year: number,
  ): Promise<{ records: IeRecord[]; originals: AlaskaOriginal[] }> {
    const used: AlaskaOriginal[] = [],
      universe: IeRecord[] = [];
    const financial = await this.query(scope("ie", year), "native"),
      parents = await this.query(scope("ieParents", year), "native");
    used.push(
      ...populationOriginals(financial),
      ...populationOriginals(parents),
    );
    const parentMap = new Map<string, AlaskaNativeGridRow>();
    for (const row of allRows(parents)) {
      akCheck(!parentMap.has(row.href), "duplicate_current_ie_parent");
      parentMap.set(row.href, row);
    }
    const financialRows = allRows(financial);
    akCheck(
      financialRows.every((row) => parentMap.has(row.href)),
      "ie_current_parent_membership",
    );
    for (const parent of parentMap.values()) {
      const rows = financialRows.filter((row) => row.href === parent.href),
        paid = rows.filter((row) => !!cell(financial, row, "Payment Type")),
        debts = rows.filter((row) => !cell(financial, row, "Payment Type"));
      const original = await this.detail(parent.href);
      used.push(original);
      const document = akDocument(original.raw, parent.href);
      try {
        const nativePaid = akMoneyRows(document, "tblExpenditures", 5),
          nativeDebts = akMoneyRows(document, "tblDebts", 4),
          total = (rs: AlaskaNativeGridRow[]) =>
            rs.reduce(
              (sum, row) => akAdd(sum, akCents(cell(financial, row, "Amount"))),
              0,
            );
        akCheck(
          paid.length === integer(cell(parents, parent, "Expenditures")) &&
            debts.length === integer(cell(parents, parent, "Debts")) &&
            total(paid) ===
              akCents(cell(parents, parent, "Expenditure Total")) &&
            total(debts) === akCents(cell(parents, parent, "Debt Total")),
          "ie_parent_signed_closure",
        );
        akCheck(
          nativePaid.length === paid.length &&
            nativeDebts.length === debts.length &&
            nativePaid.reduce(
              (n, row) => akAdd(n, akCents(akNodeText(row[4]!))),
              0,
            ) === total(paid) &&
            nativeDebts.reduce(
              (n, row) => akAdd(n, akCents(akNodeText(row[3]!))),
              0,
            ) === total(debts),
          "ie_native_paid_debt_closure",
        );
        akCheck(
          rows.every(
            (row) =>
              cell(financial, row, "Filer") === cell(parents, parent, "Filer"),
          ),
          "ie_economic_filer",
        );
        const electionYear = akField(document, "Election Year:"),
          election = akField(document, "Election:");
        for (const row of rows)
          universe.push({
            row,
            population: financial,
            parent,
            parents,
            year: electionYear,
            election,
          });
      } finally {
        document.defaultView?.close();
        await new Promise<void>((done) => setImmediate(done));
      }
    }
    return { records: universe, originals: used };
  }
  private async aggregateIe(
    receiver: AlaskaReportedReceiver,
    nominees: AlaskaHouseNominee[],
    search: AlaskaRecordedPopulation,
    current: AlaskaNativeGridRow[],
    universe: IeRecord[],
    events: Array<Omit<AlaskaReportedGroup, "key" | "occurrenceCount">>,
    controls: AlaskaReportedControls,
  ): Promise<void> {
    const keys = (p: AlaskaRecordedPopulation, row: AlaskaNativeGridRow) =>
      signature([row.href, row.cells]);
    const baseline = new Map<string, number>();
    for (const record of universe) {
      const key = keys(record.population, record.row);
      baseline.set(key, (baseline.get(key) ?? 0) + 1);
    }
    for (const row of current) {
      const key = keys(search, row),
        count = baseline.get(key) ?? 0;
      akCheck(count > 0, "ie_lifetime_current_closure");
      baseline.set(key, count - 1);
    }
    const duplicates = new Map<string, Set<string>>();
    for (const { row, population } of universe) {
      const key = signature(
          [
            "Filer",
            "Date",
            "Recipient",
            "Address",
            "City",
            "State",
            "Zip",
            "Country",
            "Position",
            "Candidate/Proposition",
            "Description",
            "Payment Type",
            "Payment Detail",
            "Amount",
          ].map((name) => cell(population, row, name)),
        ),
        parents = duplicates.get(key) ?? new Set<string>();
      parents.add(row.href);
      duplicates.set(key, parents);
    }
    for (const { row, population, year, election } of universe) {
      if (cell(population, row, "Type") !== "Candidate") continue;
      const choice = akCandidateChoice(
        cell(population, row, "Candidate/Proposition"),
      );
      if (
        choice.year !== receiver.electionYear ||
        !akPersonMatches(receiver.candidateAliases, choice.name, [
          receiver.firstName,
        ])
      )
        continue;
      const canonical = nominees.filter((n) =>
          akPersonMatches(receiver.candidateAliases, n.name, [
            receiver.firstName,
          ]),
        ),
        targets = nominees.filter((n) =>
          akPersonMatches([n.name], choice.name),
        );
      // Canonical legal/display aliases can corroborate two source spellings
      // that do not directly match one another. A competing roster match vetoes.
      akCheck(
        canonical.length === 1 &&
          canonical[0]!.district === receivingDistrict(receiver) &&
          targets.length <= 1 &&
          targets.every((n) => n === canonical[0]),
        "ie_target_seat_ambiguity",
      );
      akCheck(
        year === String(choice.year) &&
          ["State Primary", "State General"].includes(election),
        "ie_explicit_parent_election",
      );
      controls.sourceRows++;
      akDate(cell(population, row, "Date"));
      akCents(cell(population, row, "Amount"));
      if (!cell(population, row, "Payment Type")) {
        controls.debtRows++;
        continue;
      }
      const key = signature(
        [
          "Filer",
          "Date",
          "Recipient",
          "Address",
          "City",
          "State",
          "Zip",
          "Country",
          "Position",
          "Candidate/Proposition",
          "Description",
          "Payment Type",
          "Payment Detail",
          "Amount",
        ].map((name) => cell(population, row, name)),
      );
      akCheck(duplicates.get(key)!.size === 1, "cross_report_ie_duplicate");
      const position = cell(population, row, "Position");
      akCheck(["Supports", "Opposes"].includes(position), "ie_explicit_stance");
      events.push({
        reportedName: cell(population, row, "Filer"),
        stance: position === "Supports" ? "support" : "oppose",
        amountCents: akCents(cell(population, row, "Amount")),
      });
    }
  }
}
import { akCanonicalHouseDistrict as receivingDistrict } from "./alaskaReportedReceiver.js";
