// Extract SQL only from reviewed write routes. Business rules and validation are implemented in Go.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),ts=require(path.join(root,'node_modules/typescript'));
const selected=["POST /api/auth/login", "POST /api/auth/logout", "POST /api/me/password", "POST /api/me/mfa/setup", "POST /api/me/mfa/enable", "POST /api/me/mfa/disable", "POST /api/tenants", "PATCH /api/tenants/:id", "POST /api/support/enter", "POST /api/support/exit", "POST /api/users", "PATCH /api/users/:id"];
const helpers={"identity.ts":["throttle","failed","cleared"]};
const outputs={},found=[];
for(const file of fs.readdirSync(path.join(root,'apps/api/src/routes')).filter(s=>s.endsWith('.ts'))){
 const source=fs.readFileSync(path.join(root,'apps/api/src/routes',file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),constants={};
 function collect(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)constants[n.name.text]=n.initializer;ts.forEachChild(n,collect);}collect(ast);
 function subscriberColumns(){const v=constants.SUB_COLS;return v.expression.elements.map(e=>e.text);}
 function str(n,seen=[]){
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isNumericLiteral(n))return n.text;
  if(ts.isIdentifier(n)){
   if(n.text==='OPEN_WO_SQL')return fs.readFileSync(path.join(root,'apps/api/src/sla.ts'),'utf8').match(/export const OPEN_WO = \[([^\]]+)\]/)[1].split(',').map(s=>s.trim()).join(',');
   if(n.text==='AGENT_OFFLINE_S')return fs.readFileSync(path.join(root,'apps/api/src/routes/network.ts'),'utf8').match(/AGENT_OFFLINE_S = (\d+)/)[1];
   if(constants[n.text]&&!seen.includes(n.text)){const value=str(constants[n.text],[...seen,n.text]);if(!value.startsWith('{{'))return value;}
   return '{{'+n.text+'}}';
  }
  if(ts.isTemplateExpression(n)){let s=n.head.text;for(const span of n.templateSpans)s+=str(span.expression,seen)+span.literal.text;return s;}
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=Number(str(n.left,seen)),b=Number(str(n.right,seen));if(Number.isFinite(a)&&Number.isFinite(b))return String(a+b);}
  const expression=n.getText(ast);
  if(expression==="SUB_COLS.join(', ')")return subscriberColumns().join(', ');
  if(expression==="SUB_COLS.map((_, i) => `$${i + 2}`).join(', ')")return subscriberColumns().map((_,i)=>'$'+(i+2)).join(', ');
  if(expression==="SUB_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')")return subscriberColumns().map((k,i)=>k+' = $'+(i+2)).join(', ');
  for(const columns of ['LEAD_COLS','cols']){
   if(expression===columns+".join(', ')"){const v=constants[columns];return (v.expression||v).elements.map(e=>e.text).join(', ');}
   for(const shift of [2,3])if(expression===columns+".map((_, i) => `$${i + "+shift+"}`).join(', ')"){const v=constants[columns];return (v.expression||v).elements.map((_,i)=>'$'+(i+shift)).join(', ');}
   if(expression===columns+".map((k, i) => `${k} = $${i + 2}`).join(', ')"){const v=constants[columns];return (v.expression||v).elements.map((k,i)=>k.text+' = $'+(i+2)).join(', ');}
  }
  if(ts.isCallExpression(n)){
   if(ts.isIdentifier(n.expression)&&n.expression.text==='within')return '('+str(n.arguments[0],seen)+' at time zone $3)::date between $1::date and $2::date';
   if(ts.isIdentifier(n.expression)&&n.expression.text==='hours')return 'round((extract(epoch from avg('+str(n.arguments[0],seen)+')) / 3600)::numeric, 1)::float';
   if(ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='replace')return str(n.expression.expression,seen).replace(str(n.arguments[0],seen),str(n.arguments[1],seen));
  }
  if(ts.isConditionalExpression(n)&&n.condition.getText(ast)==='finance')return '{{finance_overdue}}';
  return '{{'+seen[seen.length-1]+'}}';
 }
 function emit(key,node,permission=''){
  const queries=[];
  function query(q){
 if(ts.isCallExpression(q)&&ts.isIdentifier(q.expression)&&q.expression.text==='paged')queries.push(str(q.arguments[2]));
   if(ts.isCallExpression(q)&&ts.isPropertyAccessExpression(q.expression)&&q.expression.name.text==='query'){
    if(!(ts.isIdentifier(q.arguments[0])&&q.arguments[0].text==='sql'))queries.push(str(q.arguments[0]));
   }else if(ts.isCallExpression(q)&&ts.isIdentifier(q.expression)&&['one','q'].includes(q.expression.text)&&q.arguments[0]&&(ts.isStringLiteral(q.arguments[0])||ts.isNoSubstitutionTemplateLiteral(q.arguments[0])||ts.isTemplateExpression(q.arguments[0])))queries.push(str(q.arguments[0]));
   ts.forEachChild(q,query);
  }query(node);
  const hash=crypto.createHash('sha256').update(key).digest('hex').slice(0,8),files=[];
  queries.forEach((q,i)=>{if(key.endsWith("/location"))q=q.replace("{{table}}",key.includes("/contracts/")?"contracts":"pops");const file=hash+'_'+i+'.sql';files.push(file);outputs[path.join(root,'apps/api-go/internal/modules/identity/sql',file)]=q;});
  found.push({path:key,permission,file,queries:files,sha256:crypto.createHash('sha256').update(node.getText(ast)).digest('hex')});
 }
 function visit(n){
  if(selected.includes('PUT /api/contracts/:id/location')&&ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='put'&&n.arguments[0]?.getText(ast)==='`/api/${table}/:id/location`'){
   emit('PUT /api/contracts/:id/location',n.arguments[n.arguments.length-1],'contracts:write');
   emit('PUT /api/pops/:id/location',n.arguments[n.arguments.length-1],'network:write');
  }

  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(ast)==='app'&&selected.includes(n.expression.name.text.toUpperCase()+' '+n.arguments[0]?.text))emit(n.expression.name.text.toUpperCase()+' '+n.arguments[0].text,n.arguments[n.arguments.length-1],n.arguments[1].getText(ast).match(/guard\('([^']+)'/)?.[1]||'');
  if(ts.isFunctionDeclaration(n)&&n.name&&helpers[file]?.includes(n.name.text))emit('helper:'+n.name.text,n);
  if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&helpers[file]?.includes(n.name.text))emit('helper:'+n.name.text,n.initializer);
  ts.forEachChild(n,visit);
 }visit(ast);
}
if(found.length!==selected.length+Object.values(helpers).flat().length)throw Error('Missing reviewed complex route/helper: '+found.length);
outputs[path.join(root,'apps/api-go/internal/modules/identity/rotas.json')]=JSON.stringify(found,null,2)+'\n';
for(const [file,content] of Object.entries(outputs)){if(process.argv.includes('--check')){if(fs.readFileSync(file,'utf8')!==content)throw Error('Complex SQL drift: '+file);}else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}}
console.log(found.map(r=>[r.path,r.queries.length]));
