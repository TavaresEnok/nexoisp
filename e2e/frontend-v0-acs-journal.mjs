import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {csrf} from './csrf.mjs';
const base=process.env.BASE;
assert.ok(base?.startsWith('http://127.0.0.1:'));
const fixture=JSON.parse(await readFile('/evidence/fixture.json','utf8'));
const browser=await chromium.launch({args:['--no-sandbox']});
const ctx=await browser.newContext({viewport:{width:1342,height:805}});
const page=await ctx.newPage();page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function request(path,data,method='POST',context=ctx){return context.request.fetch(`${base}/api${path}`,{method,headers:await csrf(context,base),...(data?{data}:{})});}
async function json(path,data,method='POST',context=ctx){const r=await request(path,data,method,context);assert.equal(r.status(),200,await r.text());return r.json();}
const taskBase=`/contracts/${fixture.contract}/cpe/tasks`;
async function waitTask(context,path,state){let item;for(let i=0;i<60;i++){item=(await json(path,null,'GET',context))[0];if(item?.state===state)return item;await new Promise(r=>setTimeout(r,200));}assert.fail(`task did not reach ${state}: ${JSON.stringify(item)}`);}
try{
 await json('/auth/login',{email:'admin@alfa.demo',password:'demo1234'});
 await page.goto(`${base}/contratos?contrato=${fixture.contract}`);
 await page.getByRole('tab',{name:'Acesso',exact:true}).click();
 await page.getByRole('button',{name:'Alterar Wi-Fi 1',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Alterar Wi-Fi do assinante',exact:true});
 await dialog.getByLabel('Nome da rede Wi-Fi',{exact:true}).fill('Synthetic Admin SSID');
 await dialog.getByLabel('Nova senha Wi-Fi',{exact:true}).fill('synthetic-admin-psk');
 const submitted=page.waitForResponse(r=>r.url().endsWith(`/api/contracts/${fixture.contract}/cpe/wifi`)&&r.request().method()==='POST');
 await dialog.getByRole('button',{name:'Solicitar alteração Wi-Fi',exact:true}).click();
 const reply=await submitted;assert.equal(reply.status(),200,await reply.text());const prepared=await reply.json();assert.equal(prepared.result,'prepared');
 await dialog.waitFor({state:'hidden'});
 const task=await waitTask(ctx,taskBase,'queued');
 const body={intent_id:task.intent_id,index:'1',ssid:'Synthetic Admin SSID',password:'synthetic-admin-psk'};
 assert.equal((await json(`/contracts/${fixture.contract}/cpe/wifi`,body)).task_id,task.id);
 assert.equal((await request(`/contracts/${fixture.contract}/cpe/wifi`,{...body,ssid:'Different'})).status(),409);
 assert.equal((await request(`/contracts/${fixture.contract}/cpe/link`,null,'DELETE')).status(),409);
 assert.equal(JSON.stringify(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage)))).includes('synthetic-admin-psk'),false);
 assert.equal(JSON.stringify(await json(taskBase,null,'GET')).includes('synthetic-admin-psk'),false);
 await json(`${taskBase}/${task.id}/retry-lookup`,{reason:'Synthetic fresh readback after accepted task'});
 await waitTask(ctx,taskBase,'observed');
 await page.reload();await page.getByRole('tab',{name:'Acesso',exact:true}).click();
 await page.getByText('Alteração observada por leitura',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('heading',{name:'Roteador do assinante · TR-069',exact:true}).scrollIntoViewIfNeeded();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'CPE mobile horizontal overflow');
 await page.screenshot({path:'/evidence/cpe-journal-mobile.png'});
 const portal=await browser.newContext({viewport:{width:390,height:844}});const pp=await portal.newPage();
 await json('/auth/login',{email:fixture.portal_email,password:'synthetic-portal-password'},'POST',portal);
 await pp.goto(`${base}/portal`);
 await pp.getByRole('heading',{name:'Meu Wi-Fi',exact:true}).waitFor();
 await pp.getByRole('button',{name:'Alterar Wi-Fi 1',exact:true}).click();
 const edit=pp.getByRole('dialog',{name:'Alterar meu Wi-Fi',exact:true});
 await edit.getByLabel('Nome da minha rede',{exact:true}).fill('Synthetic Portal SSID');
 await edit.getByLabel('Nova senha do meu Wi-Fi',{exact:true}).fill('synthetic-portal-psk');
 await edit.getByRole('button',{name:'Registrar alteração',exact:true}).click();await edit.waitFor({state:'hidden'});
 const path=`/portal/cpe/${fixture.contract}/tasks`;const own=await waitTask(portal,path,'queued');
 await json(`${path}/${own.id}/retry-lookup`,{reason:'Synthetic portal readback lookup only'},'POST',portal);
 await waitTask(portal,path,'observed');
 assert.equal(JSON.stringify(await pp.evaluate(()=>Object.fromEntries(Object.entries(localStorage)))).includes('synthetic-portal-psk'),false);
 assert.equal((await request(`/portal/cpe/${fixture.foreign_contract}/tasks`,null,'GET',portal)).status(),404);
 await pp.reload();await pp.getByText('Synthetic Portal SSID',{exact:true}).waitFor();
 await pp.screenshot({path:'/evidence/portal-journal-mobile.png'});
 await portal.close();
 for(const kind of ['refresh','reboot']){
  const intention={intent_id:crypto.randomUUID()};
  const prepared=await json(`/contracts/${fixture.contract}/cpe/${kind}`,intention);
  assert.equal(prepared.result,'prepared');
  const accepted=await waitTask(ctx,taskBase,'queued');
  await json(`${taskBase}/${accepted.id}/retry-lookup`,{reason:'Synthetic '+kind+' fresh observation'});
  await waitTask(ctx,taskBase,'observed');
 }
 const beta=await browser.newContext();
 await json('/auth/login',{email:'admin@beta.demo',password:'demo1234'},'POST',beta);
 const subscriber=await json('/subscribers',{name:'Synthetic TR181 queued subscriber'},'POST',beta);
 const plans=await json('/plans',null,'GET',beta);
 const contract=await json('/contracts',{subscriber_id:subscriber.id,plan_id:plans[0].id,due_day:15},'POST',beta);
 await json(`/contracts/${contract.id}/cpe/link`,{acs_device_id:fixture.tr181,serial:fixture.tr181},'POST',beta);
 await json(`/contracts/${contract.id}/cpe/wifi`,{intent_id:crypto.randomUUID(),index:'1',ssid:'Synthetic TR181 changed'},'POST',beta);
 const queuePath=`/contracts/${contract.id}/cpe/tasks`;
 const accepted=await waitTask(beta,queuePath,'queued');
 assert.equal((await json(`/contracts/${contract.id}/cpe`,null,'GET',beta)).device.wifi[0].ssid,'WiFi sintético 181');
 const inform=await ctx.request.post(`${fixture.acs}/_fixture/complete/${fixture.tr181}`,{data:{}});assert.equal(inform.status(),200);
 await json(`${queuePath}/${accepted.id}/retry-lookup`,{reason:'Synthetic TR181 Inform was delivered'},'POST',beta);
 await waitTask(beta,queuePath,'observed');
 assert.equal((await json(`/contracts/${contract.id}/cpe`,null,'GET',beta)).device.wifi[0].ssid,'Synthetic TR181 changed');
 await beta.close();assert.deepEqual(errors,[]);
 await writeFile('/evidence/browser-checks.json',JSON.stringify({ok:true,checks:['admin and portal actual cookie/CSRF flows','prepared vs queued vs fresh observed state','same intention replay and changed-body conflict','pending unlink blocked','no PSK in persisted browser identity','mobile official interface','subscriber tasks isolated','refresh object uses GenieACS _timestamp','reboot requires fresh reset uptime','TR181 queued until synthetic Inform then observed'],physical_homologation:false},null,2));
} catch(e){await page.screenshot({path:'/evidence/browser-failure.png'}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-5000));throw e;}
finally{await ctx.close();await browser.close();}
