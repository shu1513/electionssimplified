import type { KansasIEDocumentRow } from "./kansasIndependentExpenditureStore.js";

export type KansasReviewedIEStatement = {
  sourceUrl: string;
  sha256: string;
  electionYear: number;
  payerName: string;
  filingDate: string;
  periodDueKey: string;
  statementTotalCents: number;
  /** Actual companion source documents needed to close this printed control. */
  controlDocumentUrls: readonly string[];
  rows: readonly KansasIEDocumentRow[];
};

const base = "https://sos.ks.gov/srvimages/campaignfinance/filings/cy2026/";
const source = (month: string, id: string) => `${base}cm${month}/${id}.pdf`;
const october = [source("10", "65597"), source("10", "65598")];
function row(
  rowIndex: number,
  rowDate: string,
  houseDistrict: number,
  candidateName: string,
  supportOppose: "support" | "oppose",
  amountCents: number,
  description: string,
): KansasIEDocumentRow {
  return {
    rowIndex,
    rowDate,
    houseDistrict,
    candidateName,
    supportOppose,
    amountCents,
    targetAsFiled: `HD${houseDistrict.toString().padStart(2, "0")} ${candidateName} ${supportOppose.toUpperCase()} / ${description}`,
  };
}
const july = (
  i: number,
  district: number,
  name: string,
  amount: number,
  date = "2026-07-08",
  direction: "support" | "oppose" = "support",
  description = "MEDIA PRODUCTION",
) => row(i, date, district, name, direction, amount, description);
const august = (
  i: number,
  district: number,
  name: string,
  amount: number,
  direction: "support" | "oppose" = "support",
  description = "MEDIA PRODUCTION",
) => row(i, "2026-08-18", district, name, direction, amount, description);
const sms = "SMS MESSAGING / CREATIVE DESIGN SERVICES / PRINTING / POSTAGE";

/**
 * Complete financial-region transcriptions reviewed against all 14 original
 * scanned pages on October 12, 2026. Original SHA values bind the complete PDFs,
 * not OCR output or old migration271 rows. Vendors, contacts, signatures and
 * contributor names are excluded. Names here are literal expenditure targets
 * and the reported payer; they are not legal registry identifiers or aliases.
 * July/August are five-page whole PDFs. The two October paper records contain
 * disjoint rows of the same received/period/payer control, repeated on both
 * pages; both original hashes are required before either document is accepted.
 * These are acquired itemized statements, not a whole-candidate total or zero.
 */
