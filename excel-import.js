/* Excel imports become reviewable PDF pages before entering the signing flow. */
window.excelToPdf = async function excelToPdf(bytes) {
  if (!window.XLSX) throw new Error("Excel tools are unavailable. Refresh and try again.");
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const workbook = window.XLSX.read(bytes, { type: "array", cellStyles: true });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const text = (value) => Array.from(String(value)).map((char) => {
    try { font.encodeText(char); return char; } catch {
      throw new Error("This workbook contains characters the preview cannot display. Export it to PDF from Excel first.");
    }
  }).join("");
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
      for (let row = range.s.r; row <= range.e.r; row += 28) {
        if (pdf.getPageCount() >= 250) throw new Error("This workbook exceeds 250 preview pages. Export it to PDF from Excel first.");
        const page = pdf.addPage([841.89, 595.28]);
        page.drawText(text(name).slice(0, 90), { x: 30, y: 563, size: 14, font: bold });
        const width = 781.89 / (endCol - col + 1);
        const endRow = Math.min(row + 27, range.e.r);
        for (let r = row; r <= endRow; r++) {
          for (let c = col; c <= endCol; c++) {
            const x = 30 + (c - col) * width, y = 527 - (r - row) * 17;
            page.drawRectangle({ x, y, width, height: 17, borderWidth: 0.4, borderColor: rgb(.8, .83, .8) });
            const cell = sheet[window.XLSX.utils.encode_cell({ r, c })];
            if (!cell) continue;
            if (cell.f && cell.v == null) throw new Error("A formula has no saved result. Recalculate and save the workbook in Excel, then upload it again.");
            let value = text(cell.w ?? (cell.v == null ? "" : window.XLSX.utils.format_cell(cell))).replace(/\s+/g, " ");
            // Refuse a lossy preview rather than silently truncating worksheet values.
            if (font.widthOfTextAtSize(value, 8) > width - 8) {
              throw new Error("Some worksheet text is too wide for the preview. Export the workbook to PDF from Excel to preserve its layout.");
            }
            page.drawText(value, { x: x + 4, y: y + 5, size: 8, font });
          }
        }
        page.drawText(`Rows ${row + 1}-${endRow + 1} | Columns ${window.XLSX.utils.encode_col(col)}-${window.XLSX.utils.encode_col(endCol)} | Page ${pdf.getPageCount()}`, { x: 30, y: 27, size: 9, font });
      }
    }
  }
  if (!pdf.getPageCount()) throw new Error("This workbook has no visible worksheet data.");
  return pdf.save();
};
