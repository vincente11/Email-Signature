/* Regression checks: node tests/pdf-fill.cjs
 * Requires Playwright and Chrome. PLAYWRIGHT_MODULE may point to a local package.
 * Uses a mocked account/storage API: never sends requests or messages to real users.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const stub = `
const user={id:'11111111-1111-4111-8111-111111111111',email:'test@example.invalid',user_metadata:{first_name:'Test',last_name:'User'}};
window.supabase={createClient:()=>({
 auth:{getSession:async()=>({data:{session:{user}}}),getUser:async()=>({data:{user}}),onAuthStateChange:()=>{},signOut:async()=>({})},
 from:()=>({insert:async()=>({error:null})}),
 storage:{from:()=>({
   upload:async(_path,blob)=>{window.__uploaded=Array.from(new Uint8Array(await blob.arrayBuffer()));return {error:null}},
   download:async()=>({data:new Blob([new Uint8Array(window.__sharedFixture)],{type:'application/pdf'})})
 })},
 rpc:async(name)=>({data:name==='search_signing_users'?[{user_id:'22222222-2222-4222-8222-222222222222',display_name:'Test Peer',email:'peer@example.invalid'}]:name==='list_signing_requests'&&new URLSearchParams(location.search).has('request')?[{request_id:new URLSearchParams(location.search).get('request'),status:'pending',owner_id:'22222222-2222-4222-8222-222222222222',my_status:'pending',my_position:1,active_signer_position:1,storage_path:'shared/document.pdf',file_name:'shared.pdf',signers:[]}]:[]})
})};`;
const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.ttf':'font/ttf', '.png':'image/png' };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    response.end(await fs.readFile(file));
  } catch { response.statusCode=404; response.end('Not found'); }
});
let browser;
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel:process.env.BROWSER_CHANNEL || 'chrome', headless:true });
  const page = await browser.newPage({ viewport:{width:1440,height:1000} });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', (route) => route.fulfill({contentType:'application/javascript',body:stub}));
  // Proxy external static assets through Node for environments with browser TLS restrictions.
  const assets = new Map();
  await page.route(/https:\/\/(?!cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2)/, async (route) => {
    const url = route.request().url();
    if (url.includes('.supabase.co')) return route.abort();
    if (!assets.has(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Asset failed: ${url}`);
      assets.set(url, {contentType:response.headers.get('content-type') || 'application/octet-stream',body:Buffer.from(await response.arrayBuffer())});
    }
    return route.fulfill(assets.get(url));
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, {waitUntil:'networkidle'});
  async function downloadBy(selector) {
    try {
      const [download]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);
      return download;
    } catch (error) {
      error.message += '\nApp status: ' + await page.locator('#toast').textContent();
      throw error;
    }
  }
  const fixture = await page.evaluate(async () => {
    const {PDFDocument,PDFHexString}=PDFLib, pdf=await PDFDocument.create();
    const page=pdf.addPage([600,800]), second=pdf.addPage([600,800]), form=pdf.getForm();
    const name=form.createTextField('Full name'); name.setText('Original'); name.addToPage(page,{x:50,y:680,width:300,height:26});
    const address=form.createTextField('Address'); address.enableMultiline(); address.addToPage(page,{x:50,y:585,width:300,height:60});
    form.createCheckBox('Agree').addToPage(page,{x:50,y:540,width:18,height:18});
    const delivery=form.createRadioGroup('Delivery'); delivery.addOptionToPage('Email',page,{x:50,y:500,width:18,height:18}); delivery.addOptionToPage('Post',page,{x:160,y:500,width:18,height:18});
    const country=form.createDropdown('Country'); country.acroField.setOptions([{value:PDFHexString.fromText('ZA'),display:PDFHexString.fromText('South Africa')},{value:PDFHexString.fromText('BW'),display:PDFHexString.fromText('Botswana')}]); country.addToPage(page,{x:50,y:440,width:220,height:30});
    const topics=form.createOptionList('Topics'); topics.setOptions(['Design','Fabrication','Inspection']); topics.enableMultiselect(); topics.addToPage(page,{x:50,y:320,width:220,height:90});
    const reference=form.createTextField('Reference'); reference.setText('Locked'); reference.enableReadOnly(); reference.addToPage(page,{x:50,y:260,width:220,height:24});
    second.drawText('Additional notes',{x:50,y:740});
    return Array.from(await pdf.save());
  });
  await page.locator('#pdfInput').setInputFiles({name:'application.pdf',mimeType:'application/pdf',buffer:Buffer.from(fixture)});
  await page.getByRole('textbox',{name:'Full name',exact:true}).fill('Zoë Иван');
  assert.equal(await page.locator('#pdfFillMode').getAttribute('aria-pressed'), 'true');
  await page.getByRole('textbox',{name:'Address',exact:true}).fill('12 Main Road\nJohannesburg');
  await page.getByRole('checkbox',{name:'Agree',exact:true}).check();
  await page.locator('.pdf-fill-field[type=radio]').nth(1).check();
  await page.getByRole('combobox',{name:'Country',exact:true}).selectOption('BW');
  await page.getByRole('listbox',{name:'Topics',exact:true}).selectOption(['Design','Inspection']);
  assert.equal(await page.locator('[data-field-name="Reference"]').count(), 0);
  await page.locator('#nextPage').click();
  await page.waitForFunction(()=>document.querySelector('#currentPage').textContent==='2');
  await page.locator('.pdf-fill-layer').click({position:{x:60,y:120}});
  await page.getByRole('textbox',{name:'Added text',exact:true}).fill('Additional note — café');
  const filled=await downloadBy('#downloadFilledPdf');
  assert.equal(filled.suggestedFilename(),'application-filled.pdf');
  const output=Array.from(await fs.readFile(await filled.path()));
  async function inspect(data) {
    return page.evaluate(async bytes=>{
      const pdf=await PDFLib.PDFDocument.load(new Uint8Array(bytes)), form=pdf.getForm();
      const viewer=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;
      return {name:form.getTextField('Full name').getText(),address:form.getTextField('Address').getText(),agree:form.getCheckBox('Agree').isChecked(),delivery:form.getRadioGroup('Delivery').getSelected(),country:form.getDropdown('Country').getSelected(),topics:form.getOptionList('Topics').getSelected(),reference:form.getTextField('Reference').getText(),notes:(await (await viewer.getPage(2)).getTextContent()).items.map(item=>item.str).join(' ')};
    },data);
  }
  const expected={name:'Zoë Иван',address:'12 Main Road\nJohannesburg',agree:true,delivery:'Post',country:['BW'],topics:['Design','Inspection'],reference:'Locked'};
  const actual=await inspect(output); assert.ok(actual.notes.includes('Additional note — café')); delete actual.notes; assert.deepEqual(actual,expected);
  await page.locator('#previousPage').click();
  await page.getByRole('textbox',{name:'Full name',exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Full name',exact:true}).inputValue(),'Zoë Иван');
  await page.locator('#zoomIn').click();
  assert.equal(await page.getByRole('textbox',{name:'Full name',exact:true}).inputValue(),'Zoë Иван');
  await page.locator('#pdfSignMode').click();
  await page.locator('#signaturePreview.visible').waitFor();
  await page.locator('#pdfCanvas').click({position:{x:300,y:350}});
  const signed=await downloadBy('#downloadButton'); assert.equal(signed.suggestedFilename(),'application-signed.pdf');
  const signedData=await inspect(Array.from(await fs.readFile(await signed.path())));
  assert.ok(signedData.notes.includes('Additional note — café')); delete signedData.notes; assert.deepEqual(signedData,expected);
  // Sign-off creation is mocked; verify that its uploaded snapshot contains all fills.
  await page.locator('#openRequestDialog').click(); await page.locator('#signerSearch').fill('Test');
  await page.locator('.signer-option').click(); await page.locator('#startRequestButton').click();
  await page.waitForFunction(()=>Boolean(window.__uploaded));
  const shared=await inspect(await page.evaluate(()=>window.__uploaded));
  assert.ok(shared.notes.includes('Additional note — café')); delete shared.notes; assert.deepEqual(shared,expected);
  await page.locator('#removeFile').click();
  assert.equal(await page.locator('#pdfEditModes').isVisible(),false);
  assert.equal(await page.locator('.pdf-fill-field').count(),0);
  // Flat, rotated, cropped documents use the same visual coordinate system as signatures.
  const flat=await page.evaluate(async()=>{const pdf=await PDFLib.PDFDocument.create(),page=pdf.addPage([600,800]);page.setCropBox(30,20,500,700);page.setRotation(PDFLib.degrees(90));return Array.from(await pdf.save())});
  await page.locator('#pdfInput').setInputFiles({name:'flat.pdf',mimeType:'application/pdf',buffer:Buffer.from(flat)});
  await page.locator('#pdfFillMode').click(); await page.locator('.pdf-fill-layer').click({position:{x:80,y:100}});
  await page.getByRole('textbox',{name:'Added text',exact:true}).fill('Rotated entry');
  const flatDownload=await downloadBy('#downloadFilledPdf'), flatBytes=Array.from(await fs.readFile(await flatDownload.path()));
  const position=await page.evaluate(async data=>{const viewer=await pdfjsLib.getDocument({data:new Uint8Array(data)}).promise,page=await viewer.getPage(1),viewport=page.getViewport({scale:1}),item=(await page.getTextContent()).items.find(item=>item.str==='Rotated entry');return {actual:item.transform.slice(4),expected:viewport.convertToPdfPoint(83,114)}},flatBytes);
  assert.ok(position.actual.every((value,index)=>Math.abs(value-position.expected[index])<.2));
  const originalBox=await page.locator('.pdf-free-text').boundingBox();
  await page.getByRole('button',{name:'Move added text; use arrow keys to adjust'}).press('ArrowRight');
  await page.getByRole('button',{name:'Resize added text; use arrow keys to adjust'}).press('Shift+ArrowRight');
  const movedBox=await page.locator('.pdf-free-text').boundingBox();
  assert.ok(movedBox.x>originalBox.x && movedBox.width>originalBox.width);
  await page.getByRole('button',{name:'Remove added text',exact:true}).click();
  assert.equal(await page.locator('.pdf-free-text').count(),0);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const excel=await page.evaluate(()=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Item','Value'],['Steel',42]]),'Costs');return Array.from(new Uint8Array(XLSX.write(wb,{type:'array',bookType:'xlsx'})))});
  await page.locator('#pdfInput').setInputFiles({name:'costs.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(excel)});
  await page.locator('#fileName').getByText('costs.xlsx',{exact:true}).waitFor();
  assert.equal(await page.locator('#pdfEditModes').isVisible(),false);
  assert.equal(await page.locator('.pdf-fill-field').count(),0);
  assert.equal(await page.locator('#downloadButton').textContent(),'Download signed Excel');
  await page.addInitScript((fixture)=>{window.__sharedFixture=fixture},fixture);
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?request=33333333-3333-4333-8333-333333333333`,{waitUntil:'networkidle'});
  await page.locator('#downloadButton').getByText('Submit signature',{exact:true}).waitFor();
  assert.equal(await page.locator('#pdfEditModes').isVisible(),false);
  assert.equal(await page.locator('#pdfFillPanel').isVisible(),false);
  assert.equal(await page.locator('.pdf-fill-field').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: native fields, Unicode, flat PDFs, rotated/cropped placement, move/resize/delete, page/zoom persistence, signing, filled sharing snapshot, reset, mobile layout, Excel isolation and read-only shared requests.');
})().catch((error)=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.close();});
