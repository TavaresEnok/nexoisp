import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const base=process.env.BASE;assert.ok(base?.startsWith('http://127.0.0.1:'));
const id=process.env.NEXO_ACCOUNTING_EVENT;assert.match(id,/^\d+$/);
const browser=await chromium.launch({args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 const r=await context.request.post(`${base}/api/auth/login`,{data:{email:'admin@alfa.demo',password:'demo1234'}});assert.equal(r.status(),200);
 const noCSRF=await context.request.post(`${base}/api/radius/accounting/events/${id}/reconcile`,{data:{reason:'Tentativa sem CSRF deve ser recusada'}});assert.equal(noCSRF.status(),403);
 await page.goto(`${base}/rede`);
 await page.getByRole('heading',{name:'Eventos de accounting em quarentena',exact:true}).waitFor();
 await page.getByRole('button',{name:`Conciliar evento ${id}`,exact:true}).click();
 await page.getByLabel('Justificativa').fill('Conferido o Start sintético que chegou depois do Stop órfão');
 await page.getByRole('button',{name:'Reprocessar dados originais',exact:true}).click();
 await page.getByText('Evento conciliado',{exact:true}).waitFor();
 await page.getByRole('button',{name:`Conciliar evento ${id}`,exact:true}).waitFor({state:'detached'});
 const me=await context.request.get(`${base}/api/me`);const token=(await me.json()).csrf_token;
 const replay=await context.request.post(`${base}/api/radius/accounting/events/${id}/reconcile`,{headers:{'X-Nexo-CSRF':token},data:{reason:'Repetição intencional da mesma revisão sintética'}});assert.equal(replay.status(),200);assert.equal((await replay.json()).result,'already_processed');
 const dismiss=process.env.NEXO_ACCOUNTING_DISMISS_EVENT;assert.match(dismiss,/^\d+$/);
 await page.getByRole('button',{name:`Arquivar evento ${dismiss}`,exact:true}).click();
 await page.getByLabel('Justificativa').fill('Evento sintético inválido arquivado sem inferir estado da sessão');
 await page.getByRole('button',{name:'Arquivar sem alterar sessões',exact:true}).click();
 await page.getByText('Evento arquivado sem alterar sessões',{exact:true}).waitFor();
 await page.getByRole('button',{name:`Arquivar evento ${dismiss}`,exact:true}).waitFor({state:'detached'});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('dt')).find(e=>e.textContent==='Accounting em quarentena')?.nextElementSibling?.textContent==='0');
 await page.setViewportSize({width:390,height:844});await page.getByRole('heading',{name:'Eventos de accounting em quarentena',exact:true}).scrollIntoViewIfNeeded();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('.nexo-panel').filter({has:page.getByRole('heading',{name:'Autenticação integrada',exact:true})}).screenshot({path:'/evidence/radius-accounting-mobile.png'});
 assert.deepEqual(errors,[]);
 await writeFile('/evidence/browser-accounting.json',JSON.stringify({ok:true,checks:['real cookie session','CSRF rejection','official reasoned reconciliation form','persisted success and replay','390px without overflow'],hardware_homologation:false},null,2));
}catch(e){await page.screenshot({path:'/evidence/accounting-failure.png'}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-3500));throw e;}
finally{await context.close();await browser.close();}
