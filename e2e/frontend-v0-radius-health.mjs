import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const base=process.env.BASE;assert.ok(base?.startsWith('http://127.0.0.1:'));
const browser=await chromium.launch({args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 const r=await context.request.post(`${base}/api/auth/login`,{data:{email:process.env.NEXO_HEALTH_EMAIL??'admin@alfa.demo',password:'demo1234'}});assert.equal(r.status(),200);
 await page.goto(`${base}/rede`);await page.getByRole('heading',{name:'Autenticação integrada',exact:true}).waitFor();
 await page.getByText('Registro de autorização',{exact:true}).waitFor();await page.getByText('Leitura de accounting',{exact:true}).waitFor();
 await page.getByText(/Envio desabilitado · \d+ resultado/).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('.nexo-panel').filter({has:page.getByRole('heading',{name:'Autenticação integrada',exact:true})}).screenshot({path:'/evidence/radius-health-mobile.png'});assert.deepEqual(errors,[]);
 await writeFile('/evidence/browser-checks.json',JSON.stringify({ok:true,checks:['real cookie session','capability states separated','Disconnect gate is visibly off','mobile official interface without horizontal overflow'],physical_homologation:false},null,2));
}catch(e){await page.screenshot({path:'/evidence/health-failure.png'}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-3000));throw e;}
finally{await context.close();await browser.close();}
