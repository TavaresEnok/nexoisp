#!/usr/bin/env python3
"""Cada mutante precisa falhar em uma asserção funcional específica, nunca na compilação."""
from datetime import datetime, timezone
import json
import subprocess
import sys

from laboratorio import go
from lib import ROOT, go_env, sql

CASES={
 'tenant_do_cabecalho':('./internal/auth','TestTenantFromSession'),
 'sem_set_config':('./internal/db','TestPortalRLS'),
 'set_config_de_sessao':('./internal/db','TestScopeIsolationAndRollback'),
 'sem_pop':('./internal/db','TestPopRLS'),
 'sem_assinante':('./internal/db','TestPortalRLS'),
 'sem_csrf':('./internal/auth','TestTokenPrecedenceAndCSRF'),
 'sem_mfa':('./internal/auth','TestControlOrder'),
 'sem_modulo':('./internal/auth','TestControlOrder'),
 'cache_sem_invalidacao':('./internal/auth','TestCacheInvalidationAndDisconnect'),
 'sem_auditoria_negativa':('./internal/auth','TestControlOrder'),
 'limite_desligado':('./internal/auth','TestRate'),
 'numeric_numero':('./internal/jsonx','TestFastifyGolden'),
 'data_sem_ms':('./internal/jsonx','TestFastifyGolden'),
 'omitempty':('./internal/jsonx','TestFastifyGolden'),
 'zod_mensagem':('./internal/validate','TestZodGolden'),
}


def main():
    env=dict(go_env(),NEXO_GO_TEST_DATABASE_URL=go_env()['DATABASE_URL_GO'])
    # Só se o mesmo conjunto passa sem mutação, uma falha do mutante tem significado.
    go('test','./...',env=env)
    results=[]
    for name,(package,case) in CASES.items():
        try:
            go('test','-count=1','-tags','mutacao_'+name,'-run','^'+case+'$',package,env=env,capture_output=True)
        except subprocess.CalledProcessError as exc:
            output=(exc.stdout or '')+(exc.stderr or '')
            killed='--- FAIL: '+case in output and '[build failed]' not in output
        else:
            output='';killed=False
        results.append({'mutacao':name,'caso':case,'detectada':killed})
        print(name+': '+('detectada' if killed else 'SOBREVIVEU'),flush=True)
    # Credenciais privilegiadas são testadas somente até a recusa na partida.
    # Nenhuma requisição funcional roda com owner/SUPERUSER/BYPASSRLS.
    sql("do $$ begin if not exists(select 1 from pg_roles where rolname='nexo_mutante_bypass') then create role nexo_mutante_bypass login bypassrls password 'fase1-mutante-local'; end if; end $$; grant nexo_app,nexo_go to nexo_mutante_bypass;")
    for name,url in (('dono_do_banco',env['DATABASE_URL_OWNER']),('bypassrls',env['DATABASE_URL_GO'].replace('nexo_go:fase1-go-local','nexo_mutante_bypass:fase1-mutante-local'))):
        binary='bin/mutante-'+name;go('build','-tags','mutacao_'+name,'-o',binary,'./cmd/api',env=env)
        p=subprocess.run([str(ROOT/'apps/api-go'/binary)],env=dict(env,DATABASE_URL_GO=url),capture_output=True,text=True,timeout=20)
        killed=p.returncode!=0 and 'papel privilegiado ou dono de tabela' in p.stdout
        results.append({'mutacao':name,'caso':'recusa de partida antes de HTTP','detectada':killed})
        print(name+': '+('detectada' if killed else 'SOBREVIVEU'),flush=True)
    report={'total':len(results),'detectadas':sum(x['detectada'] for x in results),'resultados':results,
            'nao_aplicaveis':{'auditoria_fora_da_tx':'Nesta fase export.csv e access.denied já são transações próprias no Fastify; nenhuma escrita de negócio foi migrada.'}}
    dest=ROOT/'tests/contrato/relatorios'/('mutacoes-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    dest.with_suffix('.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    dest.with_suffix('.md').write_text('# Mutações fase 1\n\n'+'\n'.join('- '+x['mutacao']+': '+('detectada' if x['detectada'] else 'sobreviveu')+' por '+x['caso'] for x in results)+'\n')
    print(json.dumps({'total':report['total'],'detectadas':report['detectadas']}))
    return report['detectadas']!=report['total']


if __name__=='__main__':sys.exit(main())
