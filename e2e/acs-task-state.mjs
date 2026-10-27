import assert from 'node:assert/strict';
// A successful task POST is an acceptance only. Poll the durable journal and
// explicitly wake a readback lookup; never replay a remote mutation to settle it.
export async function waitAcsState(request,path,expected,{lookup=false}={}){
 let item;
 for(let i=0;i<100;i++){
  item=(await request(path,null,'GET'))[0];
  if(item?.state===expected)return item;
  if(lookup&&item?.state==='queued'){
   await request(`${path}/${item.id}/retry-lookup`,{reason:'Synthetic validation fresh readback lookup'});
   lookup=false;
  }
  assert.ok(!['review','rejected'].includes(item?.state),JSON.stringify(item));
  await new Promise(r=>setTimeout(r,200));
 }
 assert.fail(`ACS task did not reach ${expected}: ${JSON.stringify(item)}`);
}
