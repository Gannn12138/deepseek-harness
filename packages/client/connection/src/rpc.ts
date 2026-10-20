/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PeerScope, RequestPrincipal } from '@deepseek-ai/dsh-typert-protocol'

/** Correlation id minted by a caller and echoed by the Connection response. */
export type RpcId = Branded<'rpc-id'>

/**
 * Brand one validated string as a Connection correlation id.
 * @param id - validated wire identity.
 * @returns the same string with the correlation-id brand.
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/** Carrier-neutral failure returned by one logical RPC endpoint. */
export interface ConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Carrier-neutral result returned by one logical RPC endpoint. */
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** One binary value separated from a successful RPC result before transport framing. */
export interface ConnectionRpcAttachment {
  /** Result-relative path occupied by the attachment's `null` placeholder. */
  readonly path: readonly (string | number)[]
  /** Byte view carried outside the JSON response metadata. */
  readonly bytes: Uint8Array
}

/** Successful or failed handler result ready for Connection transport framing. */
export type ConnectionRpcHandlerResult =
  | {
    readonly ok: true
    readonly value: unknown
    /** Binary fields already projected by the handler that owns the result protocol. */
    readonly attachments?: readonly ConnectionRpcAttachment[]
  }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** Historical short name for a generic Connection result. */
export type RpcResult<T> = ConnectionRpcResult<T>

/**
 * Convert a rejected transport operation into a generic failure result.
 * @param error - rejected transport value.
 * @returns an `internal` failure preserving the available message.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Narrow request form used by direct fixture adapters. */
export interface RpcRequest<P> {
  readonly rpcId: RpcId
  readonly payload: P
}

/** Narrow response form used by direct fixture adapters. */
export interface RpcResponse<T> {
  readonly rpcId: RpcId
  readonly result: RpcResult<T>
}

/** Full request envelope carried by Connection RPC transports. */
export interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: RpcId
  readonly method: string
  readonly payload: unknown
}

/** Full response envelope carried by Connection RPC transports. */
export interface ServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcId
  readonly result: ConnectionRpcResult<unknown>
}

/** Complete Connection RPC envelope union. */
export type RpcMessage = ClientRequest | ServerResponse

/** HTTP request facts consumed by browser trust and authentication. */
export interface ConnectionTrustRequest {
  /** Request headers supplied by either the Fetch or node:http representation. */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}

/** HTTP status returned before dispatch, or undefined when the request may proceed. */
export type ConnectionRequestRejection = 401 | 403 | 503 | undefined

/** Root/index request facts used by the browser-token exchange. */
export interface ConnectionIndexRequest extends ConnectionTrustRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** Root/index response operations owned by the browser-token exchange. */
export interface ConnectionIndexResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

/** Outcome of admitting one request: the operator Peer and optional verified identity, or a refusal. */
export type PeerAdmission =
  | { readonly peer: PeerScope; readonly principal?: RequestPrincipal }
  | { readonly rejection: 401 | 403 | 503 }

/** Authentication policy selected by the deployment composition. */
export type ConnectionAuthenticationMode = 'operator' | 'application'

/** An application admits a verified subject and its owned Peer, or refuses it. */
export type ApplicationPeerAdmission =
  | { readonly peer: PeerScope; readonly principal: RequestPrincipal }
  | { readonly rejection: 401 | 403 | 503 }

/** Frontend response decision; Connection owns writing the resulting response. */
export type ApplicationIndexAdmission =
  | { readonly kind: 'allow' }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'reject'; readonly status: 401 | 403 | 503 }

/** Server-owned authentication used only by application-mode deployments. */
export interface ApplicationAuthenticationProvider {
  /**
   * Check current authentication state before each request or upgrade.
   * The provider owns Peer lifetime and must dispose affected Peers on revocation.
   * @param request - carrier headers used for a server-side session lookup.
   * @returns a verified principal and Peer, or a typed denial; thrown defects become 503.
   */
  admit(request: ConnectionTrustRequest): ApplicationPeerAdmission
  /**
   * Decide whether to serve the frontend or redirect to the configured login entry.
   * Redirects must come from validated server configuration, never unchecked query values.
   * @param request - trusted frontend request.
   * @returns response decision; thrown defects become 503 before any response is written.
   */
  index(request: ConnectionIndexRequest): ApplicationIndexAdmission
}

/** Scoped registration of the sole application authentication provider. */
export interface HostConnectionAuthentication {
  /**
   * Register authentication after its server-side state is ready.
   * Removing the provider restores denial in application mode, never operator access.
   * @param provider - server-owned admission and frontend authentication decisions.
   * @returns scoped disposer removing this exact provider.
   */
  register(provider: ApplicationAuthenticationProvider): () => Promise<void>
}

/**
 * Resolve a verified identity from server-controlled authentication state.
 * @param request - transport headers used to look up server-owned authentication state.
 * @returns verified identity, or undefined when no application identity is available.
 */
export type RequestPrincipalResolver = (request: ConnectionTrustRequest) => RequestPrincipal | undefined

