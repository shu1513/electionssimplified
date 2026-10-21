import { isDeepStrictEqual } from "node:util";
import { isIndianaNativePacRawRefreshEnabled } from "../../config/featureFlags.js";
import {
  IndianaNativeOriginalArchive,
  inSuccessfulOriginal,
  type IndianaNativeOriginal,
} from "./indianaNativeOriginals.js";
import {
  INDIANA_NATIVE_ORIGIN,
  inCheck,
  inForm,
  inHtml,
  inText,
  inPublicUrl,
  parseIndianaNativeCommittee,
  parseIndianaNativeFilingPage,
  selectIndianaNativeFilingVersion,
  parseIndianaNativeMonetaryReport,
  parseIndianaNativeReceiptPage,
  type IndianaNativeFiling,
  type IndianaNativePager,
} from "./indianaNativeProtocol.js";
import {
  qualifyIndianaNativeReceiver,
  type IndianaNativeReceiver,
} from "./indianaNativeReceiver.js";
const BASE = INDIANA_NATIVE_ORIGIN + "/PublicSite/SearchPages/";
const document = (o: IndianaNativeOriginal) => {
  inCheck(
    inSuccessfulOriginal(o, "html"),
    "native_acquisition_html_unavailable",
  );
  return inHtml(o.raw, o.meta.url);
};
function control<T extends Element>(d: Document, suffix: string): T {
  const a = d.querySelectorAll<T>("#_ctl0_Content_" + suffix);
  inCheck(a.length === 1, "native_acquisition_control");
  return a[0]!;
}
function callback(
  d: Document,
  action: [string, string],
  pager?: IndianaNativePager,
) {
  const f = inForm(d);
  f.set("__EVENTTARGET", action[0]);
  f.set("__EVENTARGUMENT", action[1]);
  if (pager) f.set(pager.sizeName, pager.size50Value);
  return f;
}
/** Acquire only actual published actions. Resource ceilings cause a hold rather
 * than certification of a truncated ledger. Every failure original survives. */
