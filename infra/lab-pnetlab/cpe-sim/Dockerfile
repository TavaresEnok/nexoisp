# Simulador de roteador de cliente (CPE TR-069) para o laboratório: projeto oficial genieacs-sim. Só laboratório, nunca produção.
FROM node:22-alpine
RUN wget -q -O- https://codeload.github.com/genieacs/genieacs-sim/tar.gz/refs/heads/master | tar xz && mv genieacs-sim-master /sim && cd /sim && npm install --omit=dev --no-audit --no-fund
WORKDIR /sim
ENTRYPOINT ["node", "genieacs-sim"]
