import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { isVirginiaReportedRawRefreshEnabled } from "../../config/featureFlags.js";
import { committeeNameMiddleEvidenceRowNames } from "../finance/personNameMiddleEvidence.js";
import {
  VirginiaOriginalArchive,
  vaFreshOriginal,
  vaSuccessfulOriginal,
  vaManifestHash,
  type VirginiaOriginal,
  type VirginiaOriginalMeta,
} from "./virginiaReportedOriginals.js";
import {
  vaAdd,
  vaCheck,
  vaDocument,
  vaField,
  vaHouseSeat,
  vaKey,
  vaNodeText,
  vaObservedDay,
  vaPersonMatches,
  vaPublicUrl,
  VIRGINIA_REPORTED_ORIGIN,
  VIRGINIA_REPORTED_URLS,
  type VirginiaReportedComponent,
} from "./virginiaReportedNative.js";
import {
  vaCanonicalHouseDistrict,
  type VirginiaReportedReceiver,
  type VirginiaReportedReceivingContext,
} from "./virginiaReportedReceiver.js";
import {
  vaAllocatedCents,
  vaAddress,
  vaDay,
  vaIeDetail,
  vaIeIndex,
  vaInventory,
  vaPacIdentity,
  vaPartitionReports,
  vaRegistrations,
  vaReport,
  type VirginiaNativeReport,
  type VirginiaRegistration,
} from "./virginiaReportedProtocol.js";

export type VirginiaReportedGroup = {
  key: string;
  reportedName: string;
  stance: "committee" | "support" | "oppose";
  amountCents: number;
  occurrenceCount: number;
};
export type VirginiaReportedControls = {
  totalAmountCents: number;
  occurrenceCount: number;
  sourceRows: number;
  excludedRows: number;
  debtRows: number;
  supportCents: number;
  opposeCents: number;
  unverifiedPacRows: number;
};
export type VirginiaReportedSourceFacts = {
  manifestSha256: string;
  observedAt: string;
  completedAt: string;
  observations: VirginiaOriginalMeta[];
};
export type VirginiaReportedPacket = {
  component: VirginiaReportedComponent;
  receiver: VirginiaReportedReceiver;
  receiving: VirginiaReportedReceivingContext;
  groups: VirginiaReportedGroup[];
  controls: VirginiaReportedControls;
  source: VirginiaReportedSourceFacts;
};
const verified = new WeakSet<object>();
export const isVerifiedVirginiaReportedPacket = (
  value: VirginiaReportedPacket,
): boolean => verified.has(value);
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
const queryUrl = (name: string) => {
  const u = new URL(VIRGINIA_REPORTED_ORIGIN);
  u.searchParams.set("CommitteeName", name);
  u.searchParams.set("CommitteeType", "");
  return u.href;
};
const sameUrl = (a: string, b: string) => {
  const ua = new URL(a),
    ub = new URL(b);
  ua.searchParams.sort();
  ub.searchParams.sort();
  return ua.href === ub.href;
};
const reportUrl = (id: number) =>
  `${VIRGINIA_REPORTED_ORIGIN}/Report/ReportXML/${id}`;
