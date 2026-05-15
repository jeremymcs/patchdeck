import { Fragment, type ReactNode } from "react";

export type MetaItem = {
  key: string;
  content: ReactNode;
};

export function MetaBreadcrumb({ items }: { items: MetaItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((item, idx) => (
        <Fragment key={item.key}>
          {idx > 0 && <span className="text-border" aria-hidden="true">·</span>}
          {item.content}
        </Fragment>
      ))}
    </div>
  );
}
