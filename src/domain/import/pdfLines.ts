/**
 * Turn positioned PDF text fragments (as pdf.js returns them) into text lines
 * that read like `pdftotext -layout`: fragments on the same baseline are
 * joined left to right; a wide horizontal gap becomes at least two spaces, so
 * parsers can split columns on /\s{2,}/.
 */

export interface TextFragment {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageText {
  fragments: TextFragment[];
}

export function fragmentsToLines(pages: readonly PdfPageText[], tolerance = 2.5): string[] {
  const out: string[] = [];
  for (const page of pages) {
    const items = page.fragments.filter((f) => f.str.trim() !== '');
    // PDF y grows upwards: sort top to bottom, then left to right.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: TextFragment[][] = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r[0]!.y - it.y) <= tolerance);
      if (row) row.push(it);
      else rows.push([it]);
    }
    rows.sort((a, b) => b[0]!.y - a[0]!.y);
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let line = '';
      let end = -Infinity;
      for (const f of row) {
        const charWidth = f.str.length ? f.width / f.str.length : 4;
        const gap = f.x - end;
        if (line !== '') {
          if (gap > Math.max(charWidth * 1.5, 6)) line += '   ';
          else if (gap > charWidth * 0.25 && !line.endsWith(' ') && !f.str.startsWith(' ')) line += ' ';
        }
        line += f.str;
        end = f.x + f.width;
      }
      out.push(line.replace(/\s+$/, ''));
    }
  }
  return out;
}
