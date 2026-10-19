import test from "node:test";
import assert from "node:assert/strict";
import { deviceSchema, projectDevice } from "../features/network/models";
const id="11111111-1111-4111-8111-111111111111";
const device=deviceSchema.parse({id,name:'NAS do provedor',driver:'radius',host:null,api_port:null,credential_ref:null,agent_id:id,agent_name:'RADIUS integrado',agent_online:true,maintenance:false,simultaneous_use:null,acct_interim_seconds:null,last_check:null,last_check_at:null,accounts:'3',onus:'0',vendor:'mikrotik',nas_ip:'192.0.2.1',tunnel:null});
test('agente online e conta cadastrada não comprovam conectividade nem telemetria do NAS',()=>{
 const view=projectDevice(device);assert.equal(view.status,'Não verificado');assert.equal(view.cpu,null);assert.equal(view.latency,null);assert.equal(view.pop,'Não informado');assert.equal(view.ip,'192.0.2.1');assert.equal(projectDevice({...device,driver:'olt_huawei',vendor:'mikrotik'}).vendor,'Huawei');
 assert.equal(projectDevice({...device,last_check:{ok:false,detail:'Sem resposta'}}).status,'Atenção');
 assert.equal(projectDevice({...device,last_check:{ok:true,detail:'Verificado'}}).status,'Operacional');
 assert.equal(projectDevice({...device,maintenance:true,last_check:{ok:true}}).status,'Manutenção');
});
