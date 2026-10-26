"""B07 additive 67->68 and dump/restore in an exclusively owned disposable DB."""
from pathlib import Path
import os,subprocess,shutil,json,base64,tempfile,uuid
assert os.environ.get('NEXO_PAYMENT_LAB')=='1'
repo=Path(__file__).resolve().parents[2]
os.environ['NEXO_CONTRATO_DB_CONTAINER']='nexo-b07-migration-'+uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT']='15694'
from nativo import up
from lib import sql,go_env,command,DB_CONTAINER,DB_PORT
cli=[str(repo/'apps/api-go/bin/nexo-db')]
with tempfile.TemporaryDirectory(prefix='nexo-b07-migration-') as tmp:
 stage=Path(tmp)/'before';stage.mkdir();shutil.copytree(repo/'db',stage/'db')
 target=Path(tmp)/'version68';target.mkdir();shutil.copytree(repo/'db',target/'db')
 for migration in (target/'db/migrations').glob('*.sql'):
  if int(migration.name.split('_')[0])>68:migration.unlink()
 for migration in (stage/'db/migrations').glob('*.sql'):
  if int(migration.name.split('_')[0])>67:migration.unlink()
 assert subprocess.run(['docker','inspect',DB_CONTAINER],capture_output=True).returncode!=0
 try:
  up();sql('create database nexo_test','postgres')
  env=dict(go_env('nexo_test'),NEXO_DEMO_MODE='1',NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
  command(cli+['prepare'],cwd=stage,env=env);command(cli+['seed-demo'],cwd=stage,env=env)
  sql("insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) select tenant_id,id,subscriber_id,'manual',current_date,12345 from contracts limit 1;",'nexo_test')
  snapshot="select jsonb_build_object('invoices',(select jsonb_agg(i order by id) from invoices i),'payments',(select jsonb_agg(p order by id) from payments p),'movements',(select jsonb_agg(m order by id) from invoice_movements m),'effects',(select jsonb_agg(e order by id) from payment_effects e))"
  before=sql(snapshot,'nexo_test')
  command(cli+['prepare'],cwd=target,env=env);command(cli+['prepare'],cwd=target,env=env)
  assert before==sql(snapshot,'nexo_test')
  assert sql('select count(*) from provider_issuance','nexo_test')=='0'
  sql("""insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name) select tenant_id,company_id,'efi','sandbox','fixture','Migration B07' from invoices;
   insert into provider_issuance(tenant_id,invoice_id,financial_connection_id,intent_key,request,config_hash)
   select i.tenant_id,i.id,c.id,'synthetic-intention','{}'::jsonb,repeat('a',64) from invoices i join financial_connections c on c.tenant_id=i.tenant_id and c.account_ref='fixture';
   update provider_issuance set state='uncertain';""",'nexo_test')
  journal=sql('select jsonb_agg(p order by id) from provider_issuance p','nexo_test')
  try:sql((repo/'db/migrations/00068_provider_issuance.sql').read_text().split('-- +goose Down')[1],'nexo_test')
  except subprocess.CalledProcessError as e:assert 'Preserve provider issuance' in e.stderr
  else:raise AssertionError('destructive downgrade accepted')
  try:sql("begin;set local role nexo_app;delete from provider_issuance;rollback;",'nexo_test')
  except subprocess.CalledProcessError as e:assert 'permission denied' in e.stderr
  else:raise AssertionError('application deletion accepted')
  # Logical recovery in another fresh DB; no claim of complete production restore.
  dump=command(['docker','exec',DB_CONTAINER,'pg_dump','-p',str(DB_PORT),'-U','nexo_owner','-d','nexo_test'],capture_output=True).stdout
  sql('create database nexo_contrato_novo','postgres')
  command(['docker','exec','-i',DB_CONTAINER,'psql','-X','-v','ON_ERROR_STOP=1','-p',str(DB_PORT),'-U','nexo_owner','-d','nexo_contrato_novo'],input=dump,capture_output=True)
  assert sql(snapshot,'nexo_contrato_novo')==before
  assert sql('select jsonb_agg(p order by id) from provider_issuance p','nexo_contrato_novo')==journal
  result={'ok':True,'from':67,'to':68,'financial_rows_preserved':True,'repeat_prepare':True,'destructive_down_rejected':True,'app_delete_rejected':True,'logical_restore_preserves_uncertain_journal':True,'physical_restore':False}
  path=repo/'tests/contrato/relatorios/provider-issuance-migration.json';path.parent.mkdir(exist_ok=True);path.write_text(json.dumps(result,indent=2));print(result)
 finally:subprocess.run(['docker','rm','-f','-v',DB_CONTAINER],check=True)
