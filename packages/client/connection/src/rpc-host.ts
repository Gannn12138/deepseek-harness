/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isRemoteAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { OperatorPeer } from './operator-peer.ts'
import type {
  PeerAdmission,
  ApplicationAuthenticationProvider,
  ApplicationPeerAdmission,
  ConnectionAuthenticationMode,
  HostConnectionAuthentication,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
  RequestPrincipalResolver,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The operator Peer every admitted request speaks for. */
  readonly operator: PeerScope
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()
  private principalResolver: RequestPrincipalResolver | undefined
  private authenticationProvider: ApplicationAuthenticationProvider | undefined

  readonly allowsRemoteAuthorities: boolean

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   * @param authenticationMode - explicit policy; application mode has no operator fallback.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
    readonly authenticationMode: ConnectionAuthenticationMode = 'operator',
  ) {
    super(ctx, 'connection')
    this.operator = new OperatorPeer(ctx)
    ctx.effect(() => () => this.operator.dispose(), 'client-connection: operator Peer')
    this.allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Host-side identity resolver registration scoped to its owning plugin. */
  get identity() {
    const owner = this.ctx
    return {
      register: (resolver: RequestPrincipalResolver) => owner.effect(() => {
        if (this.principalResolver !== undefined) throw new Error('connection: an identity resolver is already registered')
        this.principalResolver = resolver
        return () => { this.principalResolver = undefined }
      }, 'client-connection: request identity resolver'),
    }
  }

  /** Application authentication registration scoped to the contributing plugin. */
  get authentication(): HostConnectionAuthentication {
    const owner = this.ctx
    return {
      register: provider => owner.effect(() => {
        if (this.authenticationProvider !== undefined) throw new Error('connection: application authentication is already registered')
        this.authenticationProvider = provider
        return () => { this.authenticationProvider = undefined }
      }, 'client-connection: application authentication'),
    }
  }

  private trusted(request: ConnectionTrustRequest): boolean {
    const carrier = this.ctx.get('webServer')
    return isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? 'http:')
  }

  private applicationAdmission(request: ConnectionTrustRequest): ApplicationPeerAdmission {
    if (this.authenticationProvider === undefined) return { rejection: 503 }
    try {
      return this.authenticationProvider.admit(request)
    } catch (_error) {
      // Provider errors may contain credentials; only the disposition is logged.
      this.ctx.logger.warn('Application authentication failed; request refused. Restore the authentication provider before retrying.')
      return { rejection: 503 }
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Apply the Host/Origin fence and the selected authentication policy. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (!this.trusted(request)) return 403
    if (this.authenticationMode === 'application') {
      const admission = this.applicationAdmission(request)
      return 'rejection' in admission ? admission.rejection : undefined
    }
    return this.browserAuth.isAuthenticated(request, this.ctx.get('webServer')?.protocol === 'https:') ? undefined : 401
  }

  /** Admit through the selected policy; application mode never enriches an operator fallback. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    if (this.authenticationMode === 'application') {
      return this.trusted(request) ? this.applicationAdmission(request) : { rejection: 403 }
    }
    const rejection = this.requestRejection(request)
    if (rejection !== undefined) return { rejection }
    const principal = this.principalResolver?.(request)
    return { peer: this.operator, ...(principal === undefined ? {} : { principal }) }
  }

  /**
   * Authenticate an index request. Operator mode delegates its token exchange;
   * application mode obtains a decision before Connection writes any response.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    if (this.authenticationMode === 'operator') {
      return this.browserAuth.authorizeIndex(request, response, this.ctx.get('webServer')?.protocol === 'https:')
    }
    if (!this.trusted(request)) {
      response.writeHead(403, { 'Cache-Control': 'private, no-store' })
      response.end('forbidden')
      return false
    }
    let decision
    try {
      decision = this.authenticationProvider?.index(request) ?? { kind: 'reject' as const, status: 503 as const }
    } catch (_error) {
      // The provider has not written a response; Connection can safely refuse it.
      this.ctx.logger.warn('Application authentication failed; frontend refused. Restore the authentication provider before retrying.')
      decision = { kind: 'reject' as const, status: 503 as const }
    }
    if (decision.kind === 'allow') return true
    if (decision.kind === 'redirect') {
      response.writeHead(302, { Location: decision.location, 'Cache-Control': 'private, no-store' })
      response.end()
      return false
    }
    response.writeHead(decision.status, { 'Cache-Control': 'private, no-store' })
    response.end(decision.status === 503 ? 'authentication unavailable' : decision.status === 401 ? 'unauthorized' : 'forbidden')
    return false
  }

  /** Return a clean application URL or the operator token exchange URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.authenticationMode === 'application' ? baseUrl : this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request, admission) => {
        if (this.authenticationMode === 'application' && (admission === undefined || !('principal' in admission) || admission.principal === undefined)) {
          const status = admission !== undefined && 'rejection' in admission ? admission.rejection : 401
          return Promise.resolve(new Response(status === 503 ? 'authentication unavailable' : 'unauthorized', {
            status, headers: { 'Cache-Control': 'private, no-store' },
          }))
        }
        if (admission !== undefined && 'rejection' in admission) {
          return Promise.resolve(new Response('unauthorized', { status: admission.rejection }))
        }
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request, admission)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request, admission)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler, this.operator)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection, { 'Cache-Control': 'private, no-store' })
          res.end(admission.rejection === 503 ? 'authentication unavailable' : admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, {
          requestBodyMode: fetchHandler.requestBodyMode,
          fetch: request => fetchHandler.fetch(request, admission),
        })
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler, this.operator),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  peer: PeerScope,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request, admission?: PeerAdmission): Promise<Response> {
      if (admission !== undefined && 'rejection' in admission) {
        return new Response('unauthorized', { status: admission.rejection })
      }
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, admission?.peer ?? peer, admission?.principal)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: Awaited<ReturnType<ConnectionRpcHandler>>): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
