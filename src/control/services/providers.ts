import {
  antigravityVariant,
  providerModelNames,
} from "../../shared/antigravity-models.ts";
import type { ConfigurationOperation } from "../unit-of-work.ts";
import { z } from "zod";
import { providerSchema } from "../../config/schema.ts";
import type { ControlStore } from "../store.ts";
import type { EntityRows } from "../entities.ts";
import type { ConfigurationUnitOfWork } from "../unit-of-work.ts";
import {
  credentialInputSchema,
  nativeSettingsSchema,
  nativeTypeSchema,
  providerInputSchema,
} from "../resource-input.ts";
import { ControlInputError, ControlNotFound, required } from "../errors.ts";
import { providerTables } from "../repository.ts";
import { live, ordered, providersFromEntities } from "../compiler.ts";
import { maskSecrets } from "../secrets.ts";
import {
  put,
  reorder,
  replaceRoutes,
  providerFor,
  modelFor,
  modelFamily,
} from "./shared.ts";

type ProviderInput = z.infer<typeof providerInputSchema>;
type CredentialInput = z.infer<typeof credentialInputSchema>;
type NativeInput = z.infer<typeof nativeSettingsSchema>;
type NativeType = z.infer<typeof nativeTypeSchema>;
const providerEntity = (work: ConfigurationUnitOfWork, id: string) =>
  required(
    live(work.rows.providers).find((row) => row.id === id),
    "Provider",
  );
const credentialEntity = (
  work: ConfigurationUnitOfWork,
  id: string,
  credentialId: string,
) =>
  required(
    live(work.rows.provider_credentials).find(
      (row) => row.provider_id === id && row.id === credentialId,
    ),
    "Credential",
  );
const credentialFor = (
  config: Parameters<typeof providerFor>[0],
  id: string,
  credentialId: string,
) =>
  required(
    providerFor(config, id).credentials.find((row) => row.id === credentialId),
    "Credential",
  );
function ownedModel(
  config: Parameters<typeof modelFor>[0],
  id: string,
  modelId: string,
) {
  const model = modelFor(config, modelId);
  if (model.provider.id !== id)
    throw new ControlNotFound("Provider model does not exist");
  return { name: model.name, ...model.settings };
}
function editable(work: ConfigurationUnitOfWork, id: string) {
  const provider = providerEntity(work, id);
  if (provider.type !== "ai_gateway")
    throw new ControlInputError("Use the native provider settings resource");
  return provider;
}

function detachProviderRoutes(
  rows: Pick<
    EntityRows,
    "providers" | "provider_models" | "model_routes" | "model_route_providers"
  >,
  providerId: string,
): void {
  const modelsByProvider = new Map<string, string[]>();
  for (const row of live(rows.provider_models)) {
    const models = modelsByProvider.get(row.provider_id) ?? [];
    models.push(row.model);
    modelsByProvider.set(row.provider_id, models);
  }
  const supportedModels = new Set(
    live(rows.providers)
      .filter((provider) => provider.id !== providerId)
      .flatMap((provider) =>
        providerModelNames({
          type: provider.type,
          models: modelsByProvider.get(provider.id) ?? [],
        }),
      ),
  );
  const routesWithProviders = new Set(
    live(rows.model_route_providers)
      .filter((row) => row.provider_id !== providerId)
      .map((row) => row.route_id),
  );
  const removedRoutes = new Set(
    live(rows.model_routes)
      .filter((row) =>
        row.scope === "provider"
          ? row.provider_id === providerId
          : !supportedModels.has(row.model) ||
            (row.restrict_providers === 1 && !routesWithProviders.has(row.id)),
      )
      .map((row) => row.id),
  );
  // Removing an empty restriction must retire the route, not make it unrestricted.
  rows.model_routes = rows.model_routes.filter(
    (row) => !removedRoutes.has(row.id),
  );
  rows.model_route_providers = rows.model_route_providers.filter(
    (row) => row.provider_id !== providerId && !removedRoutes.has(row.route_id),
  );
}

