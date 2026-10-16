FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/web apps/web
RUN npm -w apps/web run build
FROM caddy:2-alpine
COPY --from=web /app/apps/web/dist /srv
COPY infra/prod/caddy/Caddyfile /etc/caddy/Caddyfile
COPY infra/prod/caddy/Caddyfile.go /etc/caddy/Caddyfile.go
