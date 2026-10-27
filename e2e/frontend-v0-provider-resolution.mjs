// Directed UI journey against a disposable API. Fixture charges are synthetic,
// with deliberately mismatched config hashes: lookup stops before PSP I/O.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';
assert.equal(process.env.NEXO_PAYMENT_LAB,'1');
const base=process.env.BASE;assert.match(base??'',/^http:\/\/127\.0\.0\.1:\d+$/);
const fixture=JSON.parse(await readFile('/evidence/resolution-fixture.json','utf8'));
const browser=await chromium.launch({args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1342,height:900}});
const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 const login=await context.request.post(base+'/api/auth/login',{headers:await csrf(context,base),data:{email:fixture.email,password:'demo1234'}});assert.equal(login.status(),200);
 for (const [kind,label,title,id] of [['resolve','Resolver com consulta autenticada','Resolver resultado financeiro',fixture.resolve],['reissue','Preparar reemissão segura','Preparar reemissão segura',fixture.reissue]]) {
  await page.goto(base+'/financeiro/faturas?fatura='+id);
  await page.getByRole('button',{name:label,exact:true}).click();
  const form=page.getByRole('dialog',{name:title,exact:true});
  await form.getByLabel('Justificativa (10 a 500 caracteres)',{exact:true}).fill('Conferência sintética sem chamadas ao provedor');
  const response=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/'+kind) && r.request().method()==='POST');
  await form.getByRole('button',{name:'Registrar intenção',exact:true}).click();
  const r=await response;assert.equal(r.status(),409);assert.match(await r.text(),/configuração difere/);
  await page.reload();
  await page.getByText(/Intenção preservada:/).waitFor();
  const pending=await page.evaluate(id=>Object.keys(localStorage).filter(k=>k.startsWith('nexo:provider-billing:')&&k.includes(id)).map(k=>JSON.parse(localStorage.getItem(k))),id);
  assert.equal(pending.length,1);assert.equal(pending[0].kind,kind);
  const again=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/'+kind) && r.request().method()==='POST');
  await page.getByRole('button',{name:'Recuperar intenção pendente',exact:true}).click();
  assert.equal((await again).request().postDataJSON().intent_id,pending[0].intent_id);
 }
 await page.setViewportSize({width:390,height:844});await page.reload();await page.getByText(/Intenção preservada:/).waitFor();
 await page.getByText('Cobrança no provedor',{exact:true}).scrollIntoViewIfNeeded();
 const dialog=page.getByRole('dialog').first();assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+2),true,'invoice dialog overflows on mobile');
 await page.screenshot({path:'/evidence/resolution-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 await writeFile('/evidence/resolution-browser.json',JSON.stringify({ok:true,checks:['official UI resolve/reissue forms','cookie and CSRF','conflicting configuration rejected before PSP I/O','reload and recovery retain exact intention','mobile render'],provider_called:false},null,2));
} catch(e){await page.screenshot({path:'/evidence/resolution-browser-failure.png',fullPage:true});await writeFile('/evidence/resolution-browser-failure.txt',await page.locator('body').innerText());throw e;}
finally{await context.close();await browser.close();}