/** One ordinary run shares originals, but independently seals each component. */
export class VirginiaReportedSource {
  private originals: VirginiaOriginal[] = [];
  private ready: Promise<void> | null = null;
  private ie: Promise<{
    parents: ReturnType<typeof vaIeIndex>;
    details: (ReturnType<typeof vaIeDetail> & { observedDay: string })[];
    used: VirginiaOriginal[];
  }> | null = null;
  constructor(
    private readonly archive = new VirginiaOriginalArchive(),
    private readonly refresh = false,
  ) {}
  private init() {
    return (this.ready ??= (async () => {
      this.originals = await this.archive.read();
    })());
  }
  private saved(url: string, mime: "html" | "xml" | "xlsx") {
    return this.originals
      .filter(
        (o) =>
          o.meta.method === "GET" &&
          sameUrl(o.meta.url, url) &&
          vaSuccessfulOriginal(o, mime) &&
          vaFreshOriginal(o),
      )
      .sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt));
  }
  private async original(
    url: string,
    mime: "html" | "xml" | "xlsx",
    used: VirginiaOriginal[],
    force = false,
  ): Promise<VirginiaOriginal> {
    let o = force ? undefined : this.saved(url, mime).at(-1);
    if (!o) {
      vaCheck(
        this.refresh && isVirginiaReportedRawRefreshEnabled(),
        "saved_original_unavailable",
      );
      o = await this.archive.observe(url);
      vaCheck(vaSuccessfulOriginal(o, mime), "incomplete_public_original");
      this.originals.push(o);
    }
    used.push(o);
    return o;
  }
  private async stable<T>(
    url: string,
    parse: (o: VirginiaOriginal) => T,
    used: VirginiaOriginal[],
  ): Promise<T> {
    const saved = this.saved(url, "html");
    const opening = this.refresh
      ? await this.original(url, "html", used, true)
      : (saved.at(-2) ??
        saved.at(-1) ??
        (await this.original(url, "html", used)));
    let closing = saved.length > 1 ? saved.at(-1) : undefined;
    if (!closing || this.refresh)
      closing = await this.original(url, "html", used, true);
    used.push(opening, closing);
    const a = parse(opening),
      b = parse(closing);
    vaCheck(isDeepStrictEqual(a, b), "native_scope_changed");
    return b;
  }
  private async registry(
    name: string,
    used: VirginiaOriginal[],
  ): Promise<VirginiaRegistration[]> {
    const u = queryUrl(name);
    return this.stable(u, (o) => vaRegistrations(o.raw, o.meta.url), used);
  }
  private async inventory(id: string, used: VirginiaOriginal[]) {
    const u = `${VIRGINIA_REPORTED_ORIGIN}/Committee/Index/${encodeURIComponent(id)}`;
    return this.stable(u, (o) => vaInventory(o.raw, id, u), used);
  }
  private async reports(
    id: string,
    used: VirginiaOriginal[],
    receiving = true,
  ) {
    const inventory = await this.inventory(id, used),
      reports: VirginiaNativeReport[] = [];
    const headers: { name: string; address: string[]; filed: string }[] = [];
    for (const [rapid, ids] of [
      [false, inventory.scheduledReportIds],
      [true, inventory.largeContributionReportIds],
    ] as const) {
      for (const n of ids) {
        const o = await this.original(reportUrl(n), "xml", used);
        if (receiving) {
          const report = vaReport(o.raw);
          vaCheck(
            report.rapid === rapid &&
              report.code === inventory.committeeCode &&
              vaKey(report.name) === vaKey(inventory.committeeName!),
            "report_inventory_binding",
          );
          const observedDay = vaObservedDay(o.meta.completedAt);
          vaCheck(
            report.rows.every((row) => row.day <= observedDay),
            "future_at_original_observation",
          );
          reports.push(report);
        } else {
          const d = vaDocument(o.raw, true);
          try {
            const h = d.querySelector("ReportHeader");
            vaCheck(h, "donor_native_header");
            vaCheck(
              vaField(h, "CommitteeCode") === inventory.committeeCode &&
                vaKey(vaField(h, "CommitteeName")) ===
                  vaKey(inventory.committeeName!),
              "donor_report_inventory_binding",
            );
            headers.push({
              name: vaField(h, "CommitteeName"),
              address: vaAddress(h),
              filed: vaDay(vaField(h, "FilingDate")),
            });
          } finally {
            d.defaultView?.close();
          }
        }
        await new Promise<void>((done) => setImmediate(done));
      }
    }
    return { inventory, reports, headers };
  }
  private async receiver(
    r: VirginiaReportedReceiver,
    used: VirginiaOriginal[],
  ): Promise<VirginiaReportedReceivingContext> {
    const district = vaCanonicalHouseDistrict(r),
      inventory = await this.inventory(r.receivingId, used),
      registry = await this.registry(inventory.committeeName!, used);
    const exact = registry.filter(
      (v) => vaKey(v.name) === vaKey(inventory.committeeName!),
    );
    vaCheck(
      exact.length === 1 &&
        exact[0]!.id === r.receivingId &&
        exact[0]!.type === "Candidate Campaign Committee" &&
        vaPersonMatches(
          r.candidateAliases,
          exact[0]!.candidate.replace(/^(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+/i, ""),
          [r.firstName],
        ),
      "native_receiving_person",
    );
    const index = await this.original(
        VIRGINIA_REPORTED_URLS.roster,
        "html",
        used,
      ),
      d = vaDocument(index.raw);
    let urls: string[] = [];
    try {
      urls = [...d.querySelectorAll("a[href]")]
        .filter((n) =>
          new RegExp(
            `^${r.electionYear} November Virginia House of Delegates, District ${district} Special Election$`,
            "i",
          ).test(vaNodeText(n)),
        )
        .map((n) => vaPublicUrl(n.getAttribute("href")!, index.meta.url));
    } finally {
      d.defaultView?.close();
    }
    // Other election dates/offices require their own verified ballot publication.
    vaCheck(
      urls.length === 1 && r.electionDate === `${r.electionYear}-11-03`,
      "official_ballot_context_unqualified",
    );
    const roster = await this.original(urls[0]!, "xlsx", used),
      xlsx = createRequire(import.meta.url)("xlsx") as typeof import("xlsx"),
      w = xlsx.read(roster.raw, { type: "buffer", raw: true });
    vaCheck(w.SheetNames.length === 1, "official_roster_sheets");
    const rows = xlsx.utils.sheet_to_json<unknown[]>(
        w.Sheets[w.SheetNames[0]!]!,
        { header: 1, raw: true, defval: null },
      ),
      header = rows[0]!;
    const col = (name: string) => {
      vaCheck(
        header.filter((v) => v === name).length === 1,
        "official_roster_header",
      );
      return header.indexOf(name);
    };
    const nameCol = col("Candidate Name"),
      officeCol = col("Office Title"),
      districtCol = col("District"),
      names = new Set<string>();
    for (const row of rows.slice(1)) {
      vaCheck(
        typeof row[nameCol] === "string" &&
          typeof row[officeCol] === "string" &&
          typeof row[districtCol] === "string",
        "official_roster_row",
      );
      if (
        vaPersonMatches(r.candidateAliases, row[nameCol] as string, [
          r.firstName,
        ])
      ) {
        vaCheck(
          vaKey(row[officeCol] as string) === "MEMBER, HOUSE OF DELEGATES" &&
            new RegExp(`^${district}(?:st|nd|rd|th) District$`).test(
              row[districtCol] as string,
            ),
          "official_roster_seat",
        );
        names.add(row[nameCol] as string);
      }
    }
    vaCheck(names.size === 1, "official_roster_unique_person");
    return {
      receivingId: r.receivingId,
      candidateName: [...names][0]!,
      committeeName: inventory.committeeName!,
      officeName: r.officeName,
      district,
      electionYear: r.electionYear,
    };
  }
  private iePopulation() {
    return (this.ie ??= (async () => {
      const used: VirginiaOriginal[] = [],
        url = VIRGINIA_REPORTED_URLS.ie;
      const saved = this.saved(url, "html");
      const opening = this.refresh
        ? await this.original(url, "html", used, true)
        : (saved.at(-2) ?? (await this.original(url, "html", used)));
      used.push(opening);
      const parents = vaIeIndex(opening.raw, url),
        details: (ReturnType<typeof vaIeDetail> & { observedDay: string })[] =
          [];
      for (const parent of parents) {
        const o = await this.original(parent.url, "html", used);
        details.push({
          ...vaIeDetail(o.raw, parent),
          observedDay: vaObservedDay(o.meta.completedAt),
        });
        await new Promise<void>((done) => setImmediate(done));
      }
      const indexes = this.saved(url, "html"),
        closing = this.refresh
          ? await this.original(url, "html", used, true)
          : indexes.at(-1);
      vaCheck(
        closing &&
          closing !== opening &&
          closing.meta.completedAt >= opening.meta.completedAt,
        "saved_ie_closing_unavailable",
      );
      used.push(closing);
      vaCheck(
        isDeepStrictEqual(parents, vaIeIndex(closing.raw, url)),
        "ie_index_changed",
      );
      return { parents, details, used };
    })());
  }
  async get(
    receiver: VirginiaReportedReceiver,
    component: VirginiaReportedComponent,
  ): Promise<VirginiaReportedPacket> {
    await this.init();
    const used: VirginiaOriginal[] = [],
      receiving = await this.receiver(receiver, used),
      events: Array<Omit<VirginiaReportedGroup, "key" | "occurrenceCount">> =
        [],
      controls: VirginiaReportedControls = {
        totalAmountCents: 0,
        occurrenceCount: 0,
        sourceRows: 0,
        excludedRows: 0,
        debtRows: 0,
        supportCents: 0,
        opposeCents: 0,
        unverifiedPacRows: 0,
      };
    if (component === "committee") {
      const family = await this.reports(receiver.receivingId, used),
        reports = family.reports;
      vaCheck(
        reports
          .filter((r) => r.year === receiver.electionYear)
          .every(
            (r) =>
              vaKey(r.office) === "MEMBER, HOUSE OF DELEGATES" &&
              vaHouseSeat(r.district) === receiving.district,
          ),
        "receiving_report_election_scope",
      );
      const rows = vaPartitionReports(reports, receiver.electionYear),
        byName = new Map<
          string,
          {
            registry: VirginiaRegistration[];
            headers: { name: string; address: string[]; filed: string }[];
          }
        >();
      for (const row of rows) {
        controls.sourceRows++;
        if (row.individual) {
          controls.excludedRows++;
          continue;
        }
        const k = vaKey(row.name);
        let evidence = byName.get(k);
        if (!evidence) {
          const registry = await this.registry(row.name, used),
            matches = registry.filter((v) => vaKey(v.name) === k);
          let headers: { name: string; address: string[]; filed: string }[] =
            [];
          if (
            matches.length === 1 &&
            matches[0]!.type === "Political Action Committee"
          )
            headers = (await this.reports(matches[0]!.id, used, false)).headers;
          evidence = { registry, headers };
          byName.set(k, evidence);
        }
        if (!vaPacIdentity(row, evidence.registry, evidence.headers)) {
          controls.excludedRows++;
          if (
            evidence.registry.some(
              (r) =>
                vaKey(r.name) === k && r.type === "Political Action Committee",
            )
          )
            controls.unverifiedPacRows++;
          continue;
        }
        events.push({
          reportedName: row.name,
          stance: "committee",
          amountCents: row.cents,
        });
      }
    } else {
      const population = await this.iePopulation();
      used.push(...population.used);
      for (let i = 0; i < population.parents.length; i++) {
        const parent = population.parents[i]!,
          detail = population.details[i]!;
        if (detail.day.slice(0, 4) !== String(receiver.electionYear)) continue;
        for (const target of detail.targets) {
          const exact = vaKey(target.name) === vaKey(receiving.committeeName),
            person = committeeNameMiddleEvidenceRowNames(target.name).some(
              (name) =>
                vaPersonMatches(receiver.candidateAliases, name, [
                  receiver.firstName,
                ]),
            );
          if (!exact && !person) {
            // A surname lead must not turn an unresolved identity into a reported zero.
            const tokens = vaKey(target.name)
              .replace(/[^A-Z0-9]+/g, " ")
              .split(" ");
            vaCheck(
              !tokens.includes(vaKey(receiver.lastName)),
              "unresolved_ie_target_name",
            );
            continue;
          }
          vaCheck(exact, "ie_target_committee_unresolved");
          vaCheck(
            [
              "MEMBER, HOUSE OF DELEGATES",
              "MEMBER HOUSE OF DELEGATES",
            ].includes(vaKey(target.office)),
            "ie_target_office_scope",
          );
          // Only this candidate's rows hold the component; a stray future date
          // elsewhere in the statewide index does not block everyone.
          vaCheck(
            detail.day <= detail.observedDay,
            "future_at_original_observation",
          );
          controls.sourceRows++;
          events.push({
            reportedName: parent.spender,
            stance: target.stance,
            amountCents: vaAllocatedCents(parent.cents, target),
          });
        }
      }
    }
    const groups = new Map<string, VirginiaReportedGroup>();
    for (const e of events) {
      const key = vaKey(e.reportedName),
        id = `${e.stance}:${key}`,
        g = groups.get(id) ?? { ...e, key, amountCents: 0, occurrenceCount: 0 };
      g.amountCents = vaAdd(g.amountCents, e.amountCents);
      g.occurrenceCount++;
      groups.set(id, g);
      controls.totalAmountCents = vaAdd(
        controls.totalAmountCents,
        e.amountCents,
      );
      controls.occurrenceCount++;
      if (e.stance === "support")
        controls.supportCents = vaAdd(controls.supportCents, e.amountCents);
      if (e.stance === "oppose")
        controls.opposeCents = vaAdd(controls.opposeCents, e.amountCents);
    }
    const observations = [
      ...new Map(
        used.map((o) => [`${o.directory}/${o.meta.file}`, o.meta]),
      ).values(),
    ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    vaCheck(observations.length > 0, "source_observations");
    const source = {
      observations,
      manifestSha256: vaManifestHash(observations),
      observedAt: observations[0]!.startedAt,
      completedAt: observations
        .map((o) => o.completedAt)
        .sort()
        .at(-1)!,
    };
    const packet = freeze({
      receiver: structuredClone(receiver),
      receiving,
      component,
      groups: [...groups.values()],
      controls,
      source,
    });
    verified.add(packet);
    return packet;
  }
}
