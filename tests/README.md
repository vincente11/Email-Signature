# Browser regression checks

`pdf-fill.cjs` runs the local app in headless Chrome with isolated test accounts and mocked Supabase APIs. No real signing requests or chat messages are sent. It starts and stops its own local HTTP server.

Requirements: Node.js 18+, Chrome, and the `playwright` Node package. Run from the repository root:

```powershell
node tests/pdf-fill.cjs
```

If Playwright is installed elsewhere, set `PLAYWRIGHT_MODULE` to its package entry point. `BROWSER_CHANNEL` defaults to `chrome` and can be set to `msedge`.

The test generates standard PDF form fixtures in memory and reads downloaded PDFs back to verify field values and positioned text. Coverage includes Unicode, checkboxes, radio export names, dropdown export/display pairs, multiselect lists, read-only fields, multi-page and zoom persistence, signing, sharing snapshots, rotated/cropped flat pages, moving/resizing/deleting text, resetting, mobile layout, Excel isolation, and read-only shared requests. Static PDF libraries and fonts are fetched over the network; account and storage calls are mocked.
