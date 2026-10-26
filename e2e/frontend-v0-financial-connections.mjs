import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csrf } from './csrf.mjs';
const base=process.env.BASE;
assert.match(base??'',/^http:\/\/127\.0\.0\.1:\d+$/);
const browser=await chromium.launch({args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1342,height:805}});
const operator=await browser.newContext();
const page=await context.newPage();page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function api(path,body,method='POST',ctx=context){
 const r=await ctx.request.fetch(base+'/api'+path,{method,headers:await csrf(ctx,base),...(body?{data:body}:{})});assert.equal(r.ok(),true,await r.text());return r.json();
}
const name='Conexão B03 '+Date.now(),secret='synthetic-browser-secret-'+'x'.repeat(40);
let tenant;
try{
 await api('/auth/login',{email:'admin@alfa.demo',password:'demo1234'});
 await api('/auth/login',{email:'operador@nexoisp.demo',password:'demo1234'},'POST',operator);
 tenant=(await api('/tenants',null,'GET',operator)).find(x=>x.slug==='alfa');
 await api('/tenants/'+tenant.id,{modules:[...new Set([...tenant.modules,'api'])]},'PATCH',operator);
 await page.goto(base+'/administracao/integracoes?aba=financeiro');
 await page.getByRole('button',{name:'Nova conexão financeira',exact:true}).click();
 const form=page.getByRole('dialog',{name:'Nova conexão financeira',exact:true});
 await form.getByLabel('Nome da conexão',{exact:true}).fill(name);
 await form.getByLabel('Referência da conta',{exact:true}).fill('browser-account-'+Date.now());
 await form.getByLabel('Segredo do webhook demonstrativo',{exact:true}).fill(secret);
 await form.getByRole('button',{name:'Cadastrar conexão',exact:true}).click();await form.waitFor({state:'hidden'});
 const records=await api('/financial-connections',null,'GET');const record=records.find(x=>x.name===name);assert.ok(record);assert.equal(record.status,'pending');assert.ok(record.has_webhook_secret);
 assert.equal(JSON.stringify(records).includes(secret),false);assert.equal(JSON.stringify(records).includes('webhook_secret_enc'),false);
 const row=page.getByRole('row').filter({has:page.getByText(name,{exact:true})});
 async function action(label,status){
  await row.getByRole('button',{name:label,exact:true}).click();
  const response=page.waitForResponse(r=>r.url().endsWith('/financial-connections/'+record.id)&&r.request().method()==='PATCH');
  await page.getByRole('dialog',{name:'Confirme a ação',exact:true}).getByRole('button',{name:'Confirmar',exact:true}).click();assert.equal((await response).status(),200);
  await page.getByRole('dialog',{name:'Confirme a ação',exact:true}).waitFor({state:'hidden'});
  assert.equal((await api('/financial-connections',null,'GET')).find(x=>x.id===record.id).status,status);
 }
 await action('Ativar','active');await action('Usar como padrão','active');await action('Desativar','disabled');
 await page.reload();await row.getByText('Desativada',{exact:true}).waitFor();

 const vault=await api('/financial-connections',{name:'Cofre sintético '+Date.now(),provider:'efi',environment:'sandbox',account_ref:'vault-'+Date.now()});
 await page.reload();
 const vaultRow=page.getByRole('row').filter({has:page.getByText(vault.name,{exact:true})});
 const temporary=await mkdtemp(join(tmpdir(),'nexo-vault-browser-'));
 try{
  const cert=join(temporary,'synthetic.pem'),key=join(temporary,'synthetic.key');
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=synthetic-browser-vault','-keyout',key,'-out',cert],{stdio:'ignore'});
  await vaultRow.getByRole('button',{name:'Credenciais',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Credenciais de '+vault.name,exact:true});
  await dialog.getByLabel('ID da aplicação',{exact:true}).fill('synthetic-browser-client');
  await dialog.getByLabel('Senha da aplicação',{exact:true}).fill('SYNTHETIC-BROWSER-SECRET');
  await dialog.getByLabel('Chave Pix',{exact:true}).fill('synthetic-pix-key');
  await dialog.getByLabel('Certificado PEM',{exact:true}).setInputFiles(cert);
  await dialog.getByLabel('Chave privada PEM',{exact:true}).setInputFiles(key);
  await dialog.getByRole('button',{name:'Salvar nova versão',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await vaultRow.getByText('Configurada',{exact:true}).waitFor();
  const versions=await api('/financial-connections/'+vault.id+'/credentials',null,'GET');assert.equal(versions.length,1);assert.equal(versions[0].version,1);
  assert.equal(JSON.stringify(versions).includes('SYNTHETIC-BROWSER-SECRET'),false);assert.equal(JSON.stringify(versions).includes('PRIVATE KEY'),false);assert.equal(JSON.stringify(versions).includes('secret_enc'),false);
  await page.reload();await vaultRow.getByRole('button',{name:'Credenciais',exact:true}).click();
  const reopened=page.getByRole('dialog',{name:'Credenciais de '+vault.name,exact:true});
  await reopened.getByText(/Versão atual: 1/).waitFor();assert.equal(await reopened.getByLabel('Senha da aplicação',{exact:true}).inputValue(),'');
  const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert.equal(storage.includes('SYNTHETIC-BROWSER-SECRET'),false);assert.equal(storage.includes('PRIVATE KEY'),false);
  await reopened.getByRole('button',{name:'Cancelar',exact:true}).click();await reopened.waitFor({state:'hidden'});
 }finally{await rm(temporary,{recursive:true,force:true});}
 assert.deepEqual(errors,[]);
 await page.screenshot({path:new URL('../docs/integracao-v0/evidencias/b03-financial-connections.png',import.meta.url).pathname,fullPage:true});
 const result={ok:true,checks:['cadastro pela interface persiste conexão pendente','segredo não retorna nem cifrado na listagem','ativação sandbox, troca de padrão e desativação confirmadas no backend','reload preserva estado; componentes oficiais e API reais','cofre pela UI persiste certificado sintético e versão; segredo não retorna nem fica no armazenamento do navegador'],connection:record.id};
 await writeFile(new URL('../docs/integracao-v0/evidencias/b03-financial-connections.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 if(tenant)await api('/tenants/'+tenant.id,{modules:tenant.modules},'PATCH',operator).catch(()=>{});
 await context.close();await operator.close();await browser.close();
}
