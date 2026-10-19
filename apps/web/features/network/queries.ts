import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { api } from "@/platform/erp-client";
import { agentSchema, deviceSchema } from "./models";
export function useDevices(){return useSWR('erp-devices',async()=>z.array(deviceSchema).parse(await api('/devices')),{refreshInterval:5000});}
export function useAgents(){return useSWR('erp-agents',async()=>z.array(agentSchema).parse(await api('/agents')),{refreshInterval:5000});}
export function useNetworkRefresh(){const {mutate}=useSWRConfig();return async()=>{await mutate(key=>typeof key==='string'?['erp-devices','erp-agents','erp-network-health','erp-radius-status','erp-noc','erp-dashboard-panels'].includes(key):Array.isArray(key)&&typeof key[0]==='string'&&['erp-service','erp-operations','erp-operation','erp-contract-states','erp-online','erp-diagnosis'].includes(key[0]));};}
