import type { ReactNode } from "react";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccountCardFooter({
  title,
  index,
  count,
  pending,
  refreshDisabled,
  onRefresh,
  onConfigure,
  onMove,
  onRemove,
  children,
}: {
  title: string;
  index: number;
  count: number;
  pending: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  onConfigure: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  children?: ReactNode;
}) {
  return (
    <CardFooter className="flex-wrap justify-end gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={refreshDisabled}
        onClick={onRefresh}
      >
        <RefreshCw />
        Refresh
      </Button>
      {children}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={onConfigure}
      >
        Manage
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={pending}
            aria-label={`Account actions for ${title}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(-1)}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === count - 1}
            onSelect={() => onMove(1)}
          >
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            Remove account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </CardFooter>
  );
}