export class IndianaNativePacCollector {
  constructor(private archive: IndianaNativeOriginalArchive) {}
  private async follow(url: string): Promise<IndianaNativeOriginal> {
    for (let i = 0; i < 6; i++) {
      const o = await this.archive.observe(url);
      if (![301, 302, 303, 307, 308].includes(o.meta.status)) return o;
      inCheck(o.meta.eof && o.meta.location, "native_acquisition_redirect");
      url = inPublicUrl(o.meta.location, o.meta.url);
    }
    inCheck(false, "native_acquisition_redirect_limit");
  }
  private async committee(receiver: IndianaNativeReceiver) {
    const url = BASE + "CommitteeSearch.aspx",
      form = await this.follow(url),
      d = document(form);
    let body: URLSearchParams;
    try {
      body = inForm(d);
      const input = control<HTMLInputElement>(
          d,
          "ucCommitteeControl_txtCommitteeID",
        ),
        submit = control<HTMLInputElement>(d, "btnSearch");
      body.set(input.name, receiver.receivingId);
      body.set(submit.name, submit.value);
    } finally {
      d.defaultView?.close();
    }
    const posted = await this.archive.observe(url, body);
    inCheck(
      posted.meta.status === 302 && posted.meta.eof && posted.meta.location,
      "native_committee_search_redirect",
    );
    const target = inPublicUrl(posted.meta.location, posted.meta.url);
    inCheck(
      new URL(target).pathname ===
        "/PublicSite/SearchPages/CommitteeDetail.aspx",
      "native_committee_search_not_unique",
    );
    const o = await this.follow(target),
      page = document(o);
    try {
      qualifyIndianaNativeReceiver(receiver, parseIndianaNativeCommittee(page));
    } finally {
      page.defaultView?.close();
    }
    return target;
  }
  private async inventory(url: string, receiver: IndianaNativeReceiver) {
    let current = await this.follow(url),
      d = document(current);
    const pages: {
      original: IndianaNativeOriginal;
      rows: IndianaNativeFiling[];
    }[] = [];
    try {
      qualifyIndianaNativeReceiver(receiver, parseIndianaNativeCommittee(d));
      let parsed = parseIndianaNativeFilingPage(d),
        action: [string, string] | null = parsed.pager.resize;
      while (action) {
        const body = callback(d, action, parsed.pager);
        d.defaultView?.close();
        current = await this.archive.observe(url, body);
        d = document(current);
        qualifyIndianaNativeReceiver(receiver, parseIndianaNativeCommittee(d));
        parsed = parseIndianaNativeFilingPage(d);
        inCheck(
          parsed.pager.page === pages.length + 1,
          "native_inventory_page_sequence",
        );
        pages.push({ original: current, rows: parsed.rows });
        inCheck(pages.length <= 100, "native_inventory_resource_limit");
        action = parsed.pager.next;
      }
      return pages;
    } finally {
      d.defaultView?.close();
    }
  }
  private async families(
    pages: Awaited<ReturnType<IndianaNativePacCollector["inventory"]>>,
    receiver: IndianaNativeReceiver,
  ) {
    const y = receiver.electionYear,
      kinds = new Set([
        `${y - 1} Annual Report`,
        `${y} PrePrimary Report`,
        `${y} PreElect Report`,
        `${y} Annual Report`,
      ]);
    for (const p of pages)
      for (const filing of p.rows) {
        if (
          !kinds.has(filing.kind) &&
          !(
            filing.kind === "Large Contribution Report" &&
            new RegExp(`/(?:${y - 1}|${y})$`).test(filing.end)
          )
        )
          continue;
        let d = document(p.original),
          body: URLSearchParams;
        try {
          body = callback(d, filing.callback);
        } finally {
          d.defaultView?.close();
        }
        const opened = await this.archive.observe(p.original.meta.url, body);
        inCheck(
          opened.meta.status === 302 && opened.meta.eof && opened.meta.location,
          "native_family_open_redirect",
        );
        const familyUrl = inPublicUrl(opened.meta.location, opened.meta.url);
        inCheck(
          new URL(familyUrl).pathname ===
            "/PublicSite/SearchPages/FilingAmendmentSelect.aspx",
          "native_family_path",
        );
        const family = await this.follow(familyUrl);
        d = document(family);
        try {
          const selected = selectIndianaNativeFilingVersion(
            d,
            filing.kind,
            filing.amended,
          );
          body = callback(d, selected.callback);
        } finally {
          d.defaultView?.close();
        }
        const selected = await this.archive.observe(familyUrl, body);
        if (filing.kind === "Large Contribution Report") {
          inCheck(
            inSuccessfulOriginal(selected, "html"),
            "native_supplement_selection_unavailable",
          );
          continue;
        }
        inCheck(
          selected.meta.status === 302 &&
            selected.meta.eof &&
            selected.meta.location,
          "native_monetary_selection_redirect",
        );
        const parentUrl = inPublicUrl(
          selected.meta.location,
          selected.meta.url,
        );
        inCheck(
          new URL(parentUrl).pathname ===
            "/PublicSite/SearchPages/FilingDetail.aspx",
          "native_monetary_parent_path",
        );
        for (const phase of ["opening", "closing"]) {
          const parent = await this.follow(parentUrl);
          d = document(parent);
          let report;
          try {
            report = parseIndianaNativeMonetaryReport(d, parent.meta.url);
          } finally {
            d.defaultView?.close();
          }
          await this.follow(report.contributionsUrl);
          await this.follow(report.returnsUrl);
        }
      }
  }
  private async receipts(
    receiver: IndianaNativeReceiver,
    begin: string,
    end: string,
    pac: boolean,
  ) {
    const url = BASE + "ContributionSearch.aspx",
      form = await this.follow(url);
    let d = document(form),
      body: URLSearchParams;
    try {
      body = inForm(d);
      const set = (suffix: string, value: string) => {
        const n = control<HTMLInputElement>(d, suffix);
        body.set(n.name, value);
      };
      const donor = control<HTMLSelectElement>(d, "ddlContributorType"),
        choice = pac
          ? [...donor.options].filter(
              (o) => inText(o) === "Political Action Committee",
            )
          : [donor.options[0]!];
      inCheck(choice.length === 1, "native_donor_class_option");
      body.set(donor.name, choice[0]!.value);
      const cls = control<HTMLSelectElement>(
          d,
          "ucCommitteeCandidateSearch_ddlCommitteeType",
        ),
        candidate = [...cls.options].filter((o) => inText(o) === "Candidate");
      inCheck(candidate.length === 1, "native_recipient_class_option");
      body.set(cls.name, candidate[0]!.value);
      const mode = control<HTMLInputElement>(
        d,
        "ucCommitteeCandidateSearch_rblCommitteeCandidateSelection_0",
      );
      body.set(mode.name, mode.value);
      const day = (s: string) => {
        inCheck(/^\d{4}-\d{2}-\d{2}$/.test(s), "native_query_day");
        return `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
      };
      set("ucCommitteeCandidateSearch_txtCommitteeID", receiver.receivingId);
      set("txtContributionDateBegin", day(begin));
      set("txtContributionDateEnd", day(end));
      const submit = control<HTMLInputElement>(d, "btnSearch");
      body.set(submit.name, submit.value);
    } finally {
      d.defaultView?.close();
    }
    const search = await this.archive.observe(url, body);
    inCheck(
      search.meta.status === 302 && search.meta.eof && search.meta.location,
      "native_receipt_query_unavailable",
    );
    const target = inPublicUrl(search.meta.location, search.meta.url);
    inCheck(
      new URL(target).pathname === new URL(url).pathname,
      "native_receipt_query_path",
    );
    let current = await this.follow(target);
    d = document(current);
    const rows: ReturnType<typeof parseIndianaNativeReceiptPage>["rows"] = [];
    try {
      const initial = parseIndianaNativeReceiptPage(d, target);
      let parsed = initial,
        action: [string, string] | null = parsed.pager.resize,
        pages = 0;
      while (action) {
        body = callback(d, action, parsed.pager);
        d.defaultView?.close();
        current = await this.archive.observe(target, body);
        d = document(current);
        parsed = parseIndianaNativeReceiptPage(d, target);
        inCheck(
          parsed.count === initial.count &&
            parsed.totalCents === initial.totalCents &&
            parsed.pager.page === ++pages,
          "native_receipt_query_changed",
        );
        rows.push(...parsed.rows);
        inCheck(
          rows.length <= initial.count &&
            rows.length <= 100000 &&
            pages <= 2000,
          "native_receipt_resource_limit",
        );
        if (rows.length === initial.count) break;
        action = parsed.pager.next;
      }
      inCheck(rows.length === initial.count, "native_receipt_walk_incomplete");
      return rows;
    } finally {
      d.defaultView?.close();
    }
  }
  async collect(receiver: IndianaNativeReceiver, through: string) {
    inCheck(
      isIndianaNativePacRawRefreshEnabled(),
      "native_pac_raw_refresh_disabled",
    );
    const url = await this.committee(receiver),
      opening = await this.inventory(url, receiver);
    await this.families(opening, receiver);
    const details = new Set<string>();
    for (const phase of ["opening", "closing"])
      for (const [begin, end] of [
        [
          `${receiver.electionYear - 1}-01-01`,
          `${receiver.electionYear - 1}-12-31`,
        ],
        [`${receiver.electionYear}-01-01`, through],
      ])
        for (const pac of [false, true])
          for (const row of await this.receipts(receiver, begin!, end!, pac))
            if (pac) details.add(row.url);
    for (const target of details) await this.follow(target);
    const closing = await this.inventory(url, receiver);
    inCheck(
      isDeepStrictEqual(
        opening.flatMap((p) => p.rows),
        closing.flatMap((p) => p.rows),
      ),
      "filing_inventory_changed",
    );
    await this.families(closing, receiver);
  }
}