export const KANSAS_REVIEWED_IE_STATEMENTS: readonly KansasReviewedIEStatement[] =
  [
    {
      sourceUrl: source("07", "65289"),
      sha256:
        "f9aa9e04ea80454e64b93b03fb6475d473cc7130764447648c6394dcd090de35",
      electionYear: 2026,
      payerName: "AMERICAN CONSERVATIVE FUND",
      filingDate: "2026-07-27",
      periodDueKey: "202607",
      statementTotalCents: 48607000,
      controlDocumentUrls: [source("07", "65289")],
      rows: [
        july(
          1,
          101,
          "CASEY SLAUGHTER",
          6125900,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(
          2,
          102,
          "KYLER SWEELY",
          4188300,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(
          3,
          120,
          "ADAM SMITH",
          5874100,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(
          4,
          2,
          "KENNETH COLLINS",
          4478700,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(
          5,
          42,
          "LANCE NEELLY",
          6098100,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(
          6,
          54,
          "KENNETH CORBET",
          3866300,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(
          7,
          72,
          "AVERY ANDERSON",
          3681100,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(
          8,
          75,
          "TYLER COATS",
          4394500,
          "2026-07-08",
          "support",
          "MEDIA PLACEMENT",
        ),
        july(9, 101, "CASEY SLAUGHTER", 550000),
        july(10, 120, "ADAM SMITH", 550000),
        july(11, 102, "KYLER SWEELY", 550000),
        july(12, 2, "KENNETH COLLINS", 550000),
        july(13, 42, "LANCE NEELLY", 550000),
        july(14, 54, "KENNETH CORBET", 550000),
        july(15, 72, "AVERY ANDERSON", 550000),
        july(16, 75, "TYLER COATS", 550000),
        july(17, 101, "CASEY SLAUGHTER", 550000, "2026-07-15"),
        july(18, 101, "KEVIN O'BRIEN", 550000, "2026-07-15", "oppose"),
        july(19, 102, "KYLER SWEELY", 550000, "2026-07-15"),
        july(20, 102, "TYSON THRALL", 550000, "2026-07-15", "oppose"),
        july(21, 2, "KENNETH COLLINS", 1100000),
        july(22, 42, "LANCE NEELLY", 550000, "2026-07-15"),
        july(23, 42, "MIKE STIEBEN", 550000, "2026-07-15", "oppose"),
        july(24, 72, "AVERY ANDERSON", 550000, "2026-07-15"),
        july(25, 72, "MICHAEL STAVOLA", 550000, "2026-07-15", "oppose"),
      ],
    },
    {
      sourceUrl: source("08", "65492"),
      sha256:
        "8491276a402c151f56dc59209a5b295f3335ef404c4f0921e0aa47f8cf3f3e92",
      electionYear: 2026,
      payerName: "AMERICAN CONSERVATIVE FUND",
      filingDate: "2026-08-20",
      periodDueKey: "202610",
      statementTotalCents: 30922884,
      controlDocumentUrls: [source("08", "65492")],
      rows: [
        august(1, 2, "KENNETH COLLINS", 3405897, "support", sms),
        august(2, 42, "LANCE NEELLY", 3424394, "support", sms),
        august(3, 120, "ADAM SMITH", 2796778, "support", sms),
        august(4, 101, "CASEY SLAUGHTER", 1373759, "support", sms),
        august(5, 102, "KYLER SWEELY", 1899230, "support", sms),
        august(6, 54, "KENNETH CORBET", 1870139, "support", sms),
        august(7, 72, "AVERY ANDERSON", 1256994, "support", sms),
        august(8, 75, "TYLER COATS", 701550, "support", sms),
        august(
          9,
          101,
          "KEVIN O'BRIEN",
          1861398,
          "oppose",
          "CREATIVE DESIGN SERVICES / PRINTING / POSTAGE",
        ),
        august(10, 102, "TYSON THRALL", 920476, "oppose", sms),
        august(
          11,
          72,
          "MICHAEL STAVOLA",
          1639608,
          "oppose",
          "CREATIVE DESIGN SERVICES / PRINTING / POSTAGE",
        ),
        august(
          12,
          2,
          "KENNETH COLLINS",
          1287525,
          "support",
          "DOOR-TO-DOOR GOTV",
        ),
        august(13, 75, "TYLER COATS", 550000),
        august(
          14,
          72,
          "AVERY ANDERSON",
          997744,
          "support",
          "MEDIA PRODUCTION / PHONE CALLS",
        ),
        august(15, 72, "MICHAEL STAVOLA", 550000, "oppose"),
        august(16, 54, "KENNETH CORBET", 550000),
        august(
          17,
          42,
          "LANCE NEELLY",
          1020624,
          "support",
          "MEDIA PRODUCTION / PHONE CALLS",
        ),
        august(18, 42, "MIKE STIEBEN", 550000, "oppose"),
        august(
          19,
          2,
          "KENNETH COLLINS",
          966768,
          "support",
          "MEDIA PRODUCTION / PHONE CALLS",
        ),
        august(20, 2, "DANIEL MUTER", 550000),
        august(21, 120, "ADAM SMITH", 550000),
        august(22, 102, "KYLER SWEELY", 550000),
        august(23, 102, "TYSON THRALL", 550000, "oppose"),
        august(24, 101, "CASEY SLAUGHTER", 550000),
        august(25, 101, "KEVIN O'BRIEN", 550000, "oppose"),
      ],
    },
    {
      sourceUrl: source("08", "65466"),
      sha256:
        "8247a4b6beb7c6eea8bf5dcc677b8ec808ba0822cee8d78933753f22f7f6ea68",
      electionYear: 2026,
      payerName: "AMERICAN CONSERVATIVE FUND",
      filingDate: "2026-08-14",
      periodDueKey: "202610",
      statementTotalCents: 221169,
      controlDocumentUrls: [source("08", "65466")],
      rows: [
        row(
          1,
          "2026-08-12",
          2,
          "KENNETH COLLINS",
          "support",
          113559,
          "PALM CARDS",
        ),
        row(
          2,
          "2026-08-12",
          42,
          "LANCE NEELLY",
          "support",
          107610,
          "PALM CARDS",
        ),
      ],
    },
    {
      sourceUrl: source("09", "65555"),
      sha256:
        "293b01d9534f09730a8c6873ceb581d33f47587f0fd5937e62503889b2c3016d",
      electionYear: 2026,
      payerName: "AMERICAN CONSERVATIVE FUND",
      filingDate: "2026-09-17",
      periodDueKey: "202610",
      statementTotalCents: 109855,
      controlDocumentUrls: [source("09", "65555")],
      rows: [
        row(
          1,
          "2026-09-15",
          102,
          "KYLER SWEELY",
          "support",
          109855,
          "PALM CARDS",
        ),
      ],
    },
    {
      sourceUrl: source("10", "65597"),
      sha256:
        "ad8f9686aa72e16585e410af63018bd2c4dc2fef12888d77811d8360b6ca1164",
      electionYear: 2026,
      payerName: "AMERICAN CONSERVATIVE FUND",
      filingDate: "2026-10-08",
      periodDueKey: "202610",
      statementTotalCents: 348898,
      controlDocumentUrls: october,
      rows: [
        row(
          1,
          "2026-10-07",
          101,
          "CASEY SLAUGHTER",
          "support",
          58883,
          "SMS MESSAGING",
        ),
        row(
          2,
          "2026-10-07",
          102,
          "KYLER SWEELY",
          "support",
          20955,
          "SMS MESSAGING",
        ),
        row(
          3,
          "2026-10-07",
          120,
          "ADAM SMITH",
          "support",
          52690,
          "SMS MESSAGING",
        ),
        row(
          4,
          "2026-10-07",
          2,
          "KENNETH COLLINS",
          "support",
          35200,
          "SMS MESSAGING",
        ),
        row(
          5,
          "2026-10-07",
          42,
          "LANCE NEELLY",
          "support",
          44473,
          "SMS MESSAGING",
        ),
      ],
    },
    {
      sourceUrl: source("10", "65598"),
      sha256:
        "dee5d122c4f4e721b57e9907acbc0e69bbfa812b3d932748d1c63789bcd4e2b6",
      electionYear: 2026,
      payerName: "AMERICAN CONSERVATIVE FUND",
      filingDate: "2026-10-08",
      periodDueKey: "202610",
      statementTotalCents: 348898,
      controlDocumentUrls: october,
      rows: [
        row(
          1,
          "2026-10-07",
          54,
          "KENNETH CORBET",
          "support",
          44792,
          "SMS MESSAGING",
        ),
        row(
          2,
          "2026-10-07",
          72,
          "AVERY ANDERSON",
          "support",
          44792,
          "SMS MESSAGING",
        ),
        row(
          3,
          "2026-10-07",
          75,
          "TYLER COATS",
          "support",
          47113,
          "SMS MESSAGING",
        ),
      ],
    },
  ];
