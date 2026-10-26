/* Map the full preview page, including blank space, to worksheet coordinates. */
window.excelSignatureAnchor = function (meta, placement) {
  if (!meta?.rows?.length) throw new Error("Reopen this workbook before signing.");
  const x = placement.leftRatio * 841.89, y = placement.topRatio * 595.28;
  let previewRow = meta.rows.find((row) => y >= row.top && y < row.top + row.height);
  if (!previewRow) {
    const first = meta.rows[0], last = meta.rows[meta.rows.length - 1];
    if (y < first.top) previewRow = first;
    else {
      // Blank space below the table represents the following empty Excel rows.
      const end = last.top + last.height;
      const extra = Math.max(0, Math.floor((y - end) / 18));
      previewRow = { row: Math.min(1048575, last.row + 1 + extra), top: end + extra * 18, height: 18, offset: 0, lineCount: 1 };
    }
  }
  const localX = Math.min(781.89 - .001, Math.max(0, x - 30));
  const col = Math.min(meta.endCol, meta.col + Math.floor(localX / meta.width));
  const colPixels = meta.sheet["!cols"]?.[col]?.wpx || 64;
  const rowPixels = meta.sheet["!rows"]?.[previewRow.row]?.hpx || (meta.sheet["!rows"]?.[previewRow.row]?.hpt || 15) * 4 / 3;
  const emu = (px) => Math.max(0, Math.round(px * 9525));
  const colOff = emu((localX % meta.width) / meta.width * colPixels);
  const rowFraction = Math.min(.999, Math.max(0, (previewRow.offset + (y - previewRow.top) / 10) / previewRow.lineCount));
  const rowOff = emu(rowFraction * rowPixels);
  const cx = emu(placement.widthRatio * 841.89 / meta.width * colPixels);
  const cy = Math.max(1, Math.round(cx * placement.heightRatio * 595.28 / (placement.widthRatio * 841.89)));
  return { col, row: previewRow.row, colOff, rowOff, cx, cy };
};

