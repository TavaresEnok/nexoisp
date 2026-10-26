"""B03 upgrade/quarantine regression on a unique disposable PostgreSQL. No .env."""
from pathlib import Path
import os,sys,subprocess,shutil,json,base64,tempfile,uuid
repo=Path(__file__).resolve().parents[2]
assert os.environ.get('NEXO_PAYMENT_LAB')=='1', 'explicit disposable lab required'
evidence=repo/'tests/contrato/relatorios';evidence.mkdir(parents=True,exist_ok=True)
os.environ['NEXO_CONTRATO_DB_CONTAINER']='nexo-b03-migration-'+uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT']='15690'
sys.path.insert(0,str(repo/'tests/contrato'))
from nativo import up
from lib import sql,go_env,command,DB_CONTAINER
temporary=tempfile.TemporaryDirectory(prefix='nexo-b03-migration-')
stage=Path(temporary.name)
shutil.copytree(repo/'db',stage/'db',dirs_exist_ok=True)
for migration in (stage/'db/migrations').glob('*.sql'):
 if int(migration.name.split('_')[0])>64: migration.unlink()
target=stage/'target65'
shutil.copytree(repo/'db',target/'db')
for migration in (target/'db/migrations').glob('*.sql'):
 if int(migration.name.split('_')[0])>65: migration.unlink()
cli=[str(repo/'apps/api-go/bin/nexo-db')]
try:
 assert subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode!=0
 up();sql('create database nexo_test','postgres')
 env=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
 command(cli+['prepare'],cwd=stage,env=env);command(cli+['seed-demo'],cwd=stage,env=env)
 sql("""insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,gateway,gateway_charge_id)
 select tenant_id,id,subscriber_id,'manual',current_date,10000,'demo','legacy-demo-charge' from contracts limit 1;
 insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,gateway,gateway_charge_id)
 select tenant_id,id,subscriber_id,'manual',current_date,10000,'efi','legacy-real-charge' from contracts limit 1;
 insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source,gateway,gateway_payment_id)
 select tenant_id,id,4000,now(),'gateway_event',gateway,'legacy-'||gateway from invoices;
 insert into gateway_events(tenant_id,gateway,event_id,type,charge_id,payload,status)
 select tenant_id,gateway,'legacy-event-'||gateway,'payment.confirmed',gateway_charge_id,'{}','processed' from invoices;
 insert into gateway_events(gateway,event_id,type,charge_id,payload,status) values('demo','orphan','payment.confirmed','orphan','{}','unmatched');
 insert into demo_gateway_charges(tenant_id,charge_id,amount_cents) select tenant_id,gateway_charge_id,amount_cents from invoices where gateway='demo';
 insert into manual_payment_intents(tenant_id,intent_id,invoice_id,created_by,request_hash,result_status)
 select i.tenant_id,gen_random_uuid(),i.id,(select u.id from users u where u.tenant_id=i.tenant_id limit 1),'prior-intent','open' from invoices i where gateway='demo';""",'nexo_test')
 snapshot="""select jsonb_build_object(
 'invoices',(select jsonb_agg(to_jsonb(i)-'financial_connection_id' order by id) from invoices i),
 'payments',(select jsonb_agg(to_jsonb(p)-'financial_connection_id' order by id) from payments p),
 'events',(select jsonb_agg(to_jsonb(e)-'financial_connection_id' order by id) from gateway_events e),
 'intents',(select jsonb_agg(m order by intent_id) from manual_payment_intents m),
 'demo',(select jsonb_agg(to_jsonb(d)-'financial_connection_id'-'id' order by charge_id) from demo_gateway_charges d))"""
 before=sql(snapshot,'nexo_test');assert sql('select max(version_id) from goose_db_version','nexo_test')=='64'
 command(cli+['prepare'],cwd=target,env=env);command(cli+['prepare'],cwd=target,env=env)
 assert before==sql(snapshot,'nexo_test')
 assert sql('select count(*) from financial_connections','nexo_test')=='1'
 assert sql("select count(*) from invoices where gateway='demo' and financial_connection_id is not null",'nexo_test')=='1'
 assert sql("select count(*) from payments where gateway='demo' and financial_connection_id is not null",'nexo_test')=='1'
 # Four unknown bindings: real invoice/payment/event, and tenant-less orphan.
 assert sql('select count(*) from financial_connection_pending','nexo_test')=='4'
 assert sql("select count(*) from invoices where gateway='efi' and financial_connection_id is null",'nexo_test')=='1'
 history=(repo/'apps/api-go/internal/modules/leitura/queries/group91a4cc44_3.sql').read_text().replace('$1',"'efi'").replace('$2',"'legacy-real-charge'").replace('$3',"(select id from invoices where gateway='efi')")
 assert 'legacy-event-efi' in sql(history,'nexo_test')
 errors=[]
 def rejected(label,query,expected):
  try:sql(query,'nexo_test')
  except subprocess.CalledProcessError as e:
   assert expected in e.stderr,e.stderr;errors.append({'case':label,'error':e.stderr})
  else:raise AssertionError('unexpected acceptance: '+label)
 rejected('destructive down',(repo/'db/migrations/00065_financial_connections.sql').read_text().split('-- +goose Down')[1],'Preserve connections')
 rejected('old global lookup',"begin;set local role nexo_app;select gateway_charge_tenant('demo','legacy-demo-charge');rollback;",'permission denied')
 rejected('new unbound charge',"update invoices set gateway_charge_id='different-unknown' where gateway='efi'",'financial connection required')
 rejected('identity mutation',"update financial_connections set account_ref='another-account'",'connection identity is immutable')
 rejected('discard historical binding',"update invoices set financial_connection_id=null where gateway='demo'",'financial connection is immutable')
 assert before==sql(snapshot,'nexo_test')
 result={'ok':True,'from':64,'to':65,'historical_rows_and_manual_intents_preserved':True,'demo_backfilled':True,'pending_unknown_bindings':4,'repeat_prepare_noop':True,'legacy_unbound_history_visible':True,'expected_rejections':errors}
 (evidence/'financial-connections-migration.json').write_text(json.dumps(result,indent=2));print(result)
finally:
 subprocess.run(['docker','rm','-f','-v',DB_CONTAINER],check=True)
 temporary.cleanup()
