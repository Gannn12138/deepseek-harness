/** Application-mode admission, including the real Loader and HTTP carrier. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '../src/index.ts'
import { BrowserAuth } from '../src/browser-auth.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'
import type { ApplicationAuthenticationProvider, ConnectionIndexResponse } from '../src/rpc.ts'

const dispose: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })

async function service(mode: Connection.ConnectionAuthenticationMode | 'default' = 'application') {
  const ctx = new Context()
  provideBrowserCredentials(ctx)
  const auth = await BrowserAuth.create(ctx.root, ctx.credentials, 30)
  const connection = new Connection.HostConnectionService(ctx, [], auth, mode === 'default' ? undefined : mode)
  dispose.push(() => ctx.fiber.dispose())
  return { ctx, auth, connection }
}

const trusted = { headers: { host: 'localhost' } }
function reply() {
  const state: { status?: number; headers?: Readonly<Record<string, string>>; body?: string } = {}
  const response: ConnectionIndexResponse = {
    writeHead(status, headers) { state.status = status; if (headers) state.headers = headers },
    end(body) { if (body !== undefined) state.body = body },
  }
  return { response, state }
}

function provider(peer: Connection.PeerScope): ApplicationAuthenticationProvider {
  return {
    admit: () => ({ peer, principal: { issuer: 'https://idp.test.invalid', id: 'alice' } }),
    index: () => ({ kind: 'redirect', location: '/login' }),
  }
}

describe('application authentication policy', () => {
  it('M-21-3: fails closed without a provider, including legacy resolver and token attempts', async () => {
    const { connection, auth } = await service()
    const denied = connection.admit(trusted)
    expect('rejection' in denied ? denied.rejection : undefined).toBe(503)
    expect(connection.requestRejection(trusted)).toBe(503)
    const unregister = connection.identity.register(() => ({ issuer: 'legacy', id: 'operator' }))
    dispose.push(unregister)
    expect(connection.admit(trusted)).toEqual({ rejection: 503 })
    const clean = 'http://localhost/'
    expect(connection.authenticatedUrl(clean)).toBe(clean)
    const token = new URL(auth.authenticatedUrl(clean)).search
    const target = reply()
    expect(connection.authorizeIndex({ ...trusted, url: '/' + token }, target.response)).toBe(false)
    expect(target.state.status).toBe(503)
    expect(target.state.headers?.['Cache-Control']).toBe('private, no-store')
  })

  it('M-21-2: never calls a legacy resolver when the application provider admits', async () => {
    const { connection } = await service()
    const resolver = vi.fn(() => ({ issuer: 'legacy', id: 'operator' }))
    dispose.push(connection.identity.register(resolver))
    dispose.push(connection.authentication.register(provider(connection.operator)))
    expect(connection.admit(trusted)).toMatchObject({ principal: { issuer: 'https://idp.test.invalid', id: 'alice' } })
    expect(connection.requestRejection(trusted)).toBeUndefined()
    connection.authorizeIndex(trusted, reply().response)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('checks Host and Origin before invoking the application provider', async () => {
    const { connection } = await service()
    const candidate = provider(connection.operator)
    const check = vi.spyOn(candidate, 'admit')
    dispose.push(connection.authentication.register(candidate))
    expect(connection.admit({ headers: { host: 'attacker.invalid' } })).toEqual({ rejection: 403 })
    expect(connection.admit({ headers: { host: 'localhost', origin: 'https://attacker.invalid' } })).toEqual({ rejection: 403 })
    const target = reply()
    expect(connection.authorizeIndex({ headers: { host: 'attacker.invalid' } }, target.response)).toBe(false)
    expect(target.state.status).toBe(403)
    expect(check).not.toHaveBeenCalled()
  })

  it('M-21-1 / M-21-4: carries the provider Peer and principal and refuses duplicate registration', async () => {
    const { ctx, connection } = await service()
    const peer = new Connection.OperatorPeer(ctx)
    dispose.push(() => peer.dispose())
    const candidate = provider(peer)
    const unregister = connection.authentication.register(candidate)
    dispose.push(unregister)
    expect(connection.admit(trusted)).toEqual({ peer, principal: { issuer: 'https://idp.test.invalid', id: 'alice' } })
    expect(connection.requestRejection(trusted)).toBeUndefined()
    expect(() => connection.authentication.register(candidate)).toThrow(/already registered/)
    dispose.push(connection.identity.register(() => undefined))
    expect(() => connection.identity.register(() => undefined)).toThrow(/already registered/)
    const preserved = connection.admit(trusted)
    expect('peer' in preserved ? preserved.peer : undefined).toBe(peer)
    const target = reply()
    expect(connection.authorizeIndex(trusted, target.response)).toBe(false)
    expect(target.state.status).toBe(302)
    expect(target.state.headers?.Location).toBe('/login')
    await unregister()
    expect(connection.admit(trusted)).toEqual({ rejection: 503 })
  })

  it('M-21-5: contains provider exceptions and preserves explicit refusal statuses', async () => {
    const { connection } = await service()
    const candidate: ApplicationAuthenticationProvider = {
      admit: () => { throw new Error('secret-must-not-reach-response') },
      index: () => { throw new Error('secret-must-not-reach-response') },
    }
    const unregister = connection.authentication.register(candidate)
    dispose.push(unregister)
    expect(connection.admit(trusted)).toEqual({ rejection: 503 })
    const target = reply()
    expect(connection.authorizeIndex(trusted, target.response)).toBe(false)
    expect(target.state.status).toBe(503)
    expect(target.state.body).not.toContain('secret')
    await unregister()
    for (const status of [401, 403, 503] as const) {
      const remove = connection.authentication.register({ admit: () => ({ rejection: status }), index: () => ({ kind: 'reject', status }) })
      expect(connection.requestRejection(trusted)).toBe(status)
      const response = reply()
      expect(connection.authorizeIndex(trusted, response.response)).toBe(false)
      expect(response.state.status).toBe(status)
      await remove()
    }
  })

  it('allows an authenticated index and removes authentication with its owner fiber', async () => {
    const { ctx, connection } = await service()
    const owner = ctx.plugin({ apply(child: Context) {
      child.connection.authentication.register({ admit: () => ({ rejection: 401 }), index: () => ({ kind: 'allow' }) })
    } })
    await owner.await()
    expect(connection.authorizeIndex(trusted, reply().response)).toBe(true)
    expect(connection.admit(trusted)).toEqual({ rejection: 401 })
    await owner.dispose()
    expect(connection.admit(trusted)).toEqual({ rejection: 503 })
  })

  it('rejects direct shared Fetch calls without application admission', async () => {
    const { connection } = await service()
    const called = vi.fn(async () => new Response('must not run'))
    dispose.push(connection.fetch.register({ path: '/api/probe', methods: ['GET'], requestBody: 'buffered', fetch: called }))
    const handler = connection.createSharedFetchHandler('/api')
    const request = new Request('http://localhost/api/probe')
    expect((await handler.fetch(request)).status).toBe(401)
    expect((await handler.fetch(request, { peer: connection.operator })).status).toBe(401)
    expect((await handler.fetch(request, { rejection: 503 })).status).toBe(503)
    expect(called).not.toHaveBeenCalled()
  })

  it('M-21-6: keeps legacy operator authentication when the mode is omitted', async () => {
    const { connection, auth } = await service('default')
    expect(connection.authenticationMode).toBe('operator')
    expect(connection.admit(trusted)).toEqual({ rejection: 401 })
    expect(new URL(connection.authenticatedUrl('http://localhost/')).searchParams.has('token')).toBe(true)
    const target = reply()
    const launch = new URL(auth.authenticatedUrl('http://localhost/'))
    expect(connection.authorizeIndex({ ...trusted, method: 'GET', url: '/' + launch.search }, target.response)).toBe(false)
    const cookie = target.state.headers?.['set-cookie']?.split(';')[0]
    expect(cookie).toBeDefined()
    const request = { headers: { host: 'localhost', cookie } }
    expect(connection.admit(request)).toEqual({ peer: connection.operator })
    const remove = connection.identity.register(() => ({ issuer: 'legacy', id: 'operator' }))
    expect(connection.admit(request)).toEqual({ peer: connection.operator, principal: { issuer: 'legacy', id: 'operator' } })
    await remove()
    expect(connection.admit(request)).toEqual({ peer: connection.operator })
  })
})
