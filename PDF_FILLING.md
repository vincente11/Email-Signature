# PDF filling

Upload a PDF to start in **Fill PDF** mode, including flat and scanned forms. Standard editable form fields appear as highlighted controls. Click an empty space to type directly; move, resize, remove, or change the size of added text using its controls. Compact text boxes start at the clicked position, including near the right edge of a page.

**Download filled PDF** saves entries without requiring a signature. To include an account signature, switch to **Sign**, place the signature, and use the signed download. Starting a new sign-off request uploads a snapshot containing the filled values and added text.

The original uploaded file is retained in memory. Every export applies the current edits to a fresh copy, avoiding duplicate text across repeated exports. Entries remain while switching pages, zoom levels, and modes. Opening a different document or closing the page clears them; download a copy before leaving.

Supported native controls are standard AcroForm text fields, checkboxes, radio groups, dropdowns, and option lists. Read-only and signature fields are not editable. PDF JavaScript, automatic calculations, and dynamic XFA form workflows are not executed. Added text is drawn into the PDF, while native form fields retain their values and remain interactive in compatible readers. The bundled Noto Sans font supports common Latin, Greek, and Cyrillic text; unsupported characters produce a download error rather than being silently replaced.

Editing is available for local PDFs. Excel imports retain their existing signing/export flow. Documents already in shared signing requests cannot be edited; their immutable version workflow remains unchanged.

Run `tests/pdf-fill.cjs` for browser regression checks (see `tests/README.md`). The font is distributed under the included `fonts/OFL.txt` license.
