import {readMarylandReportPdfGeometry,type MarylandPdfPage} from "./marylandReportPdfGeometry.js";
import {parseMarylandModernFinancialControls} from "./marylandReportFinancialControls.js";
import {parseMarylandLegacyFinancialControls} from "./marylandLegacyReportFinancialControls.js";

/** Scans the complete original without donor-field or printed-status
 * qualification. Published summary controls corroborate complete API financial
 * families; this does not assert agreement of printed receipt details. */
export async function readMarylandReportSummary(bytes:Uint8Array) {
  try {
    const pages:MarylandPdfPage[]=[];
    const sourceFacts=await readMarylandReportPdfGeometry(bytes,page=>{if(page.pageNumber<=3)pages.push(page);});
    if(pages[0]?.width===612) return {format:"legacy" as const,sourceFacts,
      controls:parseMarylandLegacyFinancialControls({page1:pages[0]!,page2:pages[1]!})};
    return {format:"modern" as const,sourceFacts,controls:parseMarylandModernFinancialControls(pages[2]!)};
  } catch {throw new Error("invalid_maryland_report_summary");}
}
