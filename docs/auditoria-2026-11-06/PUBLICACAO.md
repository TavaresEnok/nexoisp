# Publicação preparada, sem implantação

## Cadeia confirmada após a configuração do ChatISP

Em 06/11/2026 o operador informou, e a leitura local confirmou, esta arquitetura:

```text
Internet / IP público compartilhado
  → Nginx central 10.10.0.10 (HTTPS público, roteamento por domínio)
  → Apache da VM 10.10.0.26:443 (VirtualHost por ServerName)
      → chatisp.tokstiloesporte.com → 127.0.0.1:8480 (ativo)
      → nexoisp.tokstiloesporte.com → porta exclusiva do Caddy NexoISP (pendente)
```

O Nginx central permanece como está. `zz-chatisp.conf` tem VirtualHosts 80/443, `ProxyPreserveHost On`, proxy HTTP para 8480 e WebSocket em `/api/panel/ws`. A validação privilegiada `apache2ctl -S` confirma ChatISP e PNETLab separados. O comando sem privilégio não consegue ler a chave privada e produz erro de certificado; não era ausência real da chave.

No NexoISP, os containers antigos `nexoisp-go-caddy-1`, `nexoisp-go-api-1` e `nexoisp-go-db-1` continuam parados. A configuração do container Caddy antigo publica `8080/tcp` em `0.0.0.0:18081`, mas não há listener ativo nessa porta. O Compose de desenvolvimento atual usa 18080; **essa porta está ocupada pelo Apache/PNETLab nesta VM**. A 3000 é desenvolvimento Vite. Nenhuma dessas observações define um serviço ativo aprovado para publicação.

O upstream correto deve ser **o Caddy exclusivo do NexoISP**, que serve `apps/web` e encaminha API ao serviço Go `api:8080`. Propõe-se `127.0.0.1:18380`, livre na conferência. A porta ainda precisa ser configurada no ambiente exclusivo; não é um destino já funcionando. Não usar 8480 (ChatISP), 18080 (PNETLab), 8080 de outro serviço nem reutilizar volumes de demonstração.

## VirtualHost preparado

Artefato revisável: [`infra/prod/apache/nexoisp.conf.example`](../../infra/prod/apache/nexoisp.conf.example). Inclui:

- `ServerName nexoisp.tokstiloesporte.com` em `*:443`;
- `ProxyPreserveHost On`, `ProxyRequests Off` e upstream de loopback exclusivo;
- esquema público HTTPS encaminhado explicitamente;
- passagem de upgrade WebSocket por `mod_rewrite`/`mod_proxy_wstunnel`;
- logs exclusivos e os certificados já usados no enlace interno Apache, sem confundi-los com o certificado público terminado no Nginx.

O Apache atual possui proxy/proxy_http/proxy_wstunnel/rewrite/ssl, mas **não tem `mod_headers` habilitado**, necessário para `RequestHeader`. A inclusão simples do candidato recusou essa diretiva. A sintaxe passou (`Syntax OK`) carregando o módulo **somente no processo de validação**, sem alterar a configuração ativa:

```bash
sudo apache2ctl -t \
  -C 'LoadModule headers_module /usr/lib/apache2/modules/mod_headers.so' \
  -c 'Include /home/enok/Documentos/projetos/NexoISP/infra/prod/apache/nexoisp.conf.example'
```

Isso valida sintaxe e disponibilidade do módulo, não a saúde do upstream ou a configuração ativa. O arquivo não foi copiado para `/etc/apache2`, habilitado ou recarregado. Não houve alteração em ChatISP/PNETLab/Nginx, nem inicialização do NexoISP. Habilitar `headers` e o novo site faz parte da implantação futura aprovada, depois dos gates da auditoria.

## Preparação do serviço e preservação da origem

1. Criar instalação/projeto/volumes exclusivos do piloto. Configurar segredos, MFA, certificados mTLS e `NEXO_PILOTO_FASE=1`; manter cobrança na origem, fiscal inativo e comandos de acesso manuais, sem avisos automáticos. Executar preflight.
2. Sobrescrever **a lista** de portas do serviço `caddy`, removendo os binds públicos 80/443 e deixando somente `127.0.0.1:18380:80`. Configurar `caddy.environment.NEXO_DOMAIN=:80`. Manter o domínio público da API em `NEXO_PUBLIC_URL=https://nexoisp.tokstiloesporte.com` e `NEXO_COOKIE_SECURE=1`; não derivar a origem pública de `:80` ou do endereço interno.
3. Configurar o Caddy para confiar somente no IP/CIDR do Apache visto pelo container, preservando esquema e cadeia de IP encaminhados. A API já usa `NEXO_TRUST_PROXY=1` e deve receber tráfego somente do Caddy. Não confiar em `0.0.0.0/0`, nem expor API 8080 ou listener interno 9090. No Apache, tratar cabeçalhos de origem confiável apenas do Nginx 10.10.0.10 e definir restrição/regras do enlace conforme a política existente, sem afetar os outros sites.
4. Conferir URLs absolutas/redirecionamentos e cookies na cadeia real. A origem pública é HTTPS mesmo havendo HTTP entre Apache e Caddy. Cookie HttpOnly/Secure/SameSite e proteção CSRF continuam no backend Go; não desabilitá-los para contornar o proxy.
5. Após o candidato passar nos gates, validar o upstream diretamente (`/login`, `/api/health`), habilitar somente o novo VirtualHost e validar a configuração completa antes de um reload controlado. Preservar o VirtualHost do ChatISP e o site padrão do PNETLab. Ter reversão específica para o novo site.

Não há endpoint WebSocket próprio no inventário atual do NexoISP. A passagem de upgrade foi preparada, mas só se pode comprovar handshake 101 em uma rota efetiva do candidato. Não encaminhar a rota do ChatISP ao NexoISP. mTLS de agentes (8443), WireGuard e RADIUS são canais separados e não devem ser publicados pelo VirtualHost HTTP.

## Aceite ainda necessário

Validar por fora da LAN: DNS/NAT e certificado público, domínio chegando ao VirtualHost correto, `/login`, `/api/health`, cookies, comando com CSRF aceito e sem CSRF recusado, anexos privados, cabeçalhos sem spoofing e URLs públicas. Revalidar ChatISP e PNETLab antes/depois da alteração específica. Guardar logs/resultados do novo VirtualHost. Não declarar publicação a partir de `configtest`.

Evidência anterior preservada: o domínio resolve para `177.104.156.25`; a tentativa anterior de HTTPS público foi recusada a partir desta VM (não distingue falha pública de hairpin/bloqueio local). Antes de existir VirtualHost NexoISP, o listener local com esse Host/SNI retornou 301 para `/store/public/admin/main/view`. A [lista externa única](PENDENCIAS-EXTERNAS.md) mantém os gates de CI, recuperação, implantação e piloto.
