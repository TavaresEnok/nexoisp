FROM node:22.23.4-alpine AS web
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/web apps/web
RUN npm -w apps/web run build
FROM caddy:2-alpine
COPY --from=web /app/apps/web/dist /srv
COPY infra/prod/caddy/Caddyfile /etc/caddy/Caddyfile
