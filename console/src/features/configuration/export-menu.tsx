import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, FileDown } from "lucide-react";
import { read, rpc, type Draft } from "@/lib/api";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function downloadJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(value, null, 2)}\n`], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

export function ExportMenu({ snapshot }: { readonly snapshot: Draft }) {
  const [confirming, setConfirming] = useState(false);
  const fileName = `cody-config-draft-${snapshot.version}.json`;
  const exportSecrets = useMutation({
    mutationFn: () =>
      read(rpc.config.export.$post({ json: { version: snapshot.version } })),
    onSuccess: (config) => {
      downloadJson(config, fileName);
      setConfirming(false);
    },
  });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <FileDown />
            Export JSON
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => downloadJson(snapshot.config, fileName)}
          >
            Secrets masked
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              exportSecrets.reset();
              setConfirming(true);
            }}
          >
            Include secrets…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!exportSecrets.isPending) setConfirming(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Export with plaintext secrets?</AlertDialogTitle>
            <AlertDialogDescription>
              The file will contain client API keys, upstream credentials, proxy
              passwords, and the search API key in plaintext. OAuth tokens are
              never exported. Store it securely and delete it when you no longer
              need it. This export is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {exportSecrets.error && <ErrorNotice error={exportSecrets.error} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={exportSecrets.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={exportSecrets.isPending}
              onClick={(event) => {
                event.preventDefault();
                exportSecrets.mutate();
              }}
            >
              Export with secrets
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
