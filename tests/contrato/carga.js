import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
const fixtures=new SharedArray('sessões sintéticas',()=>JSON.parse(open('/lab/local/carga-fixtures.json')));
const duration=__ENV.DURATION||'30s';
export const options={
 discardResponseBodies:true,
 summaryTrendStats:['avg','p(95)','p(99)','max','count'],
 scenarios:{load:{executor:'constant-arrival-rate',rate:1000,timeUnit:'1s',duration,preAllocatedVUs:200,maxVUs:400}},
 thresholds:{http_req_failed:['rate==0'],checks:['rate==1'],dropped_iterations:['count==0']},
};
export default function(){
 const n=exec.scenario.iterationInTest;
 // Coprimo ao tamanho: percorre todos os provedores, papéis e transportes.
 const f=fixtures[(n*7919)%fixtures.length];const type=n%100;
 const path=type<45?'/api/subscribers/'+f.subscriber:type<85?'/api/contracts/'+f.contract:'/api/subscribers?limit=20&offset='+f.offset;
 const headers=f.cookie?{Cookie:'nexo_session='+f.token}:{Authorization:'Bearer '+f.token};
 const r=http.get('http://127.0.0.1:'+(18100+(n%4))+path,{headers,tags:{route:type<45?'subscriber':type<85?'contract':'list',transport:f.cookie?'cookie':'bearer'}});
 check(r,{'status 200':r=>r.status===200});
}
export function handleSummary(data){return {'/lab/local/carga-summary.json':JSON.stringify(data)}}
