import type { PdfExtract, PdfLine, PdfTextItem } from './types';

// pdfjs-dist has imperfect TS types in some bundlers; keep usage loosely typed.
type PdfJs = any;

function normalizeText(s: string) {
  return s.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function buildLines(items: PdfTextItem[]): PdfLine[] {
  // Cluster by Y (rounded) to create stable lines. PDF Y coords are float; tolerance ~2 works well.
  const buckets = new Map<number, PdfTextItem[]>();
  for (const it of items) {
    const key = Math.round(it.y / 2) * 2;
    const arr = buckets.get(key) ?? [];
    arr.push(it);
    buckets.set(key, arr);
  }
  const lines: PdfLine[] = [];
  for (const [yKey, arr] of buckets.entries()) {
    const sorted = arr.sort((a, b) => a.x - b.x);
    const text = sorted.map((x) => x.str).join(' ').replace(/[ \t]+/g, ' ').trim();
    if (!text) continue;
    lines.push({ page: sorted[0]!.page, y: yKey, text, items: sorted });
  }
  // Sort top-to-bottom within page, then page order
  lines.sort((a, b) => (a.page - b.page) || (b.y - a.y));
  return lines;
}

export async function extractPdf(file: File): Promise<PdfExtract> {
  const arrayBuffer = await file.arrayBuffer();

  // Dynamic import to keep pdfjs out of the main bundle until needed
  // Prefer the ESM `.mjs` entrypoints (these exist in pdfjs-dist v5), and disable workers entirely
  // (packing slips are small). This avoids bundling the worker and avoids runtime "module not found"
  // issues from importing non-existent subpaths.
  let pdfjs: PdfJs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  }

  const doc = await pdfjs.getDocument({ data: arrayBuffer, disableWorker: true }).promise;
  const allItems: PdfTextItem[] = [];
  let allText = '';

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageItems = (content.items ?? []) as any[];
    for (const raw of pageItems) {
      const str = String(raw.str ?? '').trim();
      if (!str) continue;
      const t = raw.transform as number[] | undefined;
      const x = t?.[4] ?? 0;
      const y = t?.[5] ?? 0;
      allItems.push({ str, x, y, page: i });
      allText += str + ' ';
    }
    allText += '\n';
  }

  const lines = buildLines(allItems);
  return { text: normalizeText(allText), lines };
}


