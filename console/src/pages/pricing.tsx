import { useSearchParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useDraft } from "@/lib/api";
import {
  Choice,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
} from "@/components/common";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PolicyForm } from "@/features/pricing/policy-form";

export default function Pricing() {
  const draft = useDraft();
  const [search, setSearch] = useSearchParams();
  if (draft.isPending) return <Loading />;
  if (draft.error)
    return (
      <ErrorNotice error={draft.error} retry={() => void draft.refetch()} />
    );
  const config = draft.data.config;
  const provider =
    config.providers.find((entry) => entry.id === search.get("provider")) ??
    config.providers[0];
  const model =
    provider?.models.find((entry) => entry === search.get("model")) ??
    provider?.models[0];
  return (
    <>
      <PageHeading
        title="Model pricing"
        description="Set token rates and context windows for each provider and model."
      />
      {!provider || !model ? (
        <Card className="shadow-none">
          <Empty title="Add a provider and model first">
            Pricing is shared by all credentials within the same provider.
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <aside className="space-y-3">
            <Choice
              label="Provider"
              value={provider.id}
              onChange={(value) => setSearch({ provider: value })}
              options={config.providers.map((entry) => ({
                value: entry.id,
                label: entry.id,
              }))}
              className="w-full"
            />
            <div className="rounded-xl border p-1.5">
              {provider.models.map((name) => {
                const policy = config.model_policies?.find(
                  (entry) =>
                    entry.provider_id === provider.id && entry.model === name,
                );
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() =>
                      setSearch({ provider: provider.id, model: name })
                    }
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-sm transition-colors hover:bg-muted",
                      model === name && "bg-muted",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{name}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {policy?.pricing
                          ? `${policy.pricing.currency} · ${policy.pricing.tiers.length} ${policy.pricing.tiers.length === 1 ? "tier" : "tiers"}`
                          : "No price configured"}
                      </span>
                    </span>
                    {model === name && (
                      <ChevronRight className="size-4 text-muted-foreground" />
                    )}
                  </button>
                );
              })}
            </div>
          </aside>
          <PolicyForm
            key={`${provider.id}:${model}:${draft.data.version}`}
            snapshot={draft.data}
            providerId={provider.id}
            model={model}
          />
        </div>
      )}
    </>
  );
}
