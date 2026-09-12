import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { toast } from "sonner";
import { read, rpc, useDraft } from "@/lib/api";
import { date } from "@/lib/format";
import {
  Choice,
  DataTable,
  Empty,
  ErrorNotice,
  Loading,
  PageHeading,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

type ClearAction =
  | { kind: "health"; serviceId: string; keyId?: string }
  | { kind: "session"; sessionId: string };
export default function Runtime() {
  const [selected, setSelected] = useState("");
  const [scope, setScope] = useState<"inference" | "catalog">("inference");
  const [cursor, setCursor] = useState("");
  const [confirmation, setConfirmation] = useState<{
    action: ClearAction;
    title: string;
    description: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const draft = useDraft();
  const clients = useQuery({
    queryKey: ["runtime-clients", draft.data?.published_revision],
    queryFn: ({ signal }) =>
      read(rpc.runtime.clients.$get({}, { init: { signal } })),
  });
  const clientId =
    clients.data?.items.find((client) => client.id === selected)?.id ??
    clients.data?.items[0]?.id ??
    "";
  const health = useQuery({
    queryKey: ["runtime-health", clientId, scope],
    queryFn: ({ signal }) =>
      read(
        rpc.runtime.health.$get(
          { query: { client_id: clientId, scope } },
          { init: { signal } },
        ),
      ),
    enabled: !!clientId,
    refetchInterval: 15_000,
  });
  const sessions = useQuery({
    queryKey: ["runtime-sessions", clientId, cursor],
    queryFn: ({ signal }) =>
      read(
        rpc.runtime.sessions.$get(
          { query: { client_id: clientId, cursor: cursor || undefined } },
          { init: { signal } },
        ),
      ),
    enabled: !!clientId,
    refetchInterval: 30_000,
  });
  const clear = useMutation({
    mutationFn: (action: ClearAction) => {
      const query = { client_id: clientId, scope };
      if (action.kind === "session") {
        return read(
          rpc.runtime.sessions[":id"].$delete({
            param: { id: encodeURIComponent(action.sessionId) },
            query,
          }),
        );
      }
      const param = { id: action.serviceId };
      if (action.keyId)
        return read(
          rpc.runtime.health[":id"][":key"].$delete({
            param: { ...param, key: action.keyId },
            query,
          }),
        );
      return read(rpc.runtime.health[":id"].$delete({ param, query }));
    },
    onSuccess: () => {
      toast.success("Runtime state updated");
      setConfirmation(null);
      void queryClient.invalidateQueries({ queryKey: ["runtime-health"] });
      void queryClient.invalidateQueries({ queryKey: ["runtime-sessions"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const timeZone = draft.data?.config.reporting?.time_zone;
  return (
    <>
      <PageHeading
        title="Runtime"
        description="Inspect cooldowns and session bindings through a published client identity."
      >
        <Button
          variant="outline"
          onClick={() => {
            void health.refetch();
            void sessions.refetch();
          }}
          disabled={!clientId || health.isFetching || sessions.isFetching}
        >
          <RefreshCw />
          Refresh
        </Button>
      </PageHeading>
      {clients.error ? (
        <ErrorNotice error={clients.error} />
      ) : clients.isPending ? (
        <Loading />
      ) : !clientId ? (
        <Card>
          <Empty title="Publish a client configuration first">
            Runtime operations use the currently published services and clients.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="flex gap-3">
            <Choice
              label="Client identity"
              value={clientId}
              onChange={(value) => {
                setSelected(value);
                setCursor("");
              }}
              options={clients.data.items.map((client) => ({
                value: client.id,
                label: client.id,
              }))}
            />
            <Choice
              label="Health scope"
              value={scope}
              onChange={(value) =>
                setScope(value === "catalog" ? "catalog" : "inference")
              }
              options={[
                { value: "inference", label: "Inference health" },
                { value: "catalog", label: "Model catalog health" },
              ]}
            />
          </div>
          <Tabs defaultValue="health">
            <TabsList>
              <TabsTrigger value="health">
                <ShieldCheck />
                Cooldowns
              </TabsTrigger>
              <TabsTrigger value="sessions">
                <Unplug />
                Session bindings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="health" className="mt-4">
              <Card className="overflow-hidden py-0 shadow-none">
                {health.error ? (
                  <div className="p-4">
                    <ErrorNotice error={health.error} />
                  </div>
                ) : health.isPending ? (
                  <Loading />
                ) : health.data.data.length ? (
                  <DataTable
                    data={health.data.data}
                    columns={[
                      {
                        id: "service",
                        header: "Service",
                        cell: ({ row }) => row.original.service_id,
                      },
                      {
                        id: "key",
                        header: "Key",
                        cell: ({ row }) =>
                          row.original.key_id ?? "Service-wide",
                      },
                      {
                        id: "failures",
                        header: "Failure streak",
                        cell: ({ row }) => row.original.failures,
                      },
                      {
                        id: "until",
                        header: "Cooling until",
                        cell: ({ row }) =>
                          date(row.original.cooling_until, timeZone),
                      },
                      {
                        id: "clear",
                        header: "",
                        cell: ({ row }) => (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setConfirmation({
                                action: {
                                  kind: "health",
                                  serviceId: row.original.service_id,
                                  keyId: row.original.key_id,
                                },
                                title: "Clear this cooldown?",
                                description:
                                  "The selected service or key becomes eligible for traffic again. Its next requests will determine its health.",
                              })
                            }
                          >
                            Clear cooldown
                          </Button>
                        ),
                      },
                    ]}
                  />
                ) : (
                  <Empty title="No active cooldowns">
                    No {scope} cooldowns are visible to this client.
                  </Empty>
                )}
              </Card>
            </TabsContent>
            <TabsContent value="sessions" className="mt-4 space-y-3">
              <Card className="overflow-hidden py-0 shadow-none">
                {sessions.error ? (
                  <div className="p-4">
                    <ErrorNotice error={sessions.error} />
                  </div>
                ) : sessions.isPending ? (
                  <Loading />
                ) : (
                  <DataTable
                    data={sessions.data.data}
                    columns={[
                      {
                        id: "session",
                        header: "Session",
                        cell: ({ row }) => (
                          <span
                            className="inline-block max-w-60 truncate font-mono text-xs"
                            title={row.original.session_id}
                          >
                            {row.original.session_id}
                          </span>
                        ),
                      },
                      {
                        id: "route",
                        header: "Service / key",
                        cell: ({ row }) => (
                          <div>
                            {row.original.service_id}
                            <p className="text-xs text-muted-foreground">
                              {row.original.key_id}
                            </p>
                          </div>
                        ),
                      },
                      {
                        id: "updated",
                        header: "Last updated",
                        cell: ({ row }) => (
                          <span className="text-xs">
                            {date(row.original.updated_at, timeZone)}
                          </span>
                        ),
                      },
                      {
                        id: "expires",
                        header: "Expires",
                        cell: ({ row }) => (
                          <span className="text-xs">
                            {date(row.original.expires_at, timeZone)}
                          </span>
                        ),
                      },
                      {
                        id: "clear",
                        header: "",
                        cell: ({ row }) => (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setConfirmation({
                                action: {
                                  kind: "session",
                                  sessionId: row.original.session_id,
                                },
                                title: "Clear this session binding?",
                                description:
                                  "The next ordinary request may select a new route. Native context ownership remains protected.",
                              })
                            }
                          >
                            Clear binding
                          </Button>
                        ),
                      },
                    ]}
                    empty="No active session bindings"
                  />
                )}
              </Card>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!cursor}
                  onClick={() => setCursor("")}
                >
                  First page
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!sessions.data?.next_cursor}
                  onClick={() => setCursor(sessions.data?.next_cursor ?? "")}
                >
                  Next page
                </Button>
              </div>
            </TabsContent>
          </Tabs>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Health scopes are independent</CardTitle>
              <CardDescription>
                Catalog failures do not change inference routing. Requests are
                retried only under a service’s explicit retry policy.
              </CardDescription>
            </CardHeader>
          </Card>
        </>
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={clear.isPending}
              onClick={() => {
                if (confirmation) clear.mutate(confirmation.action);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
