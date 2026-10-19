import { lazy, Suspense } from "react";
import { QueryBoundary } from "@/features/shared/feedback";
const SubscriberTickets=lazy(()=>import("./tickets").then(module=>({default:module.SubscriberTickets})));
export function LazySubscriberTickets({id}:{id:string}){return <Suspense fallback={<QueryBoundary loading>{null}</QueryBoundary>}><SubscriberTickets id={id} /></Suspense>;}
