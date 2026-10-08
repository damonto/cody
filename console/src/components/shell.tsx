import { reportingOptions } from "@/lib/resources";
import { useRetryableRequest } from "@/lib/use-retryable-request";
import { useState } from "react";
import { Collapsible } from "radix-ui";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/components/theme-provider";
import {
  Activity,
  ChevronRight,
  CircleDollarSign,
  Command,
  GitBranch,
  History,
  KeyRound,
  LayoutDashboard,
  ListFilter,
  Monitor,
  Network,
  Moon,
  Server,
  Settings,
  Sun,
} from "lucide-react";
import { toast } from "sonner";
import {
  read,
  rpc,
  configurationStateOptions,
  useConfigurationState,
} from "@/lib/api";
import { date } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { DataTable, ErrorNotice, Loading } from "@/components/common";

const navigation = [
  {
    title: "Observe",
    items: [
      { path: "/overview", title: "Overview", icon: LayoutDashboard },
      { path: "/requests", title: "Requests", icon: ListFilter },
      { path: "/runtime", title: "Runtime", icon: Activity },
    ],
  },
  {
    title: "Configure",
    items: [
      { path: "/providers", title: "Providers", icon: Server },
      { path: "/proxies", title: "Proxies", icon: Network },
      { path: "/clients", title: "Client keys", icon: KeyRound },
      { path: "/routing", title: "Model routes", icon: GitBranch },
      { path: "/pricing", title: "Model pricing", icon: CircleDollarSign },
      { path: "/settings", title: "Settings", icon: Settings },
    ],
  },
];
const providerNavigation = [
  { path: "/providers/ai-gateway", title: "AI Gateway" },
  { path: "/providers/antigravity", title: "Antigravity" },
  { path: "/providers/codex", title: "Codex" },
  { path: "/providers/claude", title: "Claude" },
  { path: "/providers/xai", title: "SpaceXAI" },
];

