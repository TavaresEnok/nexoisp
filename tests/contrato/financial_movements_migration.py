"""Upgrade 65->66 with explicit historical snapshots in a disposable cluster."""
from pathlib import Path
import os,sys,subprocess,shutil,json,base64,tempfile,uuid
repo=Path(__file__).resolve().parents[2]
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
os.environ['NEXO_CONTRATO_DB_CONTAINER']='nexo-b04-migration-'+uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT']='15691'
sys.path.insert(0,str(repo/'tests/contrato'))
from nativo import up
from lib import sql,go_env,command,DB_CONTAINER
cli=[str(repo/'apps/api-go/bin/nexo-db')]
with tempfile.TemporaryDirectory(prefix='nexo-b04-migration-') as tmp:
 stage=Path(tmp);shutil.copytree(repo/'db',stage/'db')
 for migration in (stage/'db/migrations').glob('*.sql'):
  if int(migration.name.split('_')[0])>65:migration.unlink()
 target=stage/'target66';shutil.copytree(repo/'db',target/'db')
 for migration in (target/'db/migrations').glob('*.sql'):
  if int(migration.name.split('_')[0])>66:migration.unlink()
 assert subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode!=0
 try:
  up();sql('create database nexo_test','postgres')
  env=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
  command(cli+['prepare'],cwd=stage,env=env);command(cli+['seed-demo'],cwd=stage,env=env)
  sql("""insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,fee_cents,discount_cents)
   select tenant_id,id,subscriber_id,'manual',current_date,10000,500,1000 from contracts limit 1;
   insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) select tenant_id,id,4000,now(),'manual' from invoices;
   insert into agreements(tenant_id,contract_id,subscriber_id,total_cents,original_cents,discount_cents,installments,reason)
   select tenant_id,contract_id,subscriber_id,5000,5500,500,1,'historical source unknown' from invoices;
   """,'nexo_test')
  snapshot="select jsonb_build_object('invoices',(select jsonb_agg(i order by id) from invoices i),'payments',(select jsonb_agg(p order by id) from payments p),'agreements',(select jsonb_agg(a order by id) from agreements a))"
  before=sql(snapshot,'nexo_test');assert sql('select max(version_id) from goose_db_version','nexo_test')=='65'
  command(cli+['prepare'],cwd=target,env=env);command(cli+['prepare'],cwd=target,env=env)
  assert before==sql(snapshot,'nexo_test')
  assert sql("select count(*) from invoice_movements where origin='opening'",'nexo_test')=='1'
  assert sql('select count(*) from financial_balance_shadow where matches and residual_cents=5500','nexo_test')=='1'
  assert sql("select count(*) from financial_balance_shadow where status='open' and matches",'nexo_test')=='1'
  assert sql('select count(*) from financial_agreement_shadow where source_unproven and not matches','nexo_test')=='1'
  assert sql('select count(*) from agreement_sources','nexo_test')=='0'
  # Owner-only synthetic drift remains visible and no cutover is performed.
  assert sql("begin;alter table invoices disable trigger invoice_movement_record;update invoices set discount_cents=0;select count(*) from financial_balance_shadow where not matches;rollback;",'nexo_test')=='1'
  assert before==sql(snapshot,'nexo_test')
  assert sql('select count(*) from financial_balance_shadow where not matches','nexo_test')=='0'
  result={'ok':True,'from':65,'to':66,'existing_rows_preserved':True,'opening_snapshot_explicit':True,'repeat_noop':True,'unknown_agreement_source_not_inferred':True,'shadow_detects_drift':True}
  output=repo/'tests/contrato/relatorios/financial-movements-migration.json';output.parent.mkdir(exist_ok=True);output.write_text(json.dumps(result,indent=2));print(result)
 finally:subprocess.run(['docker','rm','-f','-v',DB_CONTAINER],check=True)