async function writeCredential(
  work: ConfigurationUnitOfWork,
  providerId: string,
  input: CredentialInput,
  position: number,
  credentialId?: string,
) {
  const old = credentialId
    ? credentialEntity(work, providerId, credentialId)
    : undefined;
  const metadata = work.metadata(old);
  const row = {
    ...metadata,
    provider_id: providerId,
    name: input.name,
    priority: input.priority,
    disabled: input.disabled ? (1 as const) : (0 as const),
    position,
    auth_type: input.auth.type,
    account_ref: input.auth.type === "oauth" ? input.auth.account_ref : null,
    secret_id:
      input.auth.type === "api_key"
        ? await work.secrets.seal(
            metadata.id,
            "api_key",
            input.auth.api_key,
            old?.secret_id,
          )
        : null,
    proxy_mode:
      input.proxy_group === undefined
        ? ("inherit" as const)
        : input.proxy_group === null
          ? ("direct" as const)
          : ("group" as const),
    proxy_group_id: input.proxy_group ?? null,
  };
  put(work.rows.provider_credentials, row);
  return row.id;
}
function writeSettings(
  work: ConfigurationUnitOfWork,
  input: Omit<ProviderInput, "credentials"> | NativeInput,
  existingId?: string,
) {
  const { rows } = work;
  const old = existingId ? providerEntity(work, existingId) : undefined;
  const {
    name,
    models,
    model_settings,
    model_routes,
    proxy_group,
    priority,
    disabled,
    type,
    ...settings
  } = input;
  const metadata = work.metadata(old);
  const id = metadata.id;
  put(rows.providers, {
    ...metadata,
    name: name ?? old?.name ?? type,
    type,
    priority,
    disabled: disabled ? 1 : 0,
    position: old?.position ?? rows.providers.length,
    proxy_group_id: proxy_group ?? null,
    settings_json: JSON.stringify(settings),
  });
  const before = rows.provider_models.filter((row) => row.provider_id === id);
  rows.provider_models = rows.provider_models.filter(
    (row) => row.provider_id !== id,
  );
  for (const [position, model] of models.entries()) {
    const previous = before.find((row) => row.model === model);
    const variant =
      type === "antigravity" &&
      !models.includes(antigravityVariant(model)?.family ?? "")
        ? antigravityVariant(model)
        : undefined;
    const siblings = variant
      ? before.filter(
          (row) =>
            row.deleted_at === null &&
            antigravityVariant(row.model)?.family === variant.family,
        )
      : [];
    const inherited =
      (!previous || previous.deleted_at !== null) && siblings.length > 0;
    const prices = inherited
      ? siblings.map(
          (row) =>
            live(rows.model_prices).find(
              (price) => price.provider_model_id === row.id,
            )?.pricing_json ?? null,
        )
      : [];
    if (
      inherited &&
      (new Set(prices).size > 1 ||
        new Set(siblings.map((row) => row.context_window)).size > 1)
    )
      throw new ControlInputError(
        "Set a shared family price and context window before enabling another thinking level",
      );
    const modelMetadata = work.metadata(previous);
    if (inherited && prices[0] !== null)
      put(rows.model_prices, {
        ...work.metadata(
          rows.model_prices.find(
            (price) => price.provider_model_id === modelMetadata.id,
          ),
        ),
        provider_model_id: modelMetadata.id,
        pricing_json: prices[0],
      });
    rows.provider_models.push({
      ...modelMetadata,
      provider_id: id,
      model,
      context_window:
        model_settings?.[model]?.context_window ??
        (inherited ? siblings[0].context_window : null),
      position,
    });
  }
  const modelIds = new Set(live(rows.provider_models).map((row) => row.id));
  rows.model_prices = rows.model_prices.filter(
    (row) => row.deleted_at !== null || modelIds.has(row.provider_model_id),
  );
  replaceRoutes(work, "provider", id, model_routes ?? {});
  return id;
}

export class ProviderService {
  constructor(private readonly store: ControlStore) {}
  list() {
    return this.store.resource(providerTables, providersFromEntities, (items) =>
      items.map((item) => providerSchema.parse(maskSecrets(item))),
    );
  }

