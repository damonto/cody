import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AccountCardsSkeleton({
  credentials,
}: {
  credentials: readonly { id: string }[];
}) {
  return (
    <>
      <span role="status" aria-label="Loading accounts" className="sr-only">
        Loading accounts…
      </span>
      {credentials.map((credential) => (
        <AccountCardSkeleton key={credential.id} />
      ))}
    </>
  );
}

function AccountCardSkeleton() {
  return (
    <Card aria-hidden="true" className="gap-4 shadow-none">
      <CardHeader className="flex justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="h-4 w-2/5" />
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-3 w-1/2" />
      </CardContent>
      <CardFooter className="justify-end gap-2 border-t pt-4">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="size-8" />
      </CardFooter>
    </Card>
  );
}