/* Modify only drawing-related ZIP parts; retain original workbook data and formatting. */
window.signExcelWorkbook = async function (bytes, pages, placement, signature) {
  if (!window.JSZip) throw new Error("Excel export tools are unavailable. Refresh and try again.");
  const meta = pages[placement.pageNumber - 1];
  const { col, row, colOff, rowOff, cx, cy } = window.excelSignatureAnchor(meta, placement);
  // Absolute placement keeps the image fixed when users insert or resize rows/columns.
  let absoluteX = colOff, absoluteY = rowOff;
  for (let c = 0; c < col; c++) absoluteX += Math.round((meta.sheet["!cols"]?.[c]?.wpx || 64) * 9525);
  for (let r = 0; r < row; r++) absoluteY += Math.round((meta.sheet["!rows"]?.[r]?.hpx || (meta.sheet["!rows"]?.[r]?.hpt || 15) * 4 / 3) * 9525);
  const zip = await window.JSZip.loadAsync(bytes);
  const ns = "http://schemas.openxmlformats.org/package/2006/relationships";
  const rns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const sns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const xns = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
  const parser = new DOMParser(), serializer = new XMLSerializer();
  const parse = (source) => {
    const doc = parser.parseFromString(source, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("The workbook contains invalid XML.");
    return doc;
  };
  const read = async (path, fallback) => parse(zip.file(path) ? await zip.file(path).async("string") : fallback);
  const write = (path, doc) => zip.file(path, serializer.serializeToString(doc));
  const elements = (doc, local) => Array.from(doc.getElementsByTagNameNS("*", local));
  const resolve = (base, target) => {
    const parts = (target.startsWith("/") ? target.slice(1) : base.slice(0, base.lastIndexOf("/") + 1) + target).split("/");
    const result = [];
    for (const part of parts) { if (part === "..") result.pop(); else if (part && part !== ".") result.push(part); }
    return result.join("/");
  };
  const relPath = (path) => path.slice(0, path.lastIndexOf("/") + 1) + "_rels/" + path.slice(path.lastIndexOf("/") + 1) + ".rels";
  const blankRels = `<Relationships xmlns="${ns}"/>`;
  const addRel = (doc, type, target) => {
    let n = 1;
    while (elements(doc, "Relationship").some((el) => el.getAttribute("Id") === `rId${n}`)) n++;
    const el = doc.createElementNS(ns, "Relationship");
    el.setAttribute("Id", `rId${n}`); el.setAttribute("Type", rns + "/" + type); el.setAttribute("Target", target);
    doc.documentElement.appendChild(el);
    return `rId${n}`;
  };
  const workbook = await read("xl/workbook.xml");
  const sheetId = elements(workbook, "sheet")[meta.sheetIndex].getAttributeNS(rns, "id");
  const workbookRels = await read("xl/_rels/workbook.xml.rels");
  const sheetRel = elements(workbookRels, "Relationship").find((el) => el.getAttribute("Id") === sheetId);
  const sheetPath = resolve("xl/workbook.xml", sheetRel.getAttribute("Target"));
  const sheet = await read(sheetPath);
  // Unlock cells on this worksheet without changing styles on other sheets.
  const styles = await read("xl/styles.xml");
  const cellXfs = elements(styles, "cellXfs")[0];
  const originalFormats = Array.from(cellXfs.childNodes).filter((el) => el.localName === "xf");
  const unlockedFormats = new Map();
  const unlockStyle = (index = "0") => {
    index = String(index);
    if (unlockedFormats.has(index)) return unlockedFormats.get(index);
    const xf = (originalFormats[Number(index)] || originalFormats[0]).cloneNode(true);
    let cellProtection = elements(xf, "protection")[0];
    if (!cellProtection) {
      cellProtection = styles.createElementNS(sns, "protection");
      const extension = elements(xf, "extLst")[0];
      xf.insertBefore(cellProtection, extension || null);
    }
    cellProtection.setAttribute("locked", "0");
    xf.setAttribute("applyProtection", "1");
    const result = String(Array.from(cellXfs.childNodes).filter((el) => el.localName === "xf").length);
    cellXfs.appendChild(xf); unlockedFormats.set(index, result);
    return result;
  };
  let columns = elements(sheet, "cols")[0];
  if (!columns) {
    columns = sheet.createElementNS(sns, "cols");
    sheet.documentElement.insertBefore(columns, elements(sheet, "sheetData")[0]);
  }
  const originalColumns = elements(columns, "col").map((el) => ({ min: Number(el.getAttribute("min")), max: Number(el.getAttribute("max")), style: el.getAttribute("style") || "0", el }));
  for (const rowElement of elements(sheet, "row")) {
    const rowStyle = rowElement.getAttribute("s");
    for (const cell of elements(rowElement, "c")) {
      const letters = (cell.getAttribute("r") || "A1").match(/^[A-Z]+/)[0];
      let column = 0;
      for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
      const inherited = originalColumns.find((entry) => column >= entry.min && column <= entry.max)?.style || "0";
      cell.setAttribute("s", unlockStyle(cell.getAttribute("s") || rowStyle || inherited));
    }
    if (rowStyle) rowElement.setAttribute("s", unlockStyle(rowStyle));
  }
  // Default column styles also unlock previously empty cells and new rows.
  let nextColumn = 1;
  for (const entry of originalColumns.sort((a, b) => a.min - b.min)) {
    if (nextColumn < entry.min) {
      const gap = sheet.createElementNS(sns, "col");
      gap.setAttribute("min", String(nextColumn)); gap.setAttribute("max", String(entry.min - 1)); gap.setAttribute("style", unlockStyle());
      columns.insertBefore(gap, entry.el);
    }
    entry.el.setAttribute("style", unlockStyle(entry.style));
    nextColumn = Math.max(nextColumn, entry.max + 1);
  }
  if (nextColumn <= 16384) {
    const remaining = sheet.createElementNS(sns, "col");
    remaining.setAttribute("min", String(nextColumn)); remaining.setAttribute("max", "16384"); remaining.setAttribute("style", unlockStyle());
    columns.appendChild(remaining);
  }
  cellXfs.setAttribute("count", String(Array.from(cellXfs.childNodes).filter((el) => el.localName === "xf").length));
  write("xl/styles.xml", styles);
  // Use a fresh, undisclosed password for each signed download. Store only its verifier.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const password = crypto.randomUUID() + crypto.randomUUID();
  const encoded = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    encoded[i * 2] = password.charCodeAt(i) & 255;
    encoded[i * 2 + 1] = password.charCodeAt(i) >>> 8;
  }
  const initial = new Uint8Array(salt.length + encoded.length);
  initial.set(salt); initial.set(encoded, salt.length);
  let hash = new Uint8Array(await crypto.subtle.digest("SHA-512", initial));
  const spinCount = 10000;
  for (let i = 0; i < spinCount; i++) {
    const input = new Uint8Array(hash.length + 4);
    input.set(hash);
    new DataView(input.buffer).setUint32(hash.length, i, true);
    hash = new Uint8Array(await crypto.subtle.digest("SHA-512", input));
  }
  const base64 = (data) => btoa(String.fromCharCode(...data));
  let protection = elements(sheet, "sheetProtection")[0];
  if (!protection) {
    protection = sheet.createElementNS(sns, "sheetProtection");
    const afterData = elements(sheet, "sheetData")[0];
    const calculation = elements(sheet, "sheetCalcPr")[0];
    sheet.documentElement.insertBefore(protection, (calculation || afterData).nextSibling);
  }
  protection.removeAttribute("password");
  for (const [key, value] of Object.entries({ sheet: "1", objects: "1", scenarios: "1", formatCells: "0", formatColumns: "0", formatRows: "0", insertColumns: "0", insertRows: "0", insertHyperlinks: "0", deleteColumns: "0", deleteRows: "0", sort: "0", autoFilter: "0", selectLockedCells: "0", selectUnlockedCells: "0", algorithmName: "SHA-512", saltValue: base64(salt), hashValue: base64(hash), spinCount: String(spinCount) })) protection.setAttribute(key, value);
  let workbookProtection = elements(workbook, "workbookProtection")[0];
  if (!workbookProtection) {
    workbookProtection = workbook.createElementNS(sns, "workbookProtection");
    const before = Array.from(workbook.documentElement.childNodes).find((el) => !["fileVersion", "fileSharing", "workbookPr"].includes(el.localName) && el.nodeType === 1);
    workbook.documentElement.insertBefore(workbookProtection, before || null);
  }
  workbookProtection.removeAttribute("workbookPassword");
  for (const [key, value] of Object.entries({ lockStructure: "1", workbookAlgorithmName: "SHA-512", workbookSaltValue: base64(salt), workbookHashValue: base64(hash), workbookSpinCount: String(spinCount) })) workbookProtection.setAttribute(key, value);
  write("xl/workbook.xml", workbook);
  write(sheetPath, sheet);
  const sheetRelsPath = relPath(sheetPath);
  const sheetRels = await read(sheetRelsPath, blankRels);
  let drawing = elements(sheet, "drawing")[0];
  let drawingPath;
  const token = crypto.randomUUID().replace(/-/g, "");
  if (drawing) {
    const id = drawing.getAttributeNS(rns, "id");
    const rel = elements(sheetRels, "Relationship").find((el) => el.getAttribute("Id") === id);
    drawingPath = resolve(sheetPath, rel.getAttribute("Target"));
  } else {
    drawingPath = `xl/drawings/signature-${token}.xml`;
    const id = addRel(sheetRels, "drawing", "/" + drawingPath);
    drawing = sheet.createElementNS(sns, "drawing");
    drawing.setAttributeNS(rns, "r:id", id);
    const following = Array.from(sheet.documentElement.childNodes).find((el) => ["legacyDrawing", "legacyDrawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"].includes(el.localName));
    sheet.documentElement.insertBefore(drawing, following || null);
    write(sheetPath, sheet); write(sheetRelsPath, sheetRels);
  }
  const drawingDoc = await read(drawingPath, `<xdr:wsDr xmlns:xdr="${xns}"/>`);
  const drawingRelsPath = relPath(drawingPath);
  const drawingRels = await read(drawingRelsPath, blankRels);
  const imagePath = `xl/media/signature-${token}.png`;
  zip.file(imagePath, signature.split(",")[1], { base64: true });
  const imageId = addRel(drawingRels, "image", "/" + imagePath);
  const pictureId = Math.max(0, ...elements(drawingDoc, "cNvPr").map((el) => Number(el.getAttribute("id")) || 0)) + 1;
  const anchor = parse(`<xdr:absoluteAnchor xmlns:xdr="${xns}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${rns}"><xdr:pos x="${absoluteX}" y="${absoluteY}"/><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${pictureId}" name="Signature ${pictureId}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1" noMove="1" noResize="1" noRot="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${imageId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData fLocksWithSheet="1"/></xdr:absoluteAnchor>`);
  drawingDoc.documentElement.appendChild(drawingDoc.importNode(anchor.documentElement, true));
  write(drawingPath, drawingDoc); write(drawingRelsPath, drawingRels);
  const types = await read("[Content_Types].xml");
  const tns = types.documentElement.namespaceURI;
  if (!elements(types, "Default").some((el) => el.getAttribute("Extension").toLowerCase() === "png")) {
    const el = types.createElementNS(tns, "Default"); el.setAttribute("Extension", "png"); el.setAttribute("ContentType", "image/png"); types.documentElement.appendChild(el);
  }
  if (!elements(types, "Override").some((el) => el.getAttribute("PartName") === "/" + drawingPath)) {
    const el = types.createElementNS(tns, "Override"); el.setAttribute("PartName", "/" + drawingPath); el.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.drawing+xml"); types.documentElement.appendChild(el);
  }
  write("[Content_Types].xml", types);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
};
