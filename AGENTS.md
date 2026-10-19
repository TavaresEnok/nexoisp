# Interface oficial do NexoISP

O frontend originado em `docs/novo-design-nexoISP` é a referência oficial e obrigatória de UI/UX. A aplicação em `apps/web` deve preservar seus componentes, layouts, estilos, fontes, identidade visual e interações. Adapte as funcionalidades do ERP Go à nova interface. Não substitua a interface do v0 pela interface antiga por conveniência de integração.

`apps/web-legacy` preserva o frontend anterior para consulta de contratos HTTP, comportamentos e cobertura funcional. Não importe suas páginas, componentes ou CSS para a aplicação oficial. `docs/novo-design-nexoISP` preserva a referência original; a evolução operacional acontece em `apps/web`.

Regras comerciais, validação, autorização, isolamento por provedor/POP e integrações permanecem no backend Go existente. Use autenticação real por cookie HttpOnly e proteção CSRF. Não acrescente backend duplicado, banco no navegador ou autenticação simulada.

Páginas demonstrativas devem ser identificadas e usar exclusivamente dados fictícios. Erro em API operacional nunca deve selecionar automaticamente seeds. Não misture registros fictícios com dados reais nem envie identificadores de demonstração a comandos reais.

Consulte `docs/integracao-v0/PLANO.md` e a matriz funcional para a situação efetiva da migração. Não declare a etapa 7 concluída sem cobertura validada das funcionalidades existentes, respeitando as limitações já documentadas do backend.
