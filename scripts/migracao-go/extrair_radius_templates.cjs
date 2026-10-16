// Extract reviewed command text; the Go runtime renders these without JavaScript.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),ts=require(path.join(root,'node_modules/typescript'));
const source=fs.readFileSync(path.join(root,'apps/api/src/radius/vendor.ts'),'utf8');
const ast=ts.createSourceFile('vendor.ts',source,ts.ScriptTarget.Latest,true);
function unwrap(n){while(ts.isParenthesizedExpression(n)||ts.isNonNullExpression(n))n=n.expression;return n;}
function value(n){n=unwrap(n);if(ts.isStringLiteralLike(n))return n.text;
 if(ts.isTemplateExpression(n))return n.head.text+n.templateSpans.map(s=>value(s.expression)+s.literal.text).join('');
 if(ts.isPropertyAccessExpression(n))return '{{.'+n.getText(ast)+'}}';
 if(ts.isConditionalExpression(n)){
 const test=n.condition.getText(ast);if(test==="vendor === 'generic'")return '{{if eq .vendor "generic"}}'+value(n.whenTrue)+'{{else}}'+value(n.whenFalse)+'{{end}}';
 if(test==='tn')return '{{if .tn}}'+value(n.whenTrue)+'{{else}}'+value(n.whenFalse)+'{{end}}';
 }
 if(ts.isIdentifier(n)&&n.text==='vendor')return '{{.vendor}}';
 throw Error('Unreviewed command interpolation: '+n.getText(ast));}
function parts(array){return array.elements.map(n=>{
 if(ts.isSpreadElement(n)){let e=unwrap(n.expression);if(!ts.isConditionalExpression(e)||!ts.isArrayLiteralExpression(e.whenTrue)||!ts.isArrayLiteralExpression(e.whenFalse)||e.whenFalse.elements.length)throw Error('spread changed');
 const condition=e.condition.getText(ast);if(!['tn','o.secondary'].includes(condition))throw Error('condition changed');
 return {condition,lines:e.whenTrue.elements.map(value)};
 }return {lines:[value(n)]};});}
const templates={};
for(const name of ['setupCommands','l2tpCommands']){
 const f=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name);const variants={};
 for(const stmt of f.body.statements){let ret,variant='generic';
 if(ts.isIfStatement(stmt)&&ts.isReturnStatement(stmt.thenStatement)){
 const match=/^vendor === '(mikrotik|huawei|cisco)'$/.exec(stmt.expression.getText(ast));if(!match)continue;variant=match[1];ret=stmt.thenStatement;
 }else if(ts.isReturnStatement(stmt))ret=stmt;else continue;
 const e=ret.expression;if(!ts.isCallExpression(e)||e.arguments[0]?.text!=='\n'||!ts.isPropertyAccessExpression(e.expression)||e.expression.name.text!=='join'||!ts.isArrayLiteralExpression(e.expression.expression))throw Error('command return changed');
 variants[variant]=parts(e.expression.expression);
 }
 templates[name==='setupCommands'?'wireguard':'l2tp']=variants;
}
const output=JSON.stringify({source_sha256:crypto.createHash('sha256').update(source).digest('hex'),templates},null,2)+'\n';
const target=path.join(root,'apps/api-go/internal/modules/leitura/radius_commands.json');
if(process.argv.includes('--check')){if(fs.readFileSync(target,'utf8')!==output)throw Error('radius commands drift');}else fs.writeFileSync(target,output);
console.log('Comandos RADIUS extraídos: WireGuard, L2TP e quatro fabricantes');
