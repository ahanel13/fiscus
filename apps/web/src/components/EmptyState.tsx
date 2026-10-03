import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-14 text-center">
      <span className="rounded-full bg-surface-2 p-3">
        <Icon aria-hidden className="size-6 text-muted" />
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="space-y-3 text-sm text-muted">{children}</div>
    </div>
  );
}
