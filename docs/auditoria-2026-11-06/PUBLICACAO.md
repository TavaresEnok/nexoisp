# Publicação preparada, sem implantação

Conferência em 06/11/2026: `nexoisp.tokstiloesporte.com` resolve para `177.104.156.25`. A conexão TCP/HTTPS a esse endereço foi recusada a partir de `10.10.0.26`; isso não distingue indisponibilidade pública de bloqueio/hairpin no caminho local. No listener local, usando esse Host/SNI, HTTP e HTTPS respondem 301 para `/store/public/admin/main/view` (interface do PNETLab). A conferência local de HTTPS ignorou a validação do certificado somente para identificar a resposta, não para homologar TLS. Containers antigos `nexoisp-go-api-1`, `nexoisp-go-caddy-1` e `nexoisp-go-db-1` estão parados. Nenhum serviço foi iniciado.

O destino deve ser **o Caddy do NexoISP**, que serve `apps/web` e encaminha API ao serviço `api:8080` em `infra/prod/docker-compose.yml`. PNETLab e a porta 8080 de outro serviço não são upstreams do ERP. Não há destino ativo validado a publicar nesta missão. A porta 18380 abaixo é uma proposta; confirmar disponibilidade no dia da implantação.

Configuração proposta para terminar TLS no proxy compartilhado, após aprovação e validação do candidato:

1. Criar instalação/projeto exclusivo do piloto, sem reutilizar volumes demo. Configurar segredos, domínio, banco, certificados mTLS e `NEXO_PILOTO_FASE=1`; manter decisões de ESTADO e executar preflight.
2. No Compose exclusivo, sobrescrever **a lista** de portas de `caddy`, removendo 80/443 públicos e deixando apenas `127.0.0.1:18380:80`. Não basta acrescentar uma porta à lista herdada. Configurar `caddy.environment.NEXO_DOMAIN=:80`, mantendo a API com `NEXO_PUBLIC_URL=https://nexoisp.tokstiloesporte.com` e `NEXO_COOKIE_SECURE=1`. A configuração padrão sem proxy continua válida para um host exclusivo que disponha de 80/443.
3. No Caddy interno, configurar `servers { trusted_proxies static <IP/CIDR exato do proxy visto pelo container> }` no bloco global, preservando a origem e o esquema encaminhados. Confirmar esse IP na rede da instalação; não confiar em `0.0.0.0/0`. A API já usa `NEXO_TRUST_PROXY=1` e só deve receber tráfego do Caddy. Não expor 8080/9090.
4. Criar **um virtual host exclusivo**, mantendo os demais virtual hosts, upstreams e serviços. Exemplo Nginx abaixo; adaptar ao proxy realmente administrado no destino. Não foi aplicado nem validado contra a configuração compartilhada.

```nginx
# Contexto http (uma única vez):
map $http_upgrade $nexo_connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 80;
    server_name nexoisp.tokstiloesporte.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name nexoisp.tokstiloesporte.com;
    ssl_certificate     /CAMINHO/APROVADO/fullchain.pem;
    ssl_certificate_key /CAMINHO/APROVADO/privkey.pem;
    client_max_body_size 16m;
    location / {
        proxy_pass http://127.0.0.1:18380;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $nexo_connection_upgrade;
        proxy_read_timeout 75s;
    }
}
```

O Caddy suporta upgrade em `reverse_proxy`; o inventário atual da aplicação não expõe endpoint WebSocket próprio. A configuração mantém passagem de upgrade sem declarar uma funcionalidade inexistente. mTLS dos agentes (8443), WireGuard e RADIUS são canais separados: não encaminhá-los pelo virtual host HTTP e não os abrir sem necessidade do piloto.

Aceite da publicação: DNS/NAT vistos de uma rede externa; certificado válido para o domínio; `/login` do NexoISP; `/api/health`; cookie HttpOnly/Secure/SameSite; comando com CSRF aceito e sem CSRF recusado; anexos privados; origem e IP encaminhados sem spoofing; logs do virtual host exclusivo; se houver futuro endpoint WebSocket, handshake 101 na rota efetiva. Guardar saídas de validação de Compose, Caddy e proxy antes de qualquer reload. O operador do proxy precisa aprovar a mudança concreta. Não alterar ChatISP/PNETLab durante a auditoria.
