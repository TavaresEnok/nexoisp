import Link from "@/platform/navigation/link";
import { ArrowUpRight, ChevronRight, Radio, Users } from "lucide-react";
import { Trend } from "@/components/workspace-ui";
export function OverviewMetric({
  title,
  value,
  icon: Icon,
  change,
  detail,
  href,
  down,
  neutral,
}: {
  title: string;
  value: string;
  icon: typeof Users;
  change: string;
  detail: string;
  href: string;
  down?: boolean;
  neutral?: boolean;
}) {
  return (
    <Link href={href} className="metric-card">
      <div className="metric-heading">
        <span>{title}</span>
        <Icon size={17} />
      </div>
      <div className="metric-main">
        <strong>{value}</strong>
        <Trend down={down} neutral={neutral}>
          {change}
        </Trend>
      </div>
      <p>{detail}</p>
      <span className="metric-arrow">
        <ArrowUpRight size={13} />
      </span>
    </Link>
  );
}
export function OverviewPriority({
  href,
  icon: Icon,
  tone,
  title,
  description,
  tag,
}: {
  href: string;
  icon: typeof Radio;
  tone: string;
  title: string;
  description: string;
  tag: string;
}) {
  return (
    <Link href={href} className="priority-row">
      <span className={`priority-icon tone-${tone}`}>
        <Icon size={18} />
      </span>
      <span className="priority-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="priority-tag">{tag}</span>
      <ChevronRight size={15} />
    </Link>
  );
}
