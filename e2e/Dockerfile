FROM node:22.23.4-bookworm-slim AS node
FROM mcr.microsoft.com/playwright:v1.55.1-jammy
# Keep Chromium and its system libraries, align JS runtime with .nvmrc/CI.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && test "$(node --version)" = "v22.23.4" \
    && test "$(npm --version)" = "10.9.9"
