import {
  publicProviderModels,
  antigravityFamilyModels,
} from "../../../src/shared/antigravity-models.ts";
import { ResourceRefreshNotice } from "@/components/resource-refresh-notice";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { usePricingResources } from "@/lib/resources";
import {
  Choice,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PriceForm } from "@/features/pricing/price-form";

export default function Pricing() {
  const configuration = usePricingResources();
  const [search, setSearch] = useSearchParams();
  if (configuration.isPending) return <Loading />;
  if (configuration.error)
    return (
      <ErrorNotice
        error={configuration.error}
        retry={() => void configuration.refetch()}
      />
    );
  const config = configuration.data;
  const provider =
    config.providers.find((entry) => entry.id === search.get("provider")) ??
    config.providers.find((entry) => entry.models.length > 0) ??
    config.providers[0];
  const models = provider ? publicProviderModels(provider) : [];
  const model =
    models.find((entry) => entry === search.get("model")) ?? models[0];
  return (
    <>
      <ResourceRefreshNotice resource={configuration} />
      <PageHeading
        title="Model pricing"
        description="Set token rates and context windows for each provider and model."
      />
      {!provider ? (
        <Card className="shadow-none">
          <Empty
            title="Add a provider and model first"
            action={
              <Button asChild variant="outline">
                <Link to="/providers/ai-gateway">Add provider</Link>
              </Button>
            }
          >
            Add a provider with at least one model to configure token prices.
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
                label: entry.name ?? entry.id,
              }))}
              className="w-full"
            />
            {models.length > 0 && (
              <div className="rounded-xl border p-1.5">
                {models.map((name) => {
                  const price = config.prices?.find(
                    (entry) =>
                      entry.provider_id === provider.id &&
                      (entry.model === name ||
                        (provider.type === "antigravity" &&
                          antigravityFamilyModels(
                            provider.models,
                            name,
                          ).includes(entry.model))),
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
                        <span className="block truncate font-medium">
                          {name}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {price?.pricing
                            ? `${price.pricing.currency} · ${price.pricing.tiers.length} ${price.pricing.tiers.length === 1 ? "tier" : "tiers"}`
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
            )}
          </aside>
          {model ? (
            <PriceForm
              key={`${provider.id}:${model}`}
              snapshot={configuration.data}
              providerId={provider.id}
              model={model}
            />
          ) : (
            <Card className="shadow-none">
              <Empty
                title={`No models configured for ${provider.name ?? provider.id}`}
                action={
                  <Button asChild variant="outline">
                    <Link
                      to={`/providers/${provider.type === "ai_gateway" ? "ai-gateway" : provider.type}`}
                    >
                      Configure provider
                    </Link>
                  </Button>
                }
              >
                Add models in this provider’s settings, or select another
                provider to configure its prices.
              </Empty>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
