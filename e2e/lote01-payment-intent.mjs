import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {csrf} from './csrf.mjs';
const base=process.env.BASE;
assert.equal(new URL(base).hostname,'127.0.0.1');assert.equal(process.env.NEXO_PAYMENT_LAB,'1');
const browser=await chromium.launch({executablePath:process.env.LAB_CHROMIUM,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1342,height:805}}),page=await context.newPage();page.setDefaultTimeout(20000);
const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
async function api(path,data){const r=await context.request.fetch(base+'/api'+path,{method:data?'POST':'GET',headers:await csrf(context,base),...(data?{data}:{})});assert.equal(r.status(),200,await r.text());return r.json()}
try{
 await page.goto(base+'/login');await page.getByLabel('E-mail',{exact:true}).fill('admin@alfa.demo');await page.getByLabel('Senha',{exact:true}).fill('demo1234');await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL(u=>u.pathname!='/login');
 assert.equal((await api('/me')).demo,true);
 const name='Lote01 UI '+Date.now(), sub=await api('/subscribers',{name}),plan=(await api('/plans'))[0];
 const contract=await api('/contracts',{subscriber_id:sub.id,plan_id:plan.id,due_day:15});
 const invoice=await api('/invoices',{contract_id:contract.id,description:'Perda de resposta após commit',amount_cents:10000,due_date:'2026-12-15'});
 async function openInvoice(){await page.goto(base+'/financeiro/faturas');await page.getByRole('textbox',{name:'Buscar faturas',exact:true}).fill(name);await page.getByRole('button',{name:'Ver fatura '+invoice.id.slice(0,8).toUpperCase(),exact:true}).click();await page.getByRole('button',{name:'Baixa manual',exact:true}).click()}
 await openInvoice(); const dialog=page.getByRole('dialog',{name:'Baixa manual',exact:true});
 await dialog.getByLabel('Valor recebido (R$)',{exact:true}).fill('20,00');await dialog.getByLabel('Observação da baixa',{exact:true}).fill('Recebimento sintético com perda de resposta');await dialog.getByText('Pagamento parcial',{exact:true}).click();
 let committed=false, firstBody;
 const pattern='**/api/invoices/'+invoice.id+'/manual-payment';
 await page.route(pattern,async route=>{firstBody=route.request().postDataJSON();const response=await route.fetch();assert.equal(response.status(),200,await response.text());committed=true;await route.abort('connectionreset')});
 await dialog.getByRole('button',{name:'Registrar baixa',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.ok(committed);
 assert.equal((await api('/invoices/'+invoice.id)).paid_cents,2000);
 let saved=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('nexo:manual-payment:')));assert.equal(saved.length,1);assert.equal(JSON.parse(saved[0][1]).intent_id,firstBody.intent_id);
 checks.push('Response dropped after actual HTTP200/commit; payment exists and intent remains in localStorage');
 await page.unroute(pattern);await page.reload();await openInvoice();
 assert.equal(await dialog.getByLabel('Valor recebido (R$)',{exact:true}).inputValue(),'20,00');assert.equal(await dialog.getByLabel('Valor recebido (R$)',{exact:true}).isDisabled(),true);
 const replay=page.waitForRequest(r=>r.url().endsWith('/manual-payment'));
 await dialog.getByRole('button',{name:'Confirmar baixa pendente',exact:true}).click();assert.deepEqual((await replay).postDataJSON(),firstBody);await dialog.waitFor({state:'hidden'});
 let detail=await api('/invoices/'+invoice.id);assert.equal(detail.payments.length,1);assert.equal(detail.paid_cents,2000);
 saved=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('nexo:manual-payment:')));assert.equal(saved.length,0);
 checks.push('Reload recovers frozen original form/key; retry confirms one payment and removes acknowledged intent');
 await page.getByRole('button',{name:'Baixa manual',exact:true}).click();await dialog.getByLabel('Valor recebido (R$)',{exact:true}).fill('20,00');await dialog.getByLabel('Observação da baixa',{exact:true}).fill('Novo recebimento legítimo mesmo valor');await dialog.getByText('Pagamento parcial',{exact:true}).click();
 const next=page.waitForRequest(r=>r.url().endsWith('/manual-payment'));await dialog.getByRole('button',{name:'Registrar baixa',exact:true}).click();const nextBody=(await next).postDataJSON();assert.notEqual(nextBody.intent_id,firstBody.intent_id);await dialog.waitFor({state:'hidden'});
 detail=await api('/invoices/'+invoice.id);assert.equal(detail.payments.length,2);assert.equal(detail.paid_cents,4000);checks.push('New same-value intention via official UI persists a second legitimate receipt');
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:process.env.LAB_UI_SCREENSHOT,fullPage:true});
 console.log(JSON.stringify({checks,invoice:invoice.id,contract:contract.id,firstBody,nextBody}));
}finally{await browser.close()}
