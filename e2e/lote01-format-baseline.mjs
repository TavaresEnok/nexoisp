import ts from 'typescript';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
const paths=['apps/web/features/admin/import-models.ts','apps/web/features/admin/import.tsx','apps/web/features/network/legal.tsx'];
function tree(file,source){
 const emitted=ts.transpileModule(source,{fileName:file,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,removeComments:true}}).outputText;
 const root=ts.createSourceFile(file+'.js',emitted,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 function visit(node){if(ts.isParenthesizedExpression(node))return visit(node.expression);const children=[];ts.forEachChild(node,x=>{children.push(visit(x))});return [node.kind,ts.isSourceFile(node)?null:(node.text??null),children]};return JSON.stringify(visit(root))
}
const originals=paths.map(p=>execFileSync('git',['show','HEAD:'+p],{encoding:'utf8'}));
execFileSync(process.execPath,['node_modules/prettier/bin/prettier.cjs','--write',...paths],{stdio:'inherit'});
const report=paths.map((p,i)=>({path:p,ast_unchanged:tree(p,originals[i])===tree(p,fs.readFileSync(p,'utf8'))}));
fs.writeFileSync(process.env.LAB_FORMAT_REPORT,JSON.stringify(report,null,2));if(report.some(x=>!x.ast_unchanged))throw Error('Formatter changed AST');console.log(JSON.stringify(report));
