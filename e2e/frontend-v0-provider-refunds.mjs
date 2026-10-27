import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';
const base=process.env.BASE;
assert.match(base??'',/^http:\/\/127\.0\.0\.1:\d+$/);
const fixture=JSON.parse(await readFile('/docs/integracao-v0/evidencias/provider-refund-fixture.json','utf8'));
const browser=await chromium.launch({args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1342,height:805}});
const page=await context.newPage();page.setDefaultTimeout(15000);
try {
 const login=await context.request.post(base+'/api/auth/login',{headers:await csrf(context,base),data:{email:'admin@alfa.demo',password:'demo1234'}});assert.equal(login.ok(),true);
 for(const mode of ['partial','full']) {
  const response=await context.request.get(base+'/api/invoices/'+fixture[mode]);assert.equal(response.ok(),true);const invoice=await response.json();
  assert.equal(invoice.amount_cents,12345);assert.equal(invoice.paid_cents,mode==='partial'?8345:0);
  const dueResponse=await context.request.get(base+'/api/invoices/'+fixture[mode]+'/due');assert.equal(dueResponse.ok(),true);
  const due=await dueResponse.json();assert.equal(due.remaining_cents,mode==='partial'?4000:12345);
  await page.goto(base+'/financeiro/faturas?fatura='+fixture[mode]);
  const row=page.getByRole('row').filter({hasText:'synthetic-original-'+mode});
  await row.waitFor();const text=await row.innerText();
  if(mode==='partial'){assert.match(text,/Devolução parcial.*40,00/);assert.equal(text.includes('Estornada'),false);}
  else {assert.match(text,/Estornada/);assert.equal(text.includes('Devolução parcial'),false);}
  assert.equal(await row.getByRole('button',{name:'Estornar baixa',exact:true}).count(),0);
  await page.reload();await row.waitFor();
 }
 const result={ok:true,checks:['API preserves nominal, net receipt and residual after synthetic partial/full provider refunds','Official UI distinguishes partial refund from full reversal after reload','Provider receipts never expose the manual reversal action'],fixture:'synthetic owner data; no real PSP'};
 await writeFile('/docs/integracao-v0/evidencias/provider-refund-ui.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await context.close();await browser.close();}
