import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
const base=process.env.BASE;assert.ok(base?.startsWith('http://127.0.0.1:'));
const id=process.env.NEXO_NOTICE_ID,connection=process.env.NEXO_NOTICE_CONNECTION;assert.ok(id&&connection);
const browser=await chromium.launch({args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 let r=await context.request.post(`${base}/api/auth/login`,{data:{email:'admin@alfa.demo',password:'demo1234'}});assert.equal(r.status(),200);
 const root=`${base}/api/financial-connections/${connection}/notices`;
 r=await context.request.post(`${root}/${id}/review`,{data:{intent_id:randomUUID(),action:'ack',reason:'Sem CSRF deve ser negado'}});assert.equal(r.status(),403);
 await page.goto(`${base}/administracao/integracoes?aba=financeiro`);
 await page.getByRole('button',{name:'Nova conexão financeira',exact:true}).waitFor();
 const row=page.locator('tr').filter({hasText:connection});await row.getByRole('button',{name:'Triagem de avisos',exact:true}).click();
 await page.getByRole('heading',{name:'Triagem de notificações · Synthetic notice UI',exact:true}).waitFor();
 await page.getByRole('button',{name:`Marcar conferido ${id.slice(0,8)}`,exact:true}).click();
 await page.getByLabel('Justificativa',{exact:true}).fill('Aviso sintético conferido sem considerar o conteúdo como pagamento');
 await page.getByRole('button',{name:'Registrar conferência',exact:true}).click();
 await page.getByText('Conferência registrada sem efeito financeiro',{exact:true}).waitFor();
 await page.getByRole('button',{name:`Marcar conferido ${id.slice(0,8)}`,exact:true}).waitFor({state:'detached'});
 await page.getByLabel('Visualização',{exact:true}).selectOption('acknowledged');
 await page.getByText(id,{exact:true}).waitFor();
 await page.getByRole('button',{name:`Solicitar nova consulta ${id.slice(0,8)}`,exact:true}).click();
 await page.getByLabel('Justificativa',{exact:true}).fill('Solicitar consulta autenticada dos dados originais no worker');
 await page.getByRole('button',{name:'Reagendar consulta',exact:true}).click();
 await page.getByText('Consulta reagendada; aguarde o processamento',{exact:true}).waitFor();
 await page.getByLabel('Visualização',{exact:true}).selectOption('open');await page.getByText(id,{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('dialog').first().screenshot({path:'/evidence/notices-mobile.png'});
 assert.deepEqual(errors,[]);
 await writeFile('/evidence/browser-notices.json',JSON.stringify({ok:true,checks:['cookie/CSRF','official connections entry','acknowledged history','lookup-only retry','390px'],bank:false},null,2));
}catch(e){await page.screenshot({path:'/evidence/notices-failure.png'}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-3500));throw e;}
finally{await context.close();await browser.close();}
