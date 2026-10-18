import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OHIO_SOS_PRODUCTS, ohioSosCycleArtifacts, storeOhioSosArtifact } from "../../../src/pipeline/ohioFinance/ohioSosArtifactCache.js";

const money = (c: number) => (c / 100).toFixed(2);
const cover = (master: string, report: string, y: number, description: string, amount: number) => ({
  COM_NAME: master === "100" ? "Synthetic Candidate Committee" : master === "200" ? "Synthetic PAC" : "Synthetic Party Committee",
  MASTER_KEY: master, REPORT_KEY: report, RPT_YEAR: String(y), REPORT_DESCRIPTION: description,
  CANDIDATE_FIRST_NAME: "Synthetic", CANDIDATE_LAST_NAME: "Candidate", PAC_REG_NO: "CP900", DATE_REPORT_FILED: y === 2025 ? "31-DEC-25" : "02-JAN-26",
  AMT_FORWARD: "0", TOTAL_CONTRIBUTIONS: money(amount), TOTAL_OTHER_INCOME: "0", TOTAL_FUNDS: money(amount), TOTAL_EXPENDITURES: "0",
  BALANCE_ON_HAND: money(amount), VALUE_INKIND_RECEIVED: "0", VALUE_INKIND_MADE: "0", OUTSTANDING_LOANS_OWED: "0", OUTSTANDING_DEBT_OWED: "0",
  OUTSTANDING_LOANS_TO: "0", VALUE_IND_EXPENDITURES: "0",
});
export async function makeOhioCommitteeNativeFixture(root: string) {
  const nativeRoot = join(root, "native"), incoming = join(root, "incoming");
  await mkdir(nativeRoot, { mode: 0o700 }); await mkdir(incoming, { mode: 0o700 });
  async function install(amount2026 = 10000, changedOnly = false, receiptAmount?: string) {
    for (const role of ohioSosCycleArtifacts(2026).filter(r => ["candidate_list", "pac_list", "candidate_cover", "pac_cover", "party_cover", "candidate_contributions"].includes(r.productKey))) {
      if (changedOnly && role.productKey !== "candidate_cover" && !(role.productKey === "candidate_contributions" && role.transactionYear === 2026)) continue;
      let rows: Record<string, string>[];
      if (role.productKey === "candidate_list") rows = [{ COM_NAME: "Synthetic Candidate Committee", MASTER_KEY: "100", CANDIDATE_FIRST_NAME: "Synthetic", CANDIDATE_LAST_NAME: "Candidate", OFFICE: "HOUSE", DISTRICT: "1" }];
      else if (role.productKey === "pac_list") rows = [{ COM_NAME: "Synthetic PAC", MASTER_KEY: "200", PAC_REG_NO: "CP900" }];
      else if (role.productKey === "candidate_cover") rows = [cover("100", "300", 2025, "ANNUAL (JANUARY)", 1000), cover("100", "301", 2026, "PRE-PRIMARY", amount2026)];
      else if (role.productKey === "pac_cover") rows = [cover("200", "400", 2026, "PRE-PRIMARY", 0)];
      else if (role.productKey === "party_cover") rows = [cover("201", "401", 2026, "PRE-PRIMARY", 0)];
      else { const y = role.transactionYear!; rows = [{ COM_NAME: "Synthetic Candidate Committee", MASTER_KEY: "100", REPORT_KEY: y === 2025 ? "300" : "301", RPT_YEAR: String(y),
        REPORT_DESCRIPTION: y === 2025 ? "ANNUAL (JANUARY)" : "PRE-PRIMARY", SHORT_DESCRIPTION: "31-A Stmt of Contribution", NON_INDIVIDUAL: "Synthetic PAC", PAC_REG_NO: "CP900",
        AMOUNT: y === 2025 ? "10.00" : receiptAmount ?? money(amount2026), FILE_DATE: y === 2025 ? "12/31/2025" : "01/02/2026", EVENT_DATE: y === 2025 ? "12/30/2025" : "01/01/2026",
        CANDIDATE_FIRST_NAME: "Synthetic", CANDIDATE_LAST_NAME: "Candidate", OFFICE: "HOUSE", DISTRICT: "1" }]; }
      const header = OHIO_SOS_PRODUCTS[role.productKey].family.header, quote = (s: string) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      const csv = header.join(",") + "\r" + rows.map(row => header.map((key, i) => quote(role.productKey === "candidate_list" && i === 20 ? "INDEPENDENT" : row[key] ?? "")).join(",")).join("\r") + "\r";
      const path = join(incoming, role.fileName); await writeFile(path, csv, { mode: 0o600 });
      await storeOhioSosArtifact({ cacheDir: nativeRoot, productKey: role.productKey, transactionYear: role.transactionYear, downloadPath: path,
        retrievedAt: new Date(changedOnly ? "2026-01-04T00:00:00.000Z" : "2026-01-03T00:00:00.000Z") });
    }
  }
  await install(); return { nativeRoot, install };
}
