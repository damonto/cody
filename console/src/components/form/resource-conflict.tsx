import { Button } from "@/components/ui/button";

export function ResourceConflict({
  conflict,
  reload,
}: {
  conflict: boolean;
  reload: () => void;
}) {
  if (!conflict) return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm"
    >
      <p>
        These settings changed elsewhere. Your edits are retained. Reload the
        saved values before editing again.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={reload}>
        Reload saved values
      </Button>
    </div>
  );
}
