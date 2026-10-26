"""B07 68->69: refusal of ambiguity, existing states, atomic binding and restore."""
from pathlib import Path
import os,subprocess,shutil,json,base64,tempfile,uuid
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
repo=Path(__file__).resolve().parents[2]
os.environ['NEXO_CONTRATO_DB_CONTAINER']='nexo-b07tx-migration-'+uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT']='15695'
from nativo import up
from lib import sql,go_env,command,DB_CONTAINER,DB_PORT
cli=[str(repo/'apps/api-go/bin/nexo-db')]
with tempfile.TemporaryDirectory(prefix='nexo-b07tx-migration-') as tmp:
 stage=Path(tmp);shutil.copytree(repo/'db',stage/'db')
 for migration in (stage/'db/migrations').glob('*.sql'):
  if int(migration.name.split('_')[0])>68:migration.unlink()
 assert subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode!=0
 try:
  up();sql('create database nexo_test','postgres')
  env=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
  command(cli+['prepare'],cwd=stage,env=env);command(cli+['seed-demo'],cwd=stage,env=env)
  sql("""insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,status_note)
   select tenant_id,id,subscriber_id,'manual','2026-11-15',12345,x from (select * from contracts limit 1) c cross join unnest(array['prepared','uncertain','issued','ambiguous']) x;
   insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name) select distinct tenant_id,company_id,'efi','sandbox','fixture','Migration B07tx' from invoices;
   insert into provider_issuance(tenant_id,invoice_id,financial_connection_id,intent_key,request,config_hash)
   select i.tenant_id,i.id,c.id,i.id::text,
    case when i.status_note='ambiguous' then '{}'::jsonb else jsonb_build_object('invoice_id',i.id,'intent_key',i.id,'scope',jsonb_build_object('tenant_id',i.tenant_id,'connection_id',c.id,'provider','efi','environment','sandbox','account_ref',c.account_ref),'money',jsonb_build_object('amount_cents',i.amount_cents,'currency','BRL'),'due_date',i.due_date) end,repeat('a',64)
   from invoices i join financial_connections c on c.tenant_id=i.tenant_id and c.account_ref='fixture';
   update provider_issuance j set state='uncertain' from invoices i where i.id=j.invoice_id and i.status_note in ('uncertain','issued');
   update provider_issuance j set state='issued',charge_id='legacy-issued' from invoices i where i.id=j.invoice_id and i.status_note='issued';""",'nexo_test')
  unchanged="select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(i)-'provider_issuance_id' order by id) from invoices i),'journal',(select jsonb_agg(j order by id) from provider_issuance j))"
  before_failure=sql(unchanged,'nexo_test')
  try:command(cli+['prepare'],cwd=repo,env=env,capture_output=True)
  except subprocess.CalledProcessError as e:assert 'reconcile at version 68' in e.stderr+e.stdout
  else:raise AssertionError('ambiguous old request silently upgraded')
  assert before_failure==sql(unchanged,'nexo_test')
  assert sql("select count(*) from information_schema.columns where table_name='invoices' and column_name='provider_issuance_id'",'nexo_test')=='0'
  # Repair only the deliberately malformed synthetic fixture, still at version68.
  sql("""delete from provider_issuance where invoice_id in(select id from invoices where status_note='ambiguous');
   insert into provider_issuance(tenant_id,invoice_id,financial_connection_id,intent_key,request,config_hash)
    select i.tenant_id,i.id,c.id,i.id::text,jsonb_build_object('invoice_id',i.id,'intent_key',i.id,'scope',jsonb_build_object('tenant_id',i.tenant_id,'connection_id',c.id,'provider','efi','environment','sandbox','account_ref',c.account_ref),'money',jsonb_build_object('amount_cents',i.amount_cents,'currency','BRL'),'due_date',i.due_date),repeat('a',64)
    from invoices i join financial_connections c on c.tenant_id=i.tenant_id and c.account_ref='fixture' where i.status_note='ambiguous';""",'nexo_test')
  financial="select jsonb_build_object('invoices',(select jsonb_agg(jsonb_build_object('id',id,'status',status,'amount',amount_cents,'fee',fee_cents,'discount',discount_cents,'due',due_date) order by id) from invoices),'payments',(select jsonb_agg(p order by id) from payments p),'movements',(select jsonb_agg(m order by id) from invoice_movements m),'effects',(select jsonb_agg(e order by id) from payment_effects e))"
  before=sql(financial,'nexo_test')
  command(cli+['prepare'],cwd=repo,env=env);command(cli+['prepare'],cwd=repo,env=env)
  assert before==sql(financial,'nexo_test')
  assert sql('select count(*) from invoices where provider_issuance_id is not null','nexo_test')=='4'
  assert sql("select gateway_charge_id from invoices where status_note='issued'",'nexo_test')=='legacy-issued'
  assert sql("select count(*) from invoices where status_note in ('prepared','uncertain') and gateway_charge_id is null",'nexo_test')=='2'
  sql("update provider_issuance j set state='issued',charge_id='recovered-charge' from invoices i where i.id=j.invoice_id and i.status_note='uncertain'",'nexo_test')
  assert sql("select gateway_charge_id from invoices where status_note='uncertain'",'nexo_test')=='recovered-charge'
  assert before==sql(financial,'nexo_test')
  try:sql((repo/'db/migrations/00069_provider_issuance_reservation.sql').read_text().split('-- +goose Down')[1],'nexo_test')
  except subprocess.CalledProcessError as e:assert 'Preserve issuance reservations' in e.stderr
  else:raise AssertionError('unsafe down allowed')
  snapshot=sql(unchanged,'nexo_test')
  dump=command(['docker','exec',DB_CONTAINER,'pg_dump','-p',str(DB_PORT),'-U','nexo_owner','-d','nexo_test'],capture_output=True).stdout
  sql('create database nexo_contrato_novo','postgres')
  command(['docker','exec','-i',DB_CONTAINER,'psql','-X','-v','ON_ERROR_STOP=1','-p',str(DB_PORT),'-U','nexo_owner','-d','nexo_contrato_novo'],input=dump,capture_output=True)
  assert snapshot==sql(unchanged,'nexo_contrato_novo')
  assert sql('select count(*) from invoices where provider_issuance_id is not null','nexo_contrato_novo')=='4'
  result={'ok':True,'from':68,'to':69,'ambiguous_upgrade_rolls_back':True,'prepared_uncertain_issued_preserved':True,'legacy_issued_bound':True,'transition_binds_atomically':True,'financial_rows_unchanged':True,'logical_restore':True,'physical_restore':False,'down_rejected':True}
  path=repo/'tests/contrato/relatorios/provider-issuance-reservation-migration.json';path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(result,indent=2));print(result)
 except subprocess.CalledProcessError as e:
  print('LAB COMMAND FAILED',e.stderr,e.stdout);raise
 finally:subprocess.run(['docker','rm','-f','-v',DB_CONTAINER],check=True)
