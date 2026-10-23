import { describe, expect, it } from "vitest";
import { parseColoradoCandidateListing } from "../../../src/pipeline/coloradoFinance/coloradoTracerReports.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const str = (value: Uint8Array) => new TextDecoder().decode(value);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const attrs = (values: Record<string, string>) =>
  Object.entries(values)
    .map(
      ([key, value]) =>
        `${key}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`,
    )
    .join(" ");
function listing(overrides: Record<string, string> = {}, count = 1) {
  const scope = {
    JurisdictionSelection: "STATEWIDE",
    ElectionYear: "2026",
    OfficeSelection: "ALL",
    DistrictSelection: "ALL",
    ActiveOnlySelection: "All Statuses",
  };
  const row = {
    JurisdictionName: "STATEWIDE",
    ElectionYear1: "2026",
    OfficeName: "Colorado House",
    DistrictName: "House District 42",
    CandidateName: "EXAMPLE, ADA M",
    Textbox9: "Democratic",
    Textbox13: "EXAMPLE COMMITTEE",
    AcceptedVSL: "No",
    OrganizationStatus: "Terminated",
    ...overrides,
  };
  return {
    electionYear: 2026,
    csv: bytes(
      [
        Object.keys(scope),
        Object.values(scope),
        [""],
        Object.keys(row),
        ...Array.from({ length: count }, () => Object.values(row)),
      ]
        .map((r) => r.map(quote).join(","))
        .join("\r\n") + "\r\n",
    ),
    xml: bytes(
      `<Report Name="rpt_CF_CAND_001" ${attrs(scope)}><table1><Detail_Collection>${Array.from({ length: count }, () => `<Detail ${attrs(row)}/>`).join("")}</Detail_Collection></table1></Report>`,
    ),
  };
}

describe("Colorado native candidate roster population", () => {
  it("retains inactive candidates and native district/party evidence without inventing IDs or dates", () => {
    expect(parseColoradoCandidateListing(listing())).toEqual([
      {
        electionYear: 2026,
        candidateName: "EXAMPLE, ADA M",
        party: "Democratic",
        officeName: "Colorado House",
        districtName: "House District 42",
        receivingName: "EXAMPLE COMMITTEE",
        acceptedVsl: "No",
        status: "Terminated",
      },
    ]);
  });
  it("preserves repeated occurrences rather than deduplicating a control", () => {
    expect(parseColoradoCandidateListing(listing({}, 2))).toHaveLength(2);
  });
  it("accepts genuine empty future-year populations only when both formats agree", () => {
    expect(parseColoradoCandidateListing(listing({}, 0))).toEqual([]);
    const input = listing({}, 0);
    input.xml = bytes(str(listing().xml));
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "csv_xml_occurrence_count",
    );
  });
  it("retains source-blank historical party and statewide district as unknown", () => {
    const input = listing({
      Textbox9: "",
      DistrictName: "",
      OfficeName: "Governor",
    });
    input.xml = bytes(
      str(input.xml).replace('Textbox9=""', "").replace('DistrictName=""', ""),
    );
    expect(parseColoradoCandidateListing(input)[0]).toMatchObject({
      party: "",
      districtName: "",
    });
  });
  it.each(["CandidateName", "Textbox13", "OfficeName", "OrganizationStatus"])(
    "rejects a missing required %s",
    (key) => {
      const input = listing();
      input.xml = bytes(
        str(input.xml).replace(new RegExp(` ${key}="[^"]*"`), ""),
      );
      expect(() => parseColoradoCandidateListing(input)).toThrow(
        "native_candidate_listing_columns",
      );
    },
  );
  it.each([
    "JurisdictionSelection",
    "ElectionYear",
    "OfficeSelection",
    "DistrictSelection",
    "ActiveOnlySelection",
  ])("rejects changed native %s scope", (key) => {
    const input = listing();
    input.xml = bytes(
      str(input.xml).replace(new RegExp(`${key}="[^"]*"`), `${key}="changed"`),
    );
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "native_candidate_listing_scope",
    );
  });
  it.each([
    "House District 42",
    "EXAMPLE, ADA M",
    "EXAMPLE COMMITTEE",
    "Democratic",
    "Terminated",
  ])("rejects a CSV/XML disagreement in %s", (value) => {
    const input = listing();
    input.xml = bytes(str(input.xml).replace(value, "Changed"));
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "csv_xml_occurrences_changed",
    );
  });
  it("requires every native metadata field in CSV, including all-status scope", () => {
    const input = listing();
    input.csv = bytes(
      str(input.csv)
        .replace(',"ActiveOnlySelection"', "")
        .replace(',"All Statuses"', ""),
    );
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "native_candidate_listing_csv_scope",
    );
  });
  it("rejects a different report definition", () => {
    const input = listing();
    input.xml = bytes(
      str(input.xml).replace("rpt_CF_CAND_001", "rpt_CF_COMM_001"),
    );
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "native_candidate_listing_kind",
    );
  });
  it("rejects unowned rows and unknown XML sections", () => {
    const input = listing();
    input.xml = bytes(
      str(input.xml)
        .replace("<Detail_Collection>", "")
        .replace("</Detail_Collection>", ""),
    );
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "unowned_native_candidate_row",
    );
    input.xml = bytes(
      str(listing().xml).replace("</Report>", "<Unknown/></Report>"),
    );
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "native_candidate_listing_structure",
    );
  });
  it("validates suffixes beyond all apparently valid candidate rows", () => {
    const input = listing();
    input.csv = bytes(str(input.csv) + '"bad"suffix\r\n');
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "invalid_source_csv_quote_suffix",
    );
  });
  it("rejects XML entity declarations", () => {
    const input = listing();
    input.xml = bytes(
      '<!DOCTYPE Report [<!ENTITY x "changed">]>' + str(input.xml),
    );
    expect(() => parseColoradoCandidateListing(input)).toThrow(
      "xml_declarations_prohibited",
    );
  });
  it.each([2009, 2101, 2026.5, NaN])(
    "rejects invalid expected year %s",
    (electionYear) => {
      expect(() =>
        parseColoradoCandidateListing({ ...listing(), electionYear }),
      ).toThrow("native_candidate_listing_year");
    },
  );
});
