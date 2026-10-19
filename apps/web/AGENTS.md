# Aplicação oficial

Esta aplicação usa efetivamente o frontend do v0. Preserve suas camadas `domain`, `application`, `data`, `features`, `platform`, seus componentes e os estilos. A referência original está em `docs/novo-design-nexoISP` e o frontend anterior foi preservado em `apps/web-legacy`.

React, Vite e TypeScript são a plataforma ativa. Não reintroduza Next.js. Adapte dados operacionais por consultas e comandos HTTP tipados; não carregue o ERP inteiro no contrato demonstrativo `WorkspaceData`.

Verifique mudanças com `npm -w apps/web run typecheck`, `npm -w apps/web run build`, testes direcionados e uma checagem curta no navegador. Compare a demonstração com a referência visual antes de atribuir regressões à integração. Não execute auditorias extensas ou toda a suíte E2E sem necessidade.