export function Shell() {
  const { pathname } = useLocation();
  const configuration = useConfigurationState();
  const queryClient = useQueryClient();
  const [history, setHistory] = useState(false);
  const reporting = useQuery({ ...reportingOptions, enabled: history });
  const [rollback, setRollback] = useState<number | null>(null);
  const { theme, setTheme } = useTheme();
  const revisions = useQuery({
    queryKey: ["revisions"],
    queryFn: ({ signal }) =>
      read(rpc.config.versions.$get({}, { init: { signal } })),
    enabled: history,
  });
  const prepareRestore = useRetryableRequest<{
    version: number;
    revision: number;
    operation_id: string;
  }>();
  const restore = useMutation({
    mutationFn: (revision?: number) => {
      if (!configuration.data)
        throw new Error("Load the configuration before restoring");
      const version = configuration.data.version;
      if (revision !== undefined)
        return read(
          rpc.config.restorations.$post({
            json: prepareRestore({ version, revision }, () => ({
              version,
              revision,
              operation_id: crypto.randomUUID(),
            })),
          }),
        );
      throw new Error("Choose a configuration version to restore");
    },
    onSuccess: (next) => {
      void queryClient.invalidateQueries({
        queryKey: configurationStateOptions.queryKey,
      });
      void queryClient.invalidateQueries({ queryKey: ["configuration"] });
      void queryClient.invalidateQueries({ queryKey: ["entity-names"] });
      void queryClient.invalidateQueries({ queryKey: ["revisions"] });
      toast.success(`Configuration version ${next.version} restored`, {
        description: "New requests use the saved configuration immediately.",
      });
      setRollback(null);
    },
    onError: (error) => toast.error(error.message),
  });
  const current =
    providerNavigation.find((item) => item.path === pathname) ??
    navigation
      .flatMap((group) => group.items)
      .find((item) => item.path === pathname);
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="px-5 py-6">
          <NavLink to="/overview" className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Command className="size-5" />
            </span>
            <div>
              <span className="text-lg font-semibold tracking-tight">cody</span>
              <p className="text-[11px] text-muted-foreground">
                AI gateway console
              </p>
            </div>
          </NavLink>
        </SidebarHeader>
        <SidebarContent>
          {navigation.map((group) => (
            <SidebarGroup key={group.title} className="px-3">
              <SidebarGroupLabel className="px-3 text-[10px] font-medium uppercase tracking-widest">
                {group.title}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) =>
                    item.path === "/providers" ? (
                      <Collapsible.Root
                        key={item.path}
                        asChild
                        defaultOpen={pathname.startsWith("/providers")}
                      >
                        <SidebarMenuItem className="group/providers">
                          <Collapsible.Trigger asChild>
                            <SidebarMenuButton
                              className="h-10 px-3"
                              isActive={pathname.startsWith("/providers")}
                            >
                              <Server className="size-4" />
                              <span>Providers</span>
                              <ChevronRight className="ml-auto size-3 transition-transform group-data-[state=open]/providers:rotate-90" />
                            </SidebarMenuButton>
                          </Collapsible.Trigger>
                          <Collapsible.Content>
                            <SidebarMenuSub>
                              {providerNavigation.map((provider) => (
                                <SidebarMenuSubItem key={provider.path}>
                                  <SidebarMenuSubButton
                                    asChild
                                    isActive={pathname === provider.path}
                                  >
                                    <NavLink to={provider.path}>
                                      {provider.title}
                                    </NavLink>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ))}
                            </SidebarMenuSub>
                          </Collapsible.Content>
                        </SidebarMenuItem>
                      </Collapsible.Root>
                    ) : (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          asChild
                          isActive={pathname === item.path}
                          className="h-10 px-3"
                        >
                          <NavLink to={item.path}>
                            <item.icon className="size-4" />
                            <span>{item.title}</span>
                            {pathname === item.path && (
                              <ChevronRight className="ml-auto size-3 text-muted-foreground" />
                            )}
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ),
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="p-4">
          <div className="flex items-center justify-between gap-2 px-1">
            <span
              className="truncate text-xs text-muted-foreground"
              title={configuration.data?.actor}
            >
              {configuration.data?.actor ?? "Admin console"}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Choose color theme"
                >
                  {theme === "system" ? (
                    <Monitor />
                  ) : theme === "dark" ? (
                    <Moon />
                  ) : (
                    <Sun />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(value) => {
                    if (
                      value === "system" ||
                      value === "light" ||
                      value === "dark"
                    )
                      setTheme(value);
                  }}
                >
                  <DropdownMenuRadioItem value="system">
                    <Monitor />
                    System
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="light">
                    <Sun />
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon />
                    Dark
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4 md:px-8">
          <div className="flex items-center gap-3 text-sm">
            <SidebarTrigger />
            <span className="hidden text-muted-foreground sm:inline">
              Workspace
            </span>
            <ChevronRight className="hidden size-3 text-muted-foreground sm:block" />
            <span className="font-medium">{current?.title ?? "Console"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden font-normal sm:flex">
              Version {configuration.data?.version ?? "—"}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Configuration history"
              onClick={() => setHistory(true)}
            >
              <History />
            </Button>
          </div>
        </header>
        <section
          id="main-content"
          className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-6 p-4 md:p-8"
        >
          <Outlet />
        </section>
        <footer className="flex flex-wrap justify-between gap-2 border-t px-8 py-4 text-[11px] text-muted-foreground">
          <span>Cody · Gateway operations</span>
          <span>
            Usage is reported asynchronously · No prompts or responses stored
          </span>
        </footer>
      </SidebarInset>
      <Dialog open={history} onOpenChange={setHistory}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Configuration history</DialogTitle>
            <DialogDescription>
              Every save creates an immutable version. Restoring a version is
              applied as a new saved configuration.
            </DialogDescription>
          </DialogHeader>
          {revisions.isPending ? (
            <Loading />
          ) : revisions.error ? (
            <ErrorNotice error={revisions.error} />
          ) : (
            <DataTable
              data={revisions.data.items}
              columns={[
                {
                  id: "revision",
                  header: "Revision",
                  cell: ({ row }) => (
                    <span className="font-mono">r{row.original.id}</span>
                  ),
                },
                {
                  id: "time",
                  header: "Saved",
                  cell: ({ row }) => (
                    <span className="text-xs">
                      {date(
                        row.original.created_at,
                        reporting.data?.item.time_zone,
                      )}
                    </span>
                  ),
                },
                {
                  id: "actor",
                  header: "By",
                  cell: ({ row }) => row.original.actor,
                },
                {
                  id: "action",
                  header: "",
                  cell: ({ row }) => (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        row.original.id === configuration.data?.version ||
                        restore.isPending
                      }
                      onClick={() => setRollback(row.original.id)}
                    >
                      Restore
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={rollback !== null}
        onOpenChange={(open) => {
          if (!open) setRollback(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore revision {rollback}?</AlertDialogTitle>
            <AlertDialogDescription>
              This saves the selected configuration as a new revision. Existing
              request costs keep their original prices.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restore.isPending}
              onClick={() => {
                if (rollback !== null) restore.mutate(rollback);
              }}
            >
              Restore configuration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
