import { ConsumeResetCode } from "../../../../src/providers/oauth/values.ts";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  AccountView,
  ConsumeResetResult,
} from "../../../../src/providers/oauth/schema";
import { date } from "@/lib/format";
import { ErrorNotice, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
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
import {
  accountHealthOptions,
  cacheAccounts,
  consumeResetCredit,
  refreshResetCredits,
} from "@/features/oauth-accounts/api";
import { creditExpiry, usableCredits } from "./status";

const RESULT_MESSAGES: Readonly<Record<ConsumeResetResult["code"], string>> = {
  reset: "Usage limits were reset.",
  already_redeemed: "This reset was already applied.",
  nothing_to_reset: "Nothing to reset: no usage window is exhausted.",
  no_credit: "No reset credit is available for this account.",
};

/** Confirms before spending one reset credit, because each is a real entitlement. */
export function ResetCreditsDialog({
  account,
  label,
  now,
  open,
  onOpenChange,
}: {
  account: AccountView;
  label: string;
  now: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cache = useQueryClient();
  // One idempotency key per confirmation, so a retried request never spends twice.
  const [attempt, setAttempt] = useState<{
    redeemId: string;
    creditId: string;
  } | null>(null);
  const credits = useQuery({
    queryKey: ["codex-reset-credits", account.account_ref],
    queryFn: async () => {
      const view = await refreshResetCredits(account.account_ref);
      await cacheAccounts(cache, [view]);
      return view.quota.reset_credits ?? null;
    },
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  const list = credits.data ?? account.quota.reset_credits ?? null;
  const usable = usableCredits(list?.credits ?? [], now);
  const selectedCreditId = attempt?.creditId ?? usable[0]?.id;
  const consume = useMutation({
    mutationFn: (request: { redeemId: string; creditId: string }) =>
      consumeResetCredit(
        account.account_ref,
        request.redeemId,
        request.creditId,
      ),
    onSuccess: async (reply) => {
      await cacheAccounts(cache, [reply.account]);
      void cache.invalidateQueries({
        queryKey: accountHealthOptions("codex").queryKey,
      });
      void cache.invalidateQueries({
        queryKey: ["codex-reset-credits", account.account_ref],
      });
      const message = RESULT_MESSAGES[reply.result.code];
      if (
        reply.result.code === ConsumeResetCode.Reset ||
        reply.result.code === ConsumeResetCode.AlreadyRedeemed
      )
        toast.success(message);
      else toast.warning(message);
      setAttempt(null);
      onOpenChange(false);
    },
  });
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (consume.isPending) return;
        if (!value) consume.reset();
        onOpenChange(value);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Use a reset on {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This spends one rate-limit reset credit and cannot be undone. The
            account&apos;s exhausted windows restart now, its cooldown clears
            and its quota refreshes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {credits.isFetching && !list && <Loading />}
        {credits.error && (
          <ErrorNotice
            error={credits.error}
            retry={() => void credits.refetch()}
          />
        )}
        {list?.error && (
          <p role="alert" className="text-xs text-destructive">
            {list.error}
          </p>
        )}
        {list && (
          <div className="space-y-2 text-sm">
            <p>
              {usable.length} of {list.credits.length} credit
              {list.credits.length === 1 ? "" : "s"} available.{" "}
              {attempt
                ? "Retrying checks the previously confirmed reset."
                : "The one expiring first is used."}
            </p>
            <ul className="max-h-56 space-y-1.5 overflow-auto">
              {[...list.credits]
                .sort((left, right) => creditExpiry(left) - creditExpiry(right))
                .map((credit) => (
                  <li
                    key={credit.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
                  >
                    <span>
                      {credit.title ?? credit.reset_type ?? "Reset credit"}
                      {credit.id === selectedCreditId && (
                        <Badge variant="secondary" className="ml-2">
                          Next
                        </Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {credit.status ?? "unknown"} · expires{" "}
                      {Number.isFinite(creditExpiry(credit))
                        ? date(creditExpiry(credit))
                        : "never"}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}
        {consume.error && <ErrorNotice error={consume.error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={consume.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={
              consume.isPending ||
              (!attempt &&
                (!usable.length ||
                  credits.isFetching ||
                  !!credits.error ||
                  !!list?.error))
            }
            onClick={(event) => {
              event.preventDefault();
              const creditId = usable[0]?.id;
              const request =
                attempt ??
                (creditId ? { redeemId: crypto.randomUUID(), creditId } : null);
              if (!request) return;
              setAttempt(request);
              consume.mutate(request);
            }}
          >
            {consume.isPending
              ? "Resetting…"
              : attempt
                ? "Retry reset"
                : "Spend 1 reset"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
