import type { ComponentProps } from "react";
import { TableCell, TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const actionColumnClassName = "w-px text-right";

export function TableActionsHead({
  className,
  children,
  ...props
}: ComponentProps<typeof TableHead>) {
  return (
    <TableHead className={cn(actionColumnClassName, className)} {...props}>
      <span className="sr-only">{children}</span>
    </TableHead>
  );
}

export function TableActionsCell({
  className,
  ...props
}: ComponentProps<typeof TableCell>) {
  return (
    <TableCell className={cn(actionColumnClassName, className)} {...props} />
  );
}
