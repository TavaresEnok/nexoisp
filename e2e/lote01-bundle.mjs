import {build} from 'vite';
import {writeFileSync} from 'node:fs';
const modules=[];
await build({root:'apps/web',configFile:'apps/web/vite.config.ts',build:{write:false},plugins:[{name:'audit-reachable-modules',generateBundle(_,bundle){for(const value of Object.values(bundle)){if(value.type==='chunk')for(const name of Object.keys(value.modules))modules.push(name)}}}]});
const suspects=['katex','mermaid','streamdown','shadcn','nanoid','body-parser','fast-uri','zod'];
const report=Object.fromEntries(suspects.map(name=>[name,modules.filter(p=>p.includes('/node_modules/'+name+'/')||p.includes('/node_modules/@streamdown/'))]));
writeFileSync(process.env.LAB_BUNDLE_REPORT,JSON.stringify({suspects:report,total_modules:modules.length,modules},null,2));
