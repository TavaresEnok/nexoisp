import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { pool, closePool } from '../../legacy/fastify/src/db.ts';
import { buildApp } from '../../legacy/fastify/src/app.ts';
import { zUuid,zPage } from '../../legacy/fastify/src/validators.ts';
import { PERMISSIONS,moduleOf } from '../../legacy/fastify/src/auth.ts';
const schema=z.object({q:z.string().trim().max(100).optional(),status:z.enum(['active','inactive']).optional(),...zPage});
const cases=[{}, {limit:''},{limit:' '},{limit:'0x10'},{limit:'1e1'},{limit:'0b10'},{limit:'0o10'},
 {limit:'1.5'},{limit:'-1.5'},{limit:'Infinity'},{limit:'NaN'},{limit:'foo'},{limit:'5001'},{offset:'-1'},
 {q:'x'.repeat(101),status:'wrong',limit:'0',offset:'-1'}, {q:['a','b']},{status:['a','b']},{limit:['1','2']},
 {q:'\ufeff foo \ufeff'}, {q:'\u0085foo\u0085'},{q:'😀'.repeat(51)},{limit:'1_0'},{limit:'Inf'}, {limit:'+0x10'},
 {offset:'9007199254740992'}, {offset:'1e30'}, {limit:'0'}, {status:'ACTIVE'}];
const validators=cases.map(input=>{const r=schema.safeParse(input);return {input,ok:r.success,value:r.success?r.data:null,error:r.success?null:r.error.issues.map(i=>`${i.path.join('.')||'dados'}: ${i.message}`).join('; ')};});
const uuid=['invalid','00000000-0000-0000-0000-000000000000','AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA','12345678-1234-1234-1234-123456789012'].map(input=>{const r=zUuid.safeParse(input);return {input,ok:r.success}});
const row=(await pool().query(`select 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'::uuid uuid,
 '2026-01-02T03:04:05.123456Z'::timestamptz instant,'2026-01-02'::date date,
 9007199254740993::bigint bigint,12.50::numeric(10,2) numeric,null::text nullable,
 '<>&'::text html,array['a','b']::text[] texts,'{"z":1,"aa":2}'::jsonb object,
 '127.0.0.1'::inet inet,'10.0.0.0/8'::cidr cidr,7::int2 smallint,42::int4 integer,1.25::float8 float,true boolean,
 '2026-01-02 03:04:05.123456'::timestamp stamp,
 array['AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'::uuid] ids,
 '{"large":9007199254740993,"line":"x\u2028y"}'::jsonb "precision"`)).rows[0];
writeFileSync('tests/contrato/corpus/jsonx.json',JSON.stringify(row)+'\n');
writeFileSync('tests/contrato/corpus/zod/query.json',JSON.stringify({validators,uuid},null,2)+'\n');
const paths=['/api/subscribers','/api/contracts/x','/api/tickets','/api/portal/surveys','/api/reports/sla','/api/stock/items'];
writeFileSync('tests/contrato/corpus/auth.json',JSON.stringify({permissions:PERMISSIONS,modules:Object.fromEntries(paths.map(p=>[p,moduleOf(p)]))},null,2)+'\n');
const app=await buildApp();app.post('/__contract_body',async req=>req.body??{});
const bodies=[];
for (const [name,headers,payload] of [['malformed',{'content-type':'application/json'},'{'],['empty',{'content-type':'application/json'},''],['unsupported',{'content-type':'application/xml'},'<x/>'],['too_large',{'content-type':'application/json'},'"'+'x'.repeat(20*1024*1024)+'"']]){
 const r=await app.inject({method:'POST',url:'/__contract_body',headers,payload});bodies.push({name,status:r.statusCode,body:r.json()});
}
writeFileSync('tests/contrato/corpus/framework.json',JSON.stringify(bodies,null,2)+'\n');
await app.close();await closePool();
