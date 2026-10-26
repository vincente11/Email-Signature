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
  for (const [key, value] of Object.entries({ sheet: "1", objects: "1", scenarios: "1", algorithmName: "SHA-512", saltValue: base64(salt), hashValue: base64(hash), spinCount: String(spinCount) })) protection.setAttribute(key, value);
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
  const anchor = parse(`<xdr:oneCellAnchor xmlns:xdr="${xns}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${rns}"><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${pictureId}" name="Signature ${pictureId}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1" noMove="1" noResize="1" noRot="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${imageId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData fLocksWithSheet="1"/></xdr:oneCellAnchor>`);
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
