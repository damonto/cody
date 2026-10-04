import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { configurationStateOptions } from "./api";
import type { QueryKey } from "@tanstack/react-query";
import { useRetryableRequest } from "./use-retryable-request";

/** Shared transport guarantees; each feature owns its resource and request body. */
export function useConfigurationMutation<Input extends { version: number }>(
  affected: readonly QueryKey[] | ((input: Input) => readonly QueryKey[]),
  send: (
    input: Input & { operation_id: string },
  ) => Promise<{ version: number; item: unknown }>,
) {
  const client = useQueryClient();
  const prepare = useRetryableRequest<Input & { operation_id: string }>();
  return useMutation({
    mutationFn: (input: Input) =>
      send(
        prepare(input, () => ({ ...input, operation_id: crypto.randomUUID() })),
      ),
    onSuccess: async (result, input) => {
      const keys = typeof affected === "function" ? affected(input) : affected;
      // A locally confirmed write advances unchanged cached reads from the same version.
      // Older reads stay fenced; a response from an idempotent replay never moves them backwards.
      // Invalidated resources must still refetch, including inactive queries from earlier writes.
      if (result.version === input.version + 1) {
        client.setQueriesData<{ version: number; item: unknown; etag: string }>(
          {
            queryKey: ["configuration"],
            predicate: (query) =>
              !query.state.isInvalidated &&
              !keys.some((key) =>
                key.every((part, index) => query.queryKey[index] === part),
              ),
          },
          (value) =>
            value?.version === input.version
              ? { ...value, version: result.version }
              : undefined,
        );
      }
      await Promise.all(
        keys.map((queryKey) => client.invalidateQueries({ queryKey })),
      );
      void client.invalidateQueries({
        queryKey: configurationStateOptions.queryKey,
      });
      void client.invalidateQueries({ queryKey: ["revisions"] });
      toast.success("Changes saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function withoutId<T extends { id: string; name?: string | undefined }>(
  value: T,
): Omit<T, "id" | "name"> & { name: string } {
  const { id: _id, name, ...fields } = value;
  if (!name) throw new Error("A resource name is required");
  return { ...fields, name };
}
