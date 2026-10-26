/* Excel imports become reviewable PDF pages before entering the signing flow. */
window.excelToPdf = async function excelToPdf(bytes) {
  if (!window.XLSX) throw new Error("Excel tools are unavailable. Refresh and try again.");
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const workbook = window.XLSX.read(bytes, { type: "array", cellStyles: true });
  const pdf = await PDFDocument.create();
  const previewPages = [];
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const text = (value) => Array.from(String(value)).map((char) => {
    if (/\s/.test(char)) return char === "\r" || char === "\n" ? char : " ";
    try { font.encodeText(char); return char; } catch {
      throw new Error("This workbook contains characters the preview cannot display. Export it to PDF from Excel first.");
    }
  }).join("");
  const wrap = (value, width) => {
    const lines = [];
    for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        if (line && font.widthOfTextAtSize(line + " " + word, 8) > width) {
          lines.push(line);
          line = "";
        }
        for (const char of (line ? " " : "") + word) {
          if (line && font.widthOfTextAtSize(line + char, 8) > width) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
      }
      lines.push(line);
    }
    return lines;
  };
  let cellCount = 0;
  for (const [sheetIndex, name] of workbook.SheetNames.entries()) {
    if (workbook.Workbook?.Sheets?.[sheetIndex]?.Hidden) continue;
    const sheet = workbook.Sheets[name];
    if (!sheet["!ref"]) continue;
    const range = window.XLSX.utils.decode_range(sheet["!ref"]);
    const rows = range.e.r - range.s.r + 1;
    const cols = range.e.c - range.s.c + 1;
    cellCount += rows * cols;
    if (cellCount > 100000) throw new Error("This workbook is too large to preview (maximum 100,000 cells). Export it to PDF from Excel first.");
    // Split wide sheets across pages so values remain readable instead of shrinking to fit.
    for (let col = range.s.c; col <= range.e.c; col += 7) {
      const endCol = Math.min(col + 6, range.e.c);
      const width = 781.89 / (endCol - col + 1);
      let page, top, firstRow, lastRow;
      const footer = () => {
        if (!page) return;
        page.drawText(`Rows ${firstRow + 1}-${lastRow + 1} | Columns ${window.XLSX.utils.encode_col(col)}-${window.XLSX.utils.encode_col(endCol)} | Page ${pdf.getPageCount()}`, { x: 30, y: 27, size: 9, font });
      };
      const newPage = (row) => {
        footer();
        if (pdf.getPageCount() >= 250) throw new Error("This workbook exceeds 250 preview pages. Export it to PDF from Excel first.");
        page = pdf.addPage([841.89, 595.28]);
        previewPages.push({ sheetIndex, col, endCol, width, rows: [], sheet });
        page.drawText(text(name).slice(0, 90), { x: 30, y: 563, size: 14, font: bold });
        top = 544;
        firstRow = lastRow = row;
      };
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells = [];
        for (let c = col; c <= endCol; c++) {
          const cell = sheet[window.XLSX.utils.encode_cell({ r, c })];
          if (cell?.f && cell.v == null) throw new Error("A formula has no saved result. Recalculate and save the workbook in Excel, then upload it again.");
          cells.push(wrap(text(cell ? cell.w ?? (cell.v == null ? "" : window.XLSX.utils.format_cell(cell)) : ""), width - 8));
        }
        const lineCount = Math.max(...cells.map((lines) => lines.length));
        // Keep ordinary rows together; split exceptionally tall rows across pages.
        if (!page || (top - Math.max(17, lineCount * 10 + 8) < 44 && top < 544)) newPage(r);
        for (let offset = 0; offset < lineCount;) {
          const capacity = Math.floor((top - 44 - 8) / 10);
          if (capacity < 1) { newPage(r); continue; }
          const count = Math.min(capacity, lineCount - offset);
          const height = Math.max(17, count * 10 + 8);
          previewPages[previewPages.length - 1].rows.push({ row: r, top: 595.28 - top, height, offset, lineCount });
          cells.forEach((lines, index) => {
            const x = 30 + index * width;
            page.drawRectangle({ x, y: top - height, width, height, borderWidth: 0.4, borderColor: rgb(.8, .83, .8) });
            lines.slice(offset, offset + count).forEach((line, i) => {
              page.drawText(line, { x: x + 4, y: top - 12 - i * 10, size: 8, font });
            });
          });
          lastRow = r;
          top -= height;
          offset += count;
          if (offset < lineCount) newPage(r);
        }
      }
      footer();
    }
  }
  if (!pdf.getPageCount()) throw new Error("This workbook has no visible worksheet data.");
  return { bytes: await pdf.save(), pages: previewPages };
};
