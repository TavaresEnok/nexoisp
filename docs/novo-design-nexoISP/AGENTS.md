## Frontend independente

React 19, Vite 6 e TypeScript. A entrada ativa é `index.html` → `src/main.tsx`; as rotas usam o resolvedor existente e o adaptador React Router em `platform/navigation`.

Preserve os componentes, o design e as camadas `domain`, `application`, `data`, `features` e `platform`. O modo demonstrativo usa os leitores locais existentes; não adicione endpoints, autenticação simulada ou acesso a banco no navegador. O legado Next.js e as integrações de servidor antigas foram removidos; os seeds compartilhados em `lib/db` continuam alimentando o frontend. Não recrie a pasta `app`, configurações Next.js ou pontes de compatibilidade: desenvolvimento, build e preview usam exclusivamente Vite.

Verificações essenciais: `pnpm typecheck`, `pnpm build` e uma checagem curta das áreas principais no navegador. Não execute as auditorias extensas em `.v0` nem toda a suíte E2E sem solicitação explícita.
