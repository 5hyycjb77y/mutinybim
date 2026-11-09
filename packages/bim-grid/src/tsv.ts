/**
 * Tab-separated clipboard text, the format spreadsheets exchange. Quoted
 * fields (Excel quotes values containing tabs, newlines or quotes) are honoured
 * on read and produced on write.
 */

/** Parses clipboard text into rows of cells. A single trailing newline is not an extra row. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  let atCellStart = true;
  const src = text.replace(/\r\n?/g, "\n");
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      atCellStart = true;
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
      i++;
      continue;
    }
    cell += ch;
    atCellStart = false;
    i++;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function quote(cell: string): string {
  return /[\t\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(quote).join("\t")).join("\n");
}
