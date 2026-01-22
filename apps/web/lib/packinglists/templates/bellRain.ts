import type { PackinglistParseResult, PackinglistSection, PackinglistSectionLine, PackinglistTemplate, PdfExtract, PdfLine } from '../types';

const SIZES = ['34', '36', '38', '40', '42', '44', '46'] as const;

function findLineIndex(lines: PdfLine[], predicate: (l: PdfLine) => boolean, start = 0) {
  for (let i = start; i < lines.length; i++) {
    if (predicate(lines[i]!)) return i;
  }
  return -1;
}

function parseDeliveryDate(text: string): string | null {
  const m = text.match(/Delivery date:\s*([^\n]+)/i);
  return m?.[1]?.trim() || null;
}

function nearestKey(x: number, keys: Array<{ key: string; x: number }>, tolerance = 10): string | null {
  let best: { key: string; dx: number } | null = null;
  for (const k of keys) {
    const dx = Math.abs(x - k.x);
    if (!best || dx < best.dx) best = { key: k.key, dx };
  }
  if (!best) return null;
  return best.dx <= tolerance ? best.key : best.key; // always map; tolerance kept for future tuning
}

function parseTableRows(sectionLines: PdfLine[], headerIdx: number): PackinglistSectionLine[] {
  const header = sectionLines[headerIdx]!;
  const sizeXs = SIZES.map((s) => {
    const it = header.items.find((x) => x.str === s);
    return { key: s, x: it?.x ?? NaN };
  }).filter((x) => Number.isFinite(x.x));

  const firstSizeX = sizeXs.length ? Math.min(...sizeXs.map((x) => x.x)) : 10_000;

  const out: PackinglistSectionLine[] = [];
  let currentRow: PackinglistSectionLine | null = null;

  for (let i = headerIdx + 1; i < sectionLines.length; i++) {
    const l = sectionLines[i]!;
    const txt = l.text;
    if (!txt) continue;
    if (/^Our order nr\.:/i.test(txt)) break;
    if (/^Page\s+\d+/i.test(txt)) continue;
    if (/^Total\s+/i.test(txt)) continue;

    // Ignore the "total" table row (typically ends with "Total")
    if (/\bTotal\b$/i.test(txt) || /\bTotal\b/i.test(txt) && /^\s*$/.test(txt.split('Total')[0] || '')) continue;

    // Items before the size columns are descriptive
    const preItems = l.items.filter((x) => x.x < firstSizeX - 2).map((x) => x.str).join(' ').trim();
    const numericItems = l.items
      .filter((x) => x.x >= firstSizeX - 2)
      .map((x) => ({ ...x, n: Number(String(x.str).replace(/[^0-9]/g, '')) }))
      .filter((x) => Number.isFinite(x.n) && x.n > 0);

    // Check if this line has size quantities (numbers in the size columns)
    const hasSizes = numericItems.length > 0;

    // If we have a current row being built and this line looks like a continuation
    // (has preItems but no sizes, and is close in y-position to the previous line)
    if (currentRow && preItems && !hasSizes) {
      const prevLine = sectionLines[i - 1]!;
      const yDiff = Math.abs(l.y - prevLine.y);
      // If within ~10 units vertically (continuation lines are usually close)
      if (yDiff < 10) {
        // Merge this continuation into the current row's articleNumber
        const tokens = preItems.split(/\s+/).filter(Boolean);
        if (tokens.length > 0) {
          const continuation = tokens.join(' ');
          currentRow.articleNumber = currentRow.articleNumber
            ? `${currentRow.articleNumber} ${continuation}`
            : continuation;
        }
        continue; // Skip processing this line as a new row
      }
    }

    // If we had a current row with sizes, finalize it
    if (currentRow) {
      const totalQty = Object.values(currentRow.sizes).reduce((a, b) => a + (Number(b) || 0), 0);
      if (totalQty > 0) {
        out.push(currentRow);
      }
      currentRow = null;
    }

    // Start a new row if we have preItems
    if (!preItems) continue;
    const tokens = preItems.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // Skip the "Total" row that has empty model and "Total" in the left columns
    if (tokens[0]?.toLowerCase() === 'total' || tokens[tokens.length - 1]?.toLowerCase() === 'total') continue;

    const model = tokens[0] || '';
    const modelType = tokens[1] || null;
    const color = tokens.length >= 3 ? (tokens[tokens.length - 1] || null) : null;
    const articleNumber = tokens.length > 3 ? tokens.slice(2, -1).join(' ') : null;

    const sizes: Record<string, number> = Object.fromEntries(SIZES.map((s) => [s, 0]));

    // Map numbers to nearest size header x positions (ignoring the PDF's "Total" column)
    // We do this by x proximity; any number that maps to one of the size columns is used.
    for (const it of numericItems) {
      const key = nearestKey(it.x, sizeXs);
      if (!key) continue;
      sizes[key] = (sizes[key] || 0) + it.n;
    }

    const totalQty = Object.values(sizes).reduce((a, b) => a + (Number(b) || 0), 0);
    if (totalQty === 0 && !hasSizes) {
      // This might be a continuation line that we'll merge on the next iteration
      // Store it as currentRow but don't push yet
      currentRow = { model, modelType, articleNumber, color, sizes, totalQty: 0 };
      continue;
    }

    // If we have sizes, this is a complete row
    if (totalQty > 0) {
      out.push({ model, modelType, articleNumber, color, sizes, totalQty });
      currentRow = null;
    } else {
      // Start building a row that might have continuations
      currentRow = { model, modelType, articleNumber, color, sizes, totalQty: 0 };
    }
  }

  // Finalize any remaining current row
  if (currentRow) {
    const totalQty = Object.values(currentRow.sizes).reduce((a, b) => a + (Number(b) || 0), 0);
    if (totalQty > 0) {
      out.push(currentRow);
    }
  }

  return out;
}

