/* Local PDF form fields and positioned text. No PDF actions/scripts are executed. */
window.PdfFillEditor = class PdfFillEditor {
  constructor({ pageWrap, sidebar, onChange, onModeChange, showToast }) {
    this.pageWrap = pageWrap;
    this.sidebar = sidebar;
    this.onChange = onChange;
    this.onModeChange = onModeChange;
    this.showToast = showToast;
    this.layer = document.createElement("div");
    this.layer.className = "pdf-fill-layer";
    this.layer.setAttribute("aria-label", "PDF form fields and added text");
    pageWrap.insertBefore(this.layer, document.getElementById("signatureStamp"));
    this.layer.addEventListener("click", (event) => {
      if (this.mode !== "fill" || event.target !== this.layer) return;
      const rect = this.layer.getBoundingClientRect();
      this.addText(event.clientX - rect.left, event.clientY - rect.top);
    });
    document.getElementById("pdfFillMode").addEventListener("click", () => this.setMode("fill"));
    document.getElementById("pdfSignMode").addEventListener("click", () => this.setMode("sign"));
    document.getElementById("fillFontSize").addEventListener("change", (event) => {
      this.fontSize = Number(event.target.value);
      const selected = this.texts.find((item) => item.id === this.selectedText);
      if (selected) { selected.fontSize = this.fontSize; this.redraw(); this.changed(); }
    });
    this.reset();
  }
  reset() {
    this.epoch = (this.epoch || 0) + 1;
    this.current = null;
    this.values = new Map();
    this.changes = new Map();
    this.texts = [];
    this.selectedText = null;
    this.fontSize = 12;
    this.available = false;
    this.dirty = false;
    this.disconnectObservers();
    this.layer.replaceChildren();
    document.getElementById("pdfEditModes").hidden = true;
    document.getElementById("fillFontSize").value = "12";
    this.setMode("sign");
  }
  disconnectObservers() {
    for (const observer of this.observers || []) observer.disconnect();
    this.observers = [];
  }
  async initialise(viewer, available) {
    this.reset();
    this.available = available;
    document.getElementById("pdfEditModes").hidden = !available;
    if (!available) return;
    const epoch = this.epoch;
    const fields = await viewer.getFieldObjects().catch(() => null);
    if (epoch !== this.epoch) return;
    const hasFields = Object.values(fields || {}).some((widgets) => widgets.some((field) => !field.readOnly && ["text", "checkbox", "radiobutton", "combobox", "listbox"].includes(field.type)));
    this.setMode(hasFields ? "fill" : "sign");
  }
  setMode(mode) {
    this.mode = mode === "fill" && this.available ? "fill" : "sign";
    const filling = this.mode === "fill";
    this.layer.dataset.mode = this.mode;
    this.layer.inert = !filling;
    this.sidebar.classList.toggle("pdf-filling", filling);
    this.pageWrap.classList.toggle("pdf-filling", filling);
    document.getElementById("pdfFillPanel").hidden = !filling;
    document.getElementById("pdfFillMode").setAttribute("aria-pressed", String(filling));
    document.getElementById("pdfSignMode").setAttribute("aria-pressed", String(!filling));
    this.onModeChange?.(this.mode);
  }
  changed() { this.dirty = true; this.onChange?.(); }
  async render(page, viewport) {
    const epoch = this.epoch;
    const renderId = this.renderId = (this.renderId || 0) + 1;
    const annotations = this.available ? await page.getAnnotations({ intent: "display" }) : [];
    if (epoch !== this.epoch || renderId !== this.renderId) return;
    this.current = { page, viewport, annotations };
    this.redraw();
  }
  redraw() {
    this.disconnectObservers();
    this.layer.replaceChildren();
    if (!this.current || !this.available) return;
    const { annotations, viewport, page } = this.current;
    for (const annotation of annotations) {
      if (annotation.subtype !== "Widget" || !annotation.fieldName || annotation.readOnly || annotation.hidden) continue;
      const control = this.createField(annotation);
      if (!control) continue;
      const rect = viewport.convertToViewportRectangle(annotation.rect);
      Object.assign(control.style, {
        left: `${Math.min(rect[0], rect[2])}px`, top: `${Math.min(rect[1], rect[3])}px`,
        width: `${Math.abs(rect[2] - rect[0])}px`, height: `${Math.abs(rect[3] - rect[1])}px`,
        fontSize: `${this.fieldFontSize(annotation) * viewport.scale}px`,
      });
      this.layer.append(control);
    }
    for (const text of this.texts.filter((item) => item.pageNumber === page.pageNumber)) this.renderText(text);
  }
  fieldFontSize(annotation) {
    const size = annotation.defaultAppearanceData?.fontSize || 12;
    return size > 18 ? 12 : Math.max(8, size);
  }
  createField(annotation) {
    const name = annotation.fieldName;
    const currentValue = this.values.has(name) ? this.values.get(name) : annotation.fieldValue;
    let control, kind;
    if (annotation.fieldType === "Tx") {
      kind = "text";
      control = document.createElement(annotation.multiLine ? "textarea" : "input");
      if (!annotation.multiLine) control.type = annotation.password ? "password" : "text";
      if (annotation.maxLen > 0) control.maxLength = annotation.maxLen;
      control.value = currentValue || "";
    } else if (annotation.fieldType === "Ch") {
      kind = annotation.combo ? "dropdown" : "list";
      control = document.createElement("select");
      control.multiple = Boolean(annotation.multiSelect);
      const selected = Array.isArray(currentValue) ? currentValue : [currentValue];
      if (!control.multiple) { const blank = document.createElement("option"); blank.value = ""; blank.textContent = ""; control.append(blank); }
      for (const choice of annotation.options || []) {
        const option = document.createElement("option");
        option.value = choice.exportValue; option.textContent = choice.displayValue;
        option.selected = selected.includes(choice.exportValue);
        control.append(option);
      }
    } else if (annotation.fieldType === "Btn" && (annotation.checkBox || annotation.radioButton)) {
      kind = annotation.radioButton ? "radio" : "checkbox";
      control = document.createElement("input"); control.type = kind;
      // A distinct HTML radio group per PDF page avoids collisions with unrelated UI.
      control.name = `pdf-${name}`;
      control.value = annotation.buttonValue || annotation.exportValue || "Yes";
      control.checked = typeof currentValue === "boolean" ? currentValue : currentValue === control.value;
    } else return null;
    control.className = "pdf-fill-field";
    control.dataset.fieldName = name;
    control.setAttribute("aria-label", annotation.alternativeText || name);
    control.title = annotation.alternativeText || name;
    control.autocomplete = "off";
    const update = () => {
      const value = kind === "checkbox" ? control.checked : kind === "radio" ? control.value : control.tagName === "SELECT" ? Array.from(control.selectedOptions).map((option) => option.value).filter(Boolean) : control.value;
      this.values.set(name, value); this.changes.set(name, { kind, value, fontSize: this.fieldFontSize(annotation), options: annotation.options || [] });
      for (const other of this.layer.querySelectorAll("[data-field-name]")) {
        if (other === control || other.dataset.fieldName !== name) continue;
        if (kind === "checkbox") other.checked = value;
        else if (kind === "radio") other.checked = other.value === value;
        else if (other.tagName === "SELECT") for (const option of other.options) option.selected = value.includes(option.value);
        else other.value = value;
      }
      this.changed();
    };
    control.addEventListener(kind === "text" ? "input" : "change", update);
    return control;
  }
  addText(x, y) {
    if (!this.current) return;
    const { viewport, page } = this.current;
    const width = Math.min(220 * viewport.scale, viewport.width * .65);
    const height = Math.min(50 * viewport.scale, viewport.height * .2);
    const text = {
      id: crypto.randomUUID(), pageNumber: page.pageNumber, text: "", fontSize: this.fontSize,
      left: Math.max(0, Math.min(x, viewport.width - width)) / viewport.width,
      top: Math.max(0, Math.min(y, viewport.height - height)) / viewport.height,
      width: width / viewport.width, height: height / viewport.height,
    };
    this.texts.push(text); this.selectedText = text.id;
    this.redraw(); this.changed();
    this.layer.querySelector(`[data-text-id="${text.id}"] textarea`)?.focus();
  }
  renderText(text) {
    const { viewport } = this.current;
    const box = document.createElement("div"); box.className = "pdf-free-text"; box.dataset.textId = text.id;
    Object.assign(box.style, { left: `${text.left * viewport.width}px`, top: `${text.top * viewport.height}px`, width: `${text.width * viewport.width}px`, height: `${text.height * viewport.height}px` });
    const input = document.createElement("textarea"); input.value = text.text; input.placeholder = "Type here"; input.setAttribute("aria-label", "Added text");
    input.style.fontSize = `${text.fontSize * viewport.scale}px`;
    input.addEventListener("input", () => { text.text = input.value; this.changed(); });
    input.addEventListener("focus", () => { this.selectedText = text.id; document.getElementById("fillFontSize").value = String(text.fontSize); });
    const drag = document.createElement("button"); drag.type = "button"; drag.className = "pdf-text-drag"; drag.textContent = "Move"; drag.setAttribute("aria-label", "Move added text; use arrow keys to adjust");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "pdf-text-remove"; remove.textContent = "×"; remove.setAttribute("aria-label", "Remove added text");
    remove.addEventListener("click", () => { this.texts = this.texts.filter((item) => item.id !== text.id); this.redraw(); this.changed(); });
    let start;
    const position = (left, top) => {
      text.left = Math.max(0, Math.min(left, 1 - text.width)); text.top = Math.max(0, Math.min(top, 1 - text.height));
      box.style.left = `${text.left * viewport.width}px`; box.style.top = `${text.top * viewport.height}px`; this.changed();
    };
    drag.addEventListener("pointerdown", (event) => { start = { x: event.clientX, y: event.clientY, left: text.left, top: text.top }; drag.setPointerCapture(event.pointerId); });
    drag.addEventListener("pointermove", (event) => { if (start) position(start.left + (event.clientX - start.x) / viewport.width, start.top + (event.clientY - start.y) / viewport.height); });
    drag.addEventListener("pointerup", () => { start = null; });
    drag.addEventListener("pointercancel", () => { start = null; });
    drag.addEventListener("keydown", (event) => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!moves[event.key]) return;
      event.preventDefault(); const [dx, dy] = moves[event.key], step = event.shiftKey ? 10 : 2;
      position(text.left + dx * step / viewport.width, text.top + dy * step / viewport.height);
    });
    const resize = document.createElement("button"); resize.type = "button"; resize.className = "pdf-text-resize"; resize.setAttribute("aria-label", "Resize added text; use arrow keys to adjust");
    let resizing;
    const setSize = (width, height) => {
      text.width = Math.max(25 / viewport.width, Math.min(width, 1 - text.left));
      text.height = Math.max(20 / viewport.height, Math.min(height, 1 - text.top));
      box.style.width = `${text.width * viewport.width}px`; box.style.height = `${text.height * viewport.height}px`; this.changed();
    };
    resize.addEventListener("pointerdown", (event) => { resizing = { x: event.clientX, y: event.clientY, width: text.width, height: text.height }; resize.setPointerCapture(event.pointerId); });
    resize.addEventListener("pointermove", (event) => { if (resizing) setSize(resizing.width + (event.clientX - resizing.x) / viewport.width, resizing.height + (event.clientY - resizing.y) / viewport.height); });
    resize.addEventListener("pointerup", () => { resizing = null; });
    resize.addEventListener("pointercancel", () => { resizing = null; });
    resize.addEventListener("keydown", (event) => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!moves[event.key]) return; event.preventDefault();
      const [dx, dy] = moves[event.key], step = event.shiftKey ? 10 : 2;
      setSize(text.width + dx * step / viewport.width, text.height + dy * step / viewport.height);
    });
    box.append(input, drag, remove, resize); this.layer.append(box);
  }
  async getFont(pdf) {
    if (!window.fontkit) throw new Error("Text tools couldn't load. Refresh and try again.");
    if (!this.fontBytes) {
      const response = await fetch("fonts/NotoSans-Regular.ttf");
      if (!response.ok) throw new Error("The PDF font couldn't load. Check your connection and retry.");
      this.fontBytes = new Uint8Array(await response.arrayBuffer());
    }
    pdf.registerFontkit(window.fontkit);
    return pdf.embedFont(this.fontBytes, { subset: true });
  }
  async applyTo(pdf, viewer) {
    if (!this.available || !this.dirty) return;
    const changes = structuredClone([...this.changes]);
    const texts = structuredClone(this.texts);
    const font = await this.getFont(pdf);
    const supported = new Set(font.getCharacterSet());
    const validate = (value) => {
      for (const char of String(value)) if (!/[\r\n\t]/.test(char) && !supported.has(char.codePointAt(0))) throw new Error(`The PDF font cannot display “${char}”. Please replace it before downloading.`);
    };
    const form = changes.length ? pdf.getForm() : null;
    for (const [name, change] of changes) {
      const field = form.getField(name);
      if (change.kind === "text") {
        validate(change.value); field.setText(change.value);
        try { field.setFontSize(change.fontSize); } catch { field.acroField.setDefaultAppearance(`/PDFNoto ${change.fontSize} Tf 0 g`); }
        field.updateAppearances(font);
      }
      else if (change.kind === "checkbox") { change.value ? field.check() : field.uncheck(); field.updateAppearances(); }
      else if (change.kind === "radio") {
        // PDF.js exposes the widget's on-state name, which can differ from /Opt labels.
        field.acroField.setValue(window.PDFLib.PDFName.of(change.value)); field.updateAppearances();
      }
      else {
        // PDF choices can have distinct stored export values and displayed labels.
        // Keep the stored values intact while generating appearances with the labels.
        const { PDFName, PDFHexString } = window.PDFLib;
        const encoded = change.value.map((value) => PDFHexString.fromText(value));
        const dictionary = field.acroField.dict;
        if (!encoded.length) dictionary.delete(PDFName.of("V"));
        else dictionary.set(PDFName.of("V"), encoded.length === 1 ? encoded[0] : pdf.context.obj(encoded));
        if (encoded.length > 1) dictionary.set(PDFName.of("I"), pdf.context.obj(change.value.map((value) => change.options.findIndex((option) => option.exportValue === value)).sort((a, b) => a - b)));
        else dictionary.delete(PDFName.of("I"));
        const labels = change.value.map((value) => change.options.find((option) => option.exportValue === value)?.displayValue || value);
        for (const value of labels) validate(value);
        const getSelected = field.getSelected;
        field.getSelected = () => labels;
        try { field.setFontSize(change.fontSize); } catch { field.acroField.setDefaultAppearance(`/PDFNoto ${change.fontSize} Tf 0 g`); }
        try { field.updateAppearances(font); } finally { field.getSelected = getSelected; }
      }
    }
    for (const text of texts) {
      if (!text.text.trim()) continue;
      validate(text.text);
      const viewport = (await viewer.getPage(text.pageNumber)).getViewport({ scale: 1 });
      const page = pdf.getPage(text.pageNumber - 1);
      const width = text.width * viewport.width - 6;
      const lines = [];
      for (const paragraph of text.text.replace(/\r\n?/g, "\n").split("\n")) {
        let line = "";
        for (const char of paragraph.replace(/\t/g, "    ")) {
          if (line && font.widthOfTextAtSize(line + char, text.fontSize) > width) { lines.push(line); line = ""; }
          line += char;
        }
        lines.push(line);
      }
      if (lines.length * text.fontSize * 1.25 > text.height * viewport.height - 4) throw new Error("Some added text does not fit its box. Enlarge the text box or use a smaller font size.");
      for (const [index, line] of lines.entries()) {
        const x = text.left * viewport.width + 3, y = text.top * viewport.height + text.fontSize + 2 + index * text.fontSize * 1.25;
        const origin = viewport.convertToPdfPoint(x, y), next = viewport.convertToPdfPoint(x + 1, y);
        page.drawText(line, { x: origin[0], y: origin[1], font, size: text.fontSize, color: window.PDFLib.rgb(.08, .1, .14), rotate: window.PDFLib.degrees(Math.atan2(next[1] - origin[1], next[0] - origin[0]) * 180 / Math.PI) });
      }
    }
  }
};
