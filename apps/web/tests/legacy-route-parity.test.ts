import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonicalErpPath} from '../features/operations/navigation';
import {integrationStatus} from '../features/operations/status';
test('todos os destinos estáticos do ERP anterior possuem apresentação operacional no frontend oficial',()=>{
 const original=readFileSync('../web-legacy/src/App.tsx','utf8');
 const paths=[...original.matchAll(/<Route path="([^\"]+)"/g)].map(match=>match[1]).filter(path=>path!=='*'&&path!=='/login'&&!path.includes(':'));
 assert.ok(paths.length>=35,'O inventário de rotas de referência não foi lido integralmente.');
 for(const path of paths)assert.equal(integrationStatus(canonicalErpPath(path)),'connected',`Destino legado sem adaptação operacional: ${path}`);
});