function parseSections(pdf: PdfExtract): PackinglistSection[] {
  const lines = pdf.lines;
  const sections: PackinglistSection[] = [];

  let idx = 0;
  while (idx < lines.length) {
    const start = findLineIndex(lines, (l) => /^Our order nr\.:/i.test(l.text), idx);
    if (start === -1) break;

    const end = findLineIndex(lines, (l) => /^Our order nr\.:/i.test(l.text), start + 1);
    const slice = lines.slice(start, end === -1 ? undefined : end);

    const ourOrder = slice[0]?.text.match(/^Our order nr\.\:\s*(.+)$/i)?.[1]?.trim() || null;
    const yourOrderLine = slice.find((l) => /^Your order nr\.:/i.test(l.text));
    const yourOrder = yourOrderLine?.text.match(/^Your order nr\.\:\s*(.+)$/i)?.[1]?.trim() || null;

    // Find table header line (must include Model and some sizes)
    const headerIdx = findLineIndex(slice, (l) => /\bModel\b/i.test(l.text) && SIZES.some((s) => l.text.includes(s)), 0);
    const tableLines = headerIdx >= 0 ? parseTableRows(slice, headerIdx) : [];

    sections.push({
      bellRainOrderNo: ourOrder,
      bizPoNo: yourOrder,
      lines: tableLines
    });

    idx = end === -1 ? lines.length : end;
  }

  return sections;
}

export const bellRainTemplate: PackinglistTemplate = {
  id: 'bell-rain',
  name: 'Bell Rain',
  canParse: (pdf: PdfExtract) => /BELL RAIN/i.test(pdf.text) || /bellrain\.nl/i.test(pdf.text),
  parse: (pdf: PdfExtract): PackinglistParseResult => {
    const deliveryDate = parseDeliveryDate(pdf.text);
    const sections = parseSections(pdf);
    return {
      templateId: 'bell-rain',
      templateName: 'Bell Rain',
      deliveryDate,
      sections
    };
  }
};


