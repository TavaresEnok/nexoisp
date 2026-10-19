import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="table-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
export function ContextCallout({
  icon: Icon,
  title,
  danger = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Alert
      role="note"
      className={cn("context-callout", danger && "context-callout-danger")}
    >
      <Icon />
      <div>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{children}</AlertDescription>
      </div>
    </Alert>
  );
}
