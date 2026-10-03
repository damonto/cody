import { ErrorNotice } from "./common";

export function ResourceRefreshNotice({
  resource,
}: {
  resource: { refreshError: Error | null; refetch: () => Promise<unknown> };
}) {
  return resource.refreshError ? (
    <ErrorNotice
      error={resource.refreshError}
      retry={() => void resource.refetch()}
    />
  ) : null;
}
