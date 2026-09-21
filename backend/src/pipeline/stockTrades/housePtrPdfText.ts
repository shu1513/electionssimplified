import type { PtrTextItem } from "./housePtr.js";

/**
 * Positioned text runs of a PTR PDF, text left exactly as pdfjs reports it
 * (the parser reads the NULs pdfjs emits for small-cap label glyphs). An
 * image-only PDF returns an empty list. pdfjs rejects Node Buffers, so pass a
 * plain Uint8Array view.
 */
export async function extractHousePtrTextItems(data: Uint8Array): Promise<PtrTextItem[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data, verbosity: 0 }).promise;
  try {
    const items: PtrTextItem[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if ("str" in item && item.str.trim().length > 0) {
          items.push({ page: pageNumber, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, text: item.str });
        }
      }
    }
    return items;
  } finally {
    await pdf.destroy();
  }
}
