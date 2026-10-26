"""B05 migration 66->67: no retroactive technical actions, transactional cycles."""
from pathlib import Path
import os,sys,subprocess,shutil,json,base64,tempfile,uuid
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
repo=Path(__file__).resolve().parents[2]
os.environ['NEXO_CONTRATO_DB_CONTAINER']='nexo-b05-migration-'+uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT']='15693'
from nativo import up
from lib import sql,go_env,command,DB_CONTAINER
cli=[str(repo/'apps/api-go/bin/nexo-db')]
with tempfile.TemporaryDirectory(prefix='nexo-b05-migration-') as tmp:
 stage=Path(tmp);shutil.copytree(repo/'db',stage/'db')
 for migration in (stage/'db/migrations').glob('*.sql'):
  if int(migration.name.split('_')[0])>66:migration.unlink()
 assert subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode!=0
 try:
  up();sql('create database nexo_test','postgres')
  env=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
  command(cli+['prepare'],cwd=stage,env=env);command(cli+['seed-demo'],cwd=stage,env=env)
  sql("""insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,status)
   select tenant_id,id,subscriber_id,'manual',current_date,10000,'paid' from contracts limit 1;
   insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) select tenant_id,id,10000,now(),'manual' from invoices;""",'nexo_test')
  snapshot="select jsonb_build_object('invoices',(select jsonb_agg(to_jsonb(i)-'settlement_version' order by id) from invoices i),'payments',(select jsonb_agg(p order by id) from payments p),'movements',(select jsonb_agg(m order by id) from invoice_movements m))"
  before=sql(snapshot,'nexo_test')
  command(cli+['prepare'],cwd=repo,env=env);command(cli+['prepare'],cwd=repo,env=env)
  assert before==sql(snapshot,'nexo_test')
  # Preserve the current importer contract: an inserted historical paid title
  # must not request network work. Rollback isolates it from the cycle counts.
  imported=sql("begin;insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,status,external_source,external_id) select tenant_id,contract_id,subscriber_id,'manual',current_date,10000,'paid','b05-history','legacy-paid' from invoices limit 1;select count(*) from payment_effects;rollback;",'nexo_test')
  assert imported=='0',imported

  assert sql('select count(*) from payment_effects','nexo_test')=='0'
  sql("begin;update invoices set status='open';update invoices set status='paid';rollback;",'nexo_test')
  assert sql('select count(*) from payment_effects','nexo_test')=='0'
  sql("update invoices set status='open';update invoices set status='paid';update invoices set status='paid';",'nexo_test')
  assert sql('select count(*) from payment_effects','nexo_test')=='1'
  assert sql('select settlement_version from invoices','nexo_test')=='1'
  sql("update invoices set status='open';update invoices set status='paid'",'nexo_test')
  assert sql('select count(*) from payment_effects','nexo_test')=='2'
  assert sql('select settlement_version from invoices','nexo_test')=='2'
  try:sql((repo/'db/migrations/00067_payment_effects.sql').read_text().split('-- +goose Down')[1],'nexo_test')
  except subprocess.CalledProcessError as e:assert 'Preserve payment effects' in e.stderr
  else:raise AssertionError('destructive down accepted')
  for query in ['delete from payment_effects','insert into payment_effects(tenant_id,invoice_id,settlement_version) select tenant_id,id,3 from invoices']:
   try:sql('begin;set local role nexo_app;'+query+';rollback;','nexo_test')
   except subprocess.CalledProcessError as e:assert 'permission denied' in e.stderr
   else:raise AssertionError('effect history mutation accepted')
  result={'ok':True,'from':66,'to':67,'historical_rows_preserved':True,'no_retroactive_effects':True,'new_paid_import_does_not_request_network':True,'rollback_atomic':True,'one_event_per_settlement_transition':True,'down_and_app_forgery_rejected':True}
  output=repo/'tests/contrato/relatorios/payment-effects-migration.json';output.parent.mkdir(exist_ok=True);output.write_text(json.dumps(result,indent=2));print(result)
 finally:subprocess.run(['docker','rm','-f','-v',DB_CONTAINER],check=True)
