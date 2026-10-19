'use client'

import { useSyncExternalStore, type ReactNode } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'

const subscribe = (callback: () => void) => {
  const media = window.matchMedia('(max-width: 700px)')
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}
export function ResponsiveSidebar({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) {
  const mobile = useSyncExternalStore(subscribe, () => window.matchMedia('(max-width: 700px)').matches, () => false)
  if (mobile) return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side="left" className="mobile-sidebar"><SheetHeader className="sr-only"><SheetTitle>Navegação do workspace</SheetTitle><SheetDescription>Escolha uma área da operação do seu provedor.</SheetDescription></SheetHeader>{children}</SheetContent></Sheet>
  return <aside className="app-sidebar" aria-label="Navegação principal">{children}</aside>
}
