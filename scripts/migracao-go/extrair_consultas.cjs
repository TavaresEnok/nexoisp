// Extraction of reviewed SQL-only read handlers. This does not translate business logic.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');const ts=require(path.join(root,'node_modules/typescript'));
const whitelist=[
'/api/contracts/:id/acceptances','/api/addons','/api/contracts/:id/addons','/api/anatel/municipalities',
'/api/subscribers/:id/contacts','/api/pops','/api/notice-channels','/api/notice-rules',
'/api/contracts/:id/discounts','/api/reports/referrals','/api/contracts/:id/scheduled-changes','/api/contracts/:id/amendments',
'/api/legal/ip-lookup/history','/api/leads/summary','/api/companies','/api/users/:id/pops','/api/subscribers/:id/documents',
'/api/tags','/api/maintenance-notices','/api/maintenance-notices/channels','/api/staff','/api/stock/items',
'/api/stock/items/:id/movements','/api/stock/items/:id/units','/api/stock/units/:id/events','/api/ftth/boxes',
'/api/contracts/:id/ftth','/api/sla-policies','/api/contracts/:id/install-address','/api/users',
'/api/import/batches','/api/import/batches/:id','/api/api-tokens','/api/webhook-endpoints',
'/api/ipam/pools','/api/ipam/pools/:id/allocations','/api/contracts/:id/ips','/api/ipam/pools/:id/delegations',
'/api/contracts/:id/ipv6','/api/contracts/:id/usage','/api/network/drift','/api/olt/discoveries','/api/onus',
'/api/install-kits','/api/work-orders/:id/helpers','/api/commission-rules',
'/api/agents','/api/devices','/api/notice-log','/api/subscribers/:id/notes','/api/stock/units',
'/api/catalogs','/api/custom-fields','/api/webhook-deliveries','/api/finance/summary'
];
const filters={
 '/api/notice-log':[{name:'limit',kind:'integer',fallback:100,min:1,max:500}],
 '/api/subscribers/:id/notes':[{name:'archived',kind:'flag',choices:['1']}],
 '/api/stock/units':[{name:'serial',kind:'string',trim:true,min:3,max:40},{name:'holder',kind:'uuid'},{name:'contract_id',kind:'uuid'}],
 '/api/catalogs':[{name:'kind',kind:'enum',choices:['ticket_type','classification','root_cause','origin','os_reason','end_reason','note_type']},{name:'all',kind:'flag',choices:['1']}],
 '/api/custom-fields':[{name:'entity',kind:'enum',choices:['subscriber','contract']},{name:'all',kind:'flag',choices:['1']}],
 '/api/webhook-deliveries':[{name:'endpoint_id',kind:'uuid'},{name:'status',kind:'enum',choices:['pending','sent','failed']}],
 '/api/finance/summary':[{name:'company_id',kind:'uuid'}],
};
const queriesDir=path.join(root,'apps/api-go/internal/modules/leitura/queries');const outputs={};const found=[];
for(const file of fs.readdirSync(path.join(root,'apps/api/src/routes')).filter(s=>s.endsWith('.ts'))){
 const source=fs.readFileSync(path.join(root,'apps/api/src/routes',file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),constants={};
 function collect(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)constants[n.name.text]=n.initializer;ts.forEachChild(n,collect);}collect(ast);
 for(const statement of ast.statements){
  if(!ts.isImportDeclaration(statement)||!statement.moduleSpecifier.text.startsWith('.'))continue;
  const imported=statement.importClause?.namedBindings;if(!imported||!ts.isNamedImports(imported))continue;
  const names=new Set(imported.elements.map(n=>(n.propertyName||n.name).text));
  const modulePath=path.resolve(root,'apps/api/src/routes',statement.moduleSpecifier.text.replace(/\.js$/,'.ts'));
  if(!fs.existsSync(modulePath))continue;
  const module=ts.createSourceFile(modulePath,fs.readFileSync(modulePath,'utf8'),ts.ScriptTarget.Latest,true);
  function imports(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&names.has(n.name.text)&&n.initializer)constants[n.name.text]=n.initializer;ts.forEachChild(n,imports);}imports(module);
 }

 function string(n,seen=[]){
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isNumericLiteral(n))return n.text;
  if(ts.isIdentifier(n)&&constants[n.text]&&!seen.includes(n.text))return string(constants[n.text],[...seen,n.text]);
  if(ts.isTemplateExpression(n)){let s=n.head.text;for(const span of n.templateSpans)s+=string(span.expression,seen)+span.literal.text;return s;}
  throw Error('SQL expression requires manual port: '+n.getText(ast));
 }
 function visit(n){
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(ast)==='app'&&n.expression.name.text==='get'&&whitelist.includes(n.arguments[0]?.text)){
   const route=n.arguments[0].text,handler=n.arguments[n.arguments.length-1],text=handler.getText(ast),queries=[];
   function query(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='query')queries.push(n);ts.forEachChild(n,query);}query(handler);
   if(queries.length!==1||!text.includes('req.ctx.scope'))throw Error('Reviewed shape changed: '+route);
   const call=queries[0],sql=string(call.arguments[0]);if(!/^\s*select\b/i.test(sql))throw Error('Not a read: '+route);
   const args=call.arguments[1]?.elements.map(n=>n.getText(ast))||[];
   const descriptors=args.map(a=>{if(a==='id'||a==='zUuid.parse((req.params as any).id)')return 'id';if(a==='req.ctx.tenantId')return 'tenant';if(/^q\.[a-z_]+(?: \?\? null)?$/.test(a))return 'query:'+a.split(/[. ]/)[1];if(/^!!q\.[a-z_]+$/.test(a))return 'query:'+a.slice(4);throw Error('Argument requires review: '+a);});
   const permission=n.arguments[1].getText(ast).match(/guard\('([^']+)'/)[1];
   const name='Read'+crypto.createHash('sha256').update(route).digest('hex').slice(0,8);
   outputs[path.join(queriesDir,name.toLowerCase()+'.sql')]='-- name: '+name+' :many\n'+sql+';\n';
   const item={path:route,permission,name,args:descriptors,file,filters:filters[route]||[],sha256:crypto.createHash('sha256').update(text).digest('hex')};
   if(route==='/api/leads/summary'||route==='/api/finance/summary')item.one=true;
   if(route==='/api/contracts/:id/install-address'){item.one=true;item.missing='contrato não encontrado';}
   if(route==='/api/contracts/:id/ftth'){item.one=true;item.wrap='drop';}
   if(route==='/api/contracts/:id/ipv6'){item.one=true;item.wrap='delegation';}
   found.push(item);
  }
  ts.forEachChild(n,visit);
 }visit(ast);
}
if(found.length!==whitelist.length)throw Error('Missing reviewed route');
found.sort((a,b)=>a.path.localeCompare(b.path));
outputs[path.join(root,'apps/api-go/internal/modules/leitura/consultas.json')]=JSON.stringify(found,null,2)+'\n';
let go='// Code generated by scripts/migracao-go/extrair_consultas.cjs. DO NOT EDIT.\npackage leitura\n\nimport gen "nexoisp/api-go/internal/modules/leitura/gen"\n\nvar consultas = []consulta{\n';
for(const r of found)go+=` {Path: ${JSON.stringify(r.path.replace(/:([^/]+)/g,'{$1}'))}, Permission: ${JSON.stringify(r.permission)}, SQL: gen.${r.name}, Args: []string{${r.args.map(JSON.stringify).join(',')}}, One: ${!!r.one}, Missing: ${JSON.stringify(r.missing||'')}, Wrap: ${JSON.stringify(r.wrap||'')}, Filters: []filter{${r.filters.map(f=>`{Name:${JSON.stringify(f.name)},Kind:${JSON.stringify(f.kind)},Trim:${!!f.trim},Min:${f.min||0},Max:${f.max===undefined?-1:f.max},Fallback:${f.fallback||0},Choices:[]string{${(f.choices||[]).map(JSON.stringify).join(',')}}}`).join(',')}}},\n`;
go+='}\n';outputs[path.join(root,'apps/api-go/internal/modules/leitura/consultas_generated.go')]=require('node:child_process').execFileSync('gofmt',[],{input:go,encoding:'utf8'});
const check=process.argv.includes('--check');
for(const [file,content] of Object.entries(outputs)){if(check){if(fs.readFileSync(file,'utf8')!==content)throw Error('Generated SQL/route drift: '+file);}else fs.writeFileSync(file,content);}
console.log(found.length+' consultas revisadas, SQL e handlers verificados');
