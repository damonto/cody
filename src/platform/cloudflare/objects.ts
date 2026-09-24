/**
 * Cloudflare Durable Object shells. Each class keeps its stable `class_name`
 * from `wrangler.jsonc` and delegates to a runtime-neutral core so the same
 * logic also runs on the standard (Redis + SQL) backend.
 */
import { DurableObject } from "cloudflare:workers";
import { ConfigPublisherCore } from "../../control/publisher.ts";
import { ProviderHealthCore } from "../../gateway/health/provider-health.ts";
import type {
  AffinityProviderCandidate,
  AffinitySelection,
  SessionAffinityRegistration,
} from "../../gateway/routing/affinity.ts";
import { SessionAffinityCore } from "../../gateway/sessions/session-affinity.ts";
import { ResponsesWebSocketProxyCore } from "../../gateway/websocket/responses-websocket-proxy.ts";
import type { AccountCommand } from "../../providers/oauth/commands.ts";
import { ProviderOAuthAccountCore } from "../../providers/oauth/account.ts";
import { UsageOutboxCore } from "../../telemetry/outbox.ts";
import type { SessionAffinityResolveOptions } from "../bindings.ts";

/** One object per client connection; WebSocket hibernation delivers socket events. */
export class ResponsesWebSocketProxy extends DurableObject<Env> {
  private readonly core: ResponsesWebSocketProxyCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new ResponsesWebSocketProxyCore(ctx, env);
  }
  override fetch(request: Request) {
    return this.core.fetch(request);
  }
  override alarm() {
    return this.core.alarm();
  }
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    this.core.webSocketMessage(socket, message);
  }
  override webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) {
    return this.core.webSocketClose(socket, code, reason, wasClean);
  }
  override webSocketError(socket: WebSocket, error: unknown) {
    return this.core.webSocketError(socket, error);
  }
}

export class ProviderHealth extends DurableObject<Env> {
  private readonly core: ProviderHealthCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new ProviderHealthCore(ctx, env);
  }
  getStatus() {
    return this.core.getStatus();
  }
  recordSuccess() {
    return this.core.recordSuccess();
  }
  recordFailure() {
    return this.core.recordFailure();
  }
  recordImmediateFailure() {
    return this.core.recordImmediateFailure();
  }
  clear() {
    return this.core.clear();
  }
}

export class SessionAffinity extends DurableObject<Env> {
  private readonly core: SessionAffinityCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new SessionAffinityCore(ctx, env);
  }
  resolve(
    candidates: AffinityProviderCandidate[],
    preferred: AffinitySelection | undefined,
    registration: SessionAffinityRegistration,
    options?: SessionAffinityResolveOptions,
  ) {
    return this.core.resolve(candidates, preferred, registration, options);
  }
  claimContextSession(clientId: string) {
    return this.core.claimContextSession(clientId);
  }
  releaseContextSession(clientId: string) {
    return this.core.releaseContextSession(clientId);
  }
  getStatus() {
    return this.core.getStatus();
  }
  clear() {
    return this.core.clear();
  }
  clearIfBindingId(bindingId: string, generation: number) {
    return this.core.clearIfBindingId(bindingId, generation);
  }
  clearManaged(registration: SessionAffinityRegistration) {
    return this.core.clearManaged(registration);
  }
  override alarm() {
    return this.core.alarm();
  }
}

export class UsageOutbox extends DurableObject<Env> {
  private readonly core: UsageOutboxCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new UsageOutboxCore(ctx, env);
  }
  enqueue(input: unknown) {
    return this.core.enqueue(input);
  }
  override alarm() {
    return this.core.alarm();
  }
}

export class ConfigPublisher extends DurableObject<Env> {
  private readonly core: ConfigPublisherCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new ConfigPublisherCore(ctx, env);
  }
  getDraft() {
    return this.core.getDraft();
  }
  saveDraft(config: string, version: number, actor: string) {
    return this.core.saveDraft(config, version, actor);
  }
  publish(version: number, actor: string) {
    return this.core.publish(version, actor);
  }
  rollback(revision: number, version: number, actor: string) {
    return this.core.rollback(revision, version, actor);
  }
  override alarm() {
    return this.core.alarm();
  }
}

export class ProviderOAuthAccount extends DurableObject<Env> {
  private readonly core: ProviderOAuthAccountCore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new ProviderOAuthAccountCore(ctx, env);
  }
  run(input: AccountCommand) {
    return this.core.run(input);
  }
  override alarm() {
    return this.core.alarm();
  }
}