  async get(id: string) {
    const result = await this.list();
    return {
      ...result,
      item: required(
        result.item.find((row) => row.id === id),
        "Provider",
      ),
    };
  }
  async native(type: NativeType) {
    const result = await this.list();
    return {
      ...result,
      item: result.item.find((row) => row.type === type) ?? null,
    };
  }
  create(operation: ConfigurationOperation, input: ProviderInput) {
    return this.store.mutate(
      operation,
      async (work) => {
        const { credentials, ...settings } = input;
        const id = writeSettings(work, settings);
        for (const [position, credential] of credentials.entries())
          await writeCredential(
            work,
            id,
            {
              ...credential,
              name: required(credential.name, "Credential name"),
            },
            position,
          );
      },
      (config) => required(config.providers.at(-1), "Provider"),
    );
  }
  update(operation: ConfigurationOperation, id: string, input: ProviderInput) {
    return this.store.mutate(
      operation,
      async (work) => {
        editable(work, id);
        const { credentials, ...settings } = input;
        writeSettings(work, settings, id);
        const retained = new Set<string>();
        for (const [position, credential] of credentials.entries()) {
          const existing = work.rows.provider_credentials.find(
            (row) => row.id === credential.id,
          );
          if (
            existing &&
            (existing.provider_id !== id || existing.deleted_at !== null)
          )
            throw new ControlInputError(
              "A credential cannot move to another provider",
            );
          retained.add(
            await writeCredential(
              work,
              id,
              {
                ...credential,
                name: required(credential.name, "Credential name"),
              },
              position,
              existing?.id,
            ),
          );
        }
        work.rows.provider_credentials = work.rows.provider_credentials.filter(
          (row) =>
            row.provider_id !== id ||
            row.deleted_at !== null ||
            retained.has(row.id),
        );
      },
      (config) => providerFor(config, id),
    );
  }
  remove(operation: ConfigurationOperation, id: string) {
    return this.store.mutate(
      operation,
      (work) => {
        editable(work, id);
        const { rows } = work;
        const models = new Set(
          rows.provider_models
            .filter((row) => row.provider_id === id)
            .map((row) => row.id),
        );
        detachProviderRoutes(rows, id);
        rows.providers = rows.providers.filter((row) => row.id !== id);
        rows.provider_credentials = rows.provider_credentials.filter(
          (row) => row.provider_id !== id,
        );
        rows.provider_models = rows.provider_models.filter(
          (row) => row.provider_id !== id,
        );
        rows.model_prices = rows.model_prices.filter(
          (row) => !models.has(row.provider_model_id),
        );
        rows.client_providers = rows.client_providers.filter(
          (row) => row.provider_id !== id,
        );
      },
      () => null,
    );
  }
  order(operation: ConfigurationOperation, ids: string[]) {
    return this.store.mutate(
      operation,
      (work) => reorder(work, work.rows.providers, ids),
      (config) => config.providers,
    );
  }
  saveNative(
    operation: ConfigurationOperation,
    type: NativeType,
    input: NativeInput,
  ) {
    if (input.type !== type)
      throw new ControlInputError(
        "Settings must belong to the requested native provider",
      );
    return this.store.mutate(
      operation,
      (work) => {
        const current = live(work.rows.providers).find(
          (row) => row.type === type,
        );
        writeSettings(work, input, current?.id);
      },
      (config) =>
        required(
          config.providers.find((row) => row.type === type),
          "Native provider",
        ),
    );
  }
  async credentials(id: string) {
    const result = await this.get(id);
    return { ...result, item: result.item.credentials };
  }
  async credential(id: string, credentialId: string) {
    const result = await this.credentials(id);
    return {
      ...result,
      item: required(
        result.item.find((row) => row.id === credentialId),
        "Credential",
      ),
    };
  }
  createCredential(
    operation: ConfigurationOperation,
    id: string,
    input: CredentialInput,
  ) {
    return this.store.mutate(
      operation,
      async (work) => {
        providerEntity(work, id);
        await writeCredential(
          work,
          id,
          input,
          work.rows.provider_credentials.length,
        );
      },
      (config) =>
        required(providerFor(config, id).credentials.at(-1), "Credential"),
    );
  }
  updateCredential(
    operation: ConfigurationOperation,
    id: string,
    credentialId: string,
    input: CredentialInput,
  ) {
    return this.store.mutate(
      operation,
      async (work) => {
        const current = credentialEntity(work, id, credentialId);
        await writeCredential(work, id, input, current.position, credentialId);
      },
      (config) => credentialFor(config, id, credentialId),
    );
  }
  removeCredential(
    operation: ConfigurationOperation,
    id: string,
    credentialId: string,
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        credentialEntity(work, id, credentialId);
        work.rows.provider_credentials = work.rows.provider_credentials.filter(
          (row) => row.id !== credentialId,
        );
        const provider = providerEntity(work, id);
        if (
          provider.type !== "ai_gateway" &&
          !live(work.rows.provider_credentials).some(
            (row) => row.provider_id === id,
          )
        )
          Object.assign(provider, {
            disabled: 1,
            version: work.version,
            updated_at: work.now,
          });
      },
      () => null,
    );
  }
  orderCredentials(
    operation: ConfigurationOperation,
    id: string,
    ids: string[],
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        providerEntity(work, id);
        reorder(
          work,
          work.rows.provider_credentials.filter(
            (row) => row.provider_id === id,
          ),
          ids,
        );
      },
      (config) => providerFor(config, id).credentials,
    );
  }
  revealCredential(id: string, credentialId: string, version: number) {
    return this.store.reveal(
      ["provider_credentials"],
      version,
      async (rows, secrets) => {
        const row = required(
          live(rows.provider_credentials).find(
            (row) => row.id === credentialId && row.provider_id === id,
          ),
          "Credential",
        );
        if (row.auth_type !== "api_key" || !row.secret_id)
          throw new ControlInputError("OAuth tokens cannot be revealed");
        return { api_key: await secrets.read(row.secret_id) };
      },
    );
  }
  async routes(id: string) {
    const result = await this.get(id);
    return { ...result, item: result.item.model_routes ?? {} };
  }
  saveRoutes(
    operation: ConfigurationOperation,
    id: string,
    routes: NonNullable<ProviderInput["model_routes"]>,
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        providerEntity(work, id);
        replaceRoutes(work, "provider", id, routes);
      },
      (config) => providerFor(config, id).model_routes ?? {},
    );
  }
  models(id: string) {
    return this.store.resource(["providers", "provider_models"], (rows) => {
      required(
        live(rows.providers).find((row) => row.id === id),
        "Provider",
      );
      return ordered(rows.provider_models)
        .filter((row) => row.provider_id === id)
        .map((row) => ({
          name: row.model,
          id: row.id,
          ...(row.context_window === null
            ? {}
            : { context_window: row.context_window }),
        }));
    });
  }
  async model(id: string, modelId: string) {
    const result = await this.models(id);
    return {
      ...result,
      item: required(
        result.item.find((row) => row.id === modelId),
        "Provider model",
      ),
    };
  }
  saveModelFamily(
    operation: ConfigurationOperation,
    providerId: string,
    modelId: string,
    context: number | null,
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        const models = modelFamily(work.rows, modelId);
        if (models[0].provider_id !== providerId)
          throw new ControlInputError("Model belongs to a different provider");
        for (const model of models)
          Object.assign(model, {
            context_window: context,
            version: work.version,
            updated_at: work.now,
          });
      },
      (config) => ownedModel(config, providerId, modelId),
    );
  }
  saveModel(
    operation: ConfigurationOperation,
    id: string,
    modelId: string,
    context: number | null,
  ) {
    return this.store.mutate(
      operation,
      (work) => {
        const row = required(
          live(work.rows.provider_models).find(
            (row) => row.id === modelId && row.provider_id === id,
          ),
          "Provider model",
        );
        Object.assign(row, {
          context_window: context,
          version: work.version,
          updated_at: work.now,
        });
      },
      (config) => ownedModel(config, id, modelId),
    );
  }
}