/** Optional principal enrichment for the legacy operator authentication policy. */
export interface HostConnectionIdentity {
  /**
   * Register the sole resolver used for admitted HTTP and upgrade requests.
   * @param resolver - synchronous lookup over server-owned authentication state.
   * @returns scoped disposer removing this resolver.
   */
  register(resolver: RequestPrincipalResolver): () => Promise<void>
}

/**
 * Handler invoked after Connection has decoded the transport envelope.
 * `peer` is the Peer the request was admitted as: the operator.
 */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: PeerScope,
  principal?: RequestPrincipal,
) => Promise<ConnectionRpcHandlerResult>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** HTTP methods supported by exact Fetch routes on the shared API channel. */
export type ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'

/** How the node:http bridge presents one request body to its Fetch route. */
export type ConnectionRequestBodyMode = 'buffered' | 'streaming'

/** One exact, transport-independent Fetch route owned by a Host feature. */
export interface ConnectionFetchRoute {
  /** Absolute path below `/api`; query parameters remain available on the request URL. */
  readonly path: string
  /** Methods this route owns. Other methods continue through normal shared-channel dispatch. */
  readonly methods: readonly ConnectionFetchMethod[]
  /** Buffered requests obey the configured JSON cap; streaming requests arrive with backpressure and no aggregate cap. */
  readonly requestBody: ConnectionRequestBodyMode
  /** Handle one request after the physical carrier has applied its trust and authentication policy. */
  readonly fetch: (request: Request, admission?: PeerAdmission) => Promise<Response>
}

/** Host registry for exact Fetch routes that cannot use JSON Remote invocation. */
export interface HostConnectionFetch {
  /**
   * Register one exact route on the shared API channel.
   * @param route - path, methods, and Fetch-shaped implementation.
   * @returns asynchronous disposer removing this exact contribution.
   */
  register(route: ConnectionFetchRoute): () => Promise<void>
}

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one authenticated absolute channel prefix.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>
}

/** Host `ctx.connection` members consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /** Optional identity enrichment for operator-mode requests. */
  readonly identity: HostConnectionIdentity
  /** Application authentication provider registration. */
  readonly authentication: HostConnectionAuthentication
  /** Deployment policy; application mode never falls back to operator authentication. */
  readonly authenticationMode: ConnectionAuthenticationMode
  /** Exact Fetch routes for streaming or browser-native responses. */
  readonly fetch: HostConnectionFetch
  /** The operator Peer every admitted request speaks for; its scope lives as long as Connection. */
  readonly operator: PeerScope

  /**
   * Whether this deployment accepts authorities beyond loopback: true only
   * when a validated `trustedHosts` entry names a non-loopback hostname.
   */
  readonly allowsRemoteAuthorities: boolean

  /**
   * Compose exact Fetch routes and the shared-channel RPC interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler for trusted, authenticated requests.
   */
  createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

  /**
   * Apply Connection's Host/Origin checks and configured authentication to
   * another Web route.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns rejection status, or undefined when the route may accept the request.
   */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

  /**
   * Admit one request using the configured policy after the Host/Origin checks.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns the policy-owned Peer and identity, or a rejection (including unavailable authentication).
   */
  admit(request: ConnectionTrustRequest): PeerAdmission

  /**
   * Authenticate one frontend index request, owning its redirect or refusal.
   * Operator cookies are `Secure` when the mounted Web carrier serves TLS,
   * which only that listener's protocol decides.
   * @param request - root or configured-index HTTP request.
   * @param response - response owned when the result is false.
   * @returns true only when the frontend may serve index.html.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

  /**
   * Return an application URL; only operator mode adds its process token.
   * @param baseUrl - clean application URL whose authority and mount are preserved.
   * @returns a tokenized operator URL or the unchanged application URL.
   */
  authenticatedUrl(baseUrl: string): string
}

/** Transport-independent Fetch handler used by HTTP and worker carriers. */
export interface ConnectionFetchHandler {
  /**
   * Resolve body handling before the bridge reads any request bytes.
   * @param request - request method and URL available from node:http headers.
   * @returns the registered route's body handling mode.
   */
  requestBodyMode(request: { readonly method: string; readonly url: URL }): ConnectionRequestBodyMode

  /**
   * Dispatch one already-authenticated request.
   * @param request - Fetch request below the shared channel.
   * @param admission - optional server-owned admission; absent for operator-only local carriers.
   * @returns the registered response or a 404 response.
   */
  fetch(request: Request, admission?: PeerAdmission): Promise<Response>
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the endpoint-owned success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>>

  /**
   * Open an in-process logical stream when the selected carrier supplies one.
   * Browser transports omit this method; API Gateway owns their WebSocket mux.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `session/follow`.
   * @param payload - channel-owned request payload.
   * @param signal - caller cancellation for this logical stream.
   * @param uplink - Client uplink items the Host method reads through `invocation.uplink()`.
   * @returns decoded stream values from the in-process carrier.
   */
  readonly open?: (
    channel: string,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>
}
