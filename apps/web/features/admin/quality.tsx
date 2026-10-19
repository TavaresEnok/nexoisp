import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeading } from '@/components/workspace-ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { QueryBoundary } from '@/features/shared/feedback';
import { useSession } from '@/features/session/provider';
import { can, hasModule } from '@/features/session/model';
const Catalogs=lazy(()=>import('./quality-catalogs').then(m=>({default:m.Catalogs})));
const CustomDefinitions=lazy(()=>import('./quality-catalogs').then(m=>({default:m.CustomDefinitions})));
const SlaPolicies=lazy(()=>import('./quality-sla').then(m=>({default:m.SlaPolicies})));
const Satisfaction=lazy(()=>import('./quality-sla').then(m=>({default:m.Satisfaction})));
const InstallKits=lazy(()=>import('./quality-incentives').then(m=>({default:m.InstallKits})));
const Commissions=lazy(()=>import('./quality-incentives').then(m=>({default:m.Commissions})));
export function QualityAdministration(){const {me}=useSession();const [params,setParams]=useSearchParams();const choices=[{id:'catalogos',label:'Catálogos',component:Catalogs},{id:'sla',label:'SLA',component:SlaPolicies},...(hasModule(me,'field')?[{id:'satisfacao',label:'Satisfação',component:Satisfaction}]:[]),{id:'campos',label:'Campos personalizados',component:CustomDefinitions},...(hasModule(me,'field')&&can(me,'stock:read')?[{id:'kits',label:'Kits de instalação',component:InstallKits}]:[]),...(can(me,'finance:read')?[{id:'comissoes',label:'Comissões',component:Commissions}]:[])];const selected=choices.find(tab=>tab.id===params.get('aba'))??choices[0];const Content=selected.component;return <><PageHeading title="Catálogos, SLA e qualidade" description="Configurações de atendimento, instalação e acompanhamento do provedor." /><Tabs value={selected.id} onValueChange={value=>setParams(previous=>{previous.set('aba',String(value));return previous;})}><div className="overflow-x-auto"><TabsList aria-label="Configurações de qualidade">{choices.map(tab=><TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>)}</TabsList></div><TabsContent value={selected.id}><Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}><Content /></Suspense></TabsContent></Tabs></>;}
