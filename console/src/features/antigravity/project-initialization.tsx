import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccountView } from "../../../../src/providers/oauth/schema";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { AccountError } from "./account-error";
import {
  cacheAccounts,
  retryProjectInitialization,
} from "@/features/oauth-accounts/api";

export function ProjectInitialization({ account }: { account: AccountView }) {
  const cache = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryProjectInitialization(account.account_ref),
    onSuccess: (value) => cacheAccounts(cache, [value]),
  });
  const project = account.project_initialization;
  if (!project) return null;
  return (
    <div className="space-y-2 text-sm">
      {project.status === "pending" ? (
        <p role="status" className="text-muted-foreground">
          Google authorization is complete. Project setup continues in the
          background and can take several minutes. You can save this account and
          leave this page.
        </p>
      ) : (
        <>
          <AccountError
            error={project.error}
            verification={project.verification}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Retry project initialization
          </Button>
        </>
      )}
      {retry.error && <ErrorNotice error={retry.error} />}
    </div>
  );
}
