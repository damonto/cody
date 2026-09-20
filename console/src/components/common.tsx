import { useState, type ReactNode } from "react";
import { tableFeatures, useTable, type ColumnDef } from "@tanstack/react-table";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  Inbox,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { label } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PageHeading({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {badge}
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
export function Loading() {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" />
      Loading…
    </div>
  );
}
export function ErrorNotice({
  error,
  retry,
}: {
  error: Error | string;
  retry?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>Unable to complete this request</AlertTitle>
      <AlertDescription>
        <p>{typeof error === "string" ? error : error.message}</p>
        {retry && (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 rounded-xl border bg-muted/50 p-3">
        <Inbox className="size-5 text-muted-foreground" />
      </div>
      <h3 className="font-medium">{title}</h3>
      <div className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Status({ value }: { value: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 capitalize font-normal",
        ["success", "reported", "complete", "published", "enabled"].includes(
          value,
        ) &&
          "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
        ["failed", "invalid"].includes(value) &&
          "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
        ["partial", "pending", "incomplete", "unpriced"].includes(value) &&
          "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label(value)}
    </Badge>
  );
}
export function CopyButton({
  value,
  title = "Copy",
}: {
  value: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={title}
      onClick={() =>
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            toast.success("Copied to clipboard");
          })
          .catch(() => toast.error("Clipboard unavailable"))
      }
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
export function Choice({
  value,
  onChange,
  options,
  label: title,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <Select
      value={value || "__all"}
      onValueChange={(next) => onChange(next === "__all" ? "" : next)}
    >
      <SelectTrigger aria-label={title} className={cn("min-w-36", className)}>
        <SelectValue placeholder={title} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value || "__all"}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export { fieldErrors } from "@/lib/form-errors";
const features = tableFeatures({});
export type DataColumn<T extends object> = ColumnDef<typeof features, T>;
export function DataTable<T extends object>({
  data,
  columns,
  empty = "No records found",
}: {
  data: T[];
  columns: DataColumn<T>[];
  empty?: string;
}) {
  const table = useTable({ features, data, columns });
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead
                key={header.id}
                colSpan={header.colSpan}
                className="h-11 bg-muted/30 text-xs"
              >
                <table.FlexRender header={header} />
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length ? (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className="h-14">
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={columns.length}>
              <Empty title={empty} />
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
export function DetailLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="link"
      className="h-auto p-0 text-foreground"
      onClick={onClick}
    >
      {children}
      <ArrowRight className="ml-1 size-3" />
    </Button>
  );
}
