import { EventEmitter } from 'events'
import type { StreamData } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type TwitchBotType from './TwitchBot'

// Stands in for `@twurple/chat`'s `ChatClient`, whose listeners are registered
// through `onX(handler)` binder methods rather than `on('x', handler)`.
class FakeChatClient extends EventEmitter {
  isConnected = false
  say = vi.fn().mockResolvedValue(undefined)
  connect = vi.fn()
  quit = vi.fn()

  onConnect = (handler: () => void) => this.on('connect', handler)
  onDisconnect = (handler: (manually: boolean, reason?: Error) => void) =>
    this.on('disconnect', handler)
  onAuthenticationFailure = (handler: (text: string) => void) =>
    this.on('authenticationFailure', handler)
  onMessage = (
    handler: (channel: string, user: string, text: string) => void,
  ) => this.on('message', handler)
}

let fakeClient: FakeChatClient
let chatClientOptions: { channels?: string[] } | undefined
let staticAuthProviderArgs: unknown[]
let setColorForUser: ReturnType<typeof vi.fn>
let getTokenInfo: ReturnType<typeof vi.fn>

vi.mock('@twurple/chat', () => ({
  ChatClient: vi.fn().mockImplementation(function ChatClient(options: never) {
    chatClientOptions = options
    return fakeClient
  }),
}))

vi.mock('@twurple/auth', () => ({
  StaticAuthProvider: vi.fn().mockImplementation(function StaticAuthProvider(
    ...args: unknown[]
  ) {
    staticAuthProviderArgs = args
    return { clientId: args[0] }
  }),
  getTokenInfo: (...args: unknown[]) => getTokenInfo(...args),
}))

vi.mock('@twurple/api', () => ({
  ApiClient: vi.fn().mockImplementation(function ApiClient() {
    return { chat: { setColorForUser } }
  }),
}))

const CONFIG = {
  channel: 'testchannel',
  'client-id': 'testclientid',
  token: 'testtoken',
  color: '#ff0000',
  announce: { template: 'now playing', interval: 60, delay: 30 },
  vote: { template: 'winner', interval: 5 },
}

const STREAM: StreamData = {
  kind: 'video',
  link: 'https://example.com/stream',
  _id: 'id1',
  _dataSource: 'test',
}

describe('TwitchBot', () => {
  let TwitchBot: typeof TwitchBotType
  let unhandledRejections: unknown[]
  let onUnhandledRejection: (err: unknown) => void
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.resetModules()
    fakeClient = new FakeChatClient()
    chatClientOptions = undefined
    staticAuthProviderArgs = []
    setColorForUser = vi.fn().mockResolvedValue(undefined)
    getTokenInfo = vi.fn().mockResolvedValue({ userId: 'user-1' })
    ;({ default: TwitchBot } = await import('./TwitchBot'))
    vi.useFakeTimers()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    unhandledRejections = []
    onUnhandledRejection = (err) => unhandledRejections.push(err)
    process.on('unhandledRejection', onUnhandledRejection)
  })

  afterEach(() => {
    if (onUnhandledRejection)
      process.off('unhandledRejection', onUnhandledRejection)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('authenticates with the configured client id and token', () => {
    new TwitchBot(CONFIG)

    // Scopes are deliberately not declared: twurple then resolves the token's
    // real scopes itself, so a token missing `user:manage:chat_color` fails
    // loudly on the color call instead of silently misbehaving elsewhere.
    expect(staticAuthProviderArgs).toEqual([CONFIG['client-id'], CONFIG.token])
  })

  it('strips the legacy "oauth:" prefix from the configured token', () => {
    new TwitchBot({ ...CONFIG, token: `oauth:${CONFIG.token}` })

    expect(staticAuthProviderArgs[1]).toBe(CONFIG.token)
  })

  it('joins the configured channel on connect', () => {
    new TwitchBot(CONFIG)

    expect(chatClientOptions?.channels).toEqual([CONFIG.channel])
  })

  it('connects and emits "connected" once the client is ready', async () => {
    const bot = new TwitchBot(CONFIG)
    const connected = vi.fn()
    bot.on('connected', connected)

    fakeClient.emit('connect')
    await vi.advanceTimersByTimeAsync(0)

    expect(setColorForUser).toHaveBeenCalledWith('user-1', '#FF0000')
    expect(connected).toHaveBeenCalled()
    expect(unhandledRejections).toEqual([])
  })

  it('still emits "connected" when setting the bot color fails', async () => {
    setColorForUser.mockRejectedValue(new Error('missing scope'))
    const bot = new TwitchBot(CONFIG)
    const connected = vi.fn()
    bot.on('connected', connected)

    fakeClient.emit('connect')
    await vi.advanceTimersByTimeAsync(0)

    expect(connected).toHaveBeenCalled()
    expect(unhandledRejections).toEqual([])
  })

  it('closes the connection when authentication fails', () => {
    new TwitchBot(CONFIG)

    fakeClient.emit('authenticationFailure', 'Login authentication failed')

    expect(fakeClient.quit).toHaveBeenCalled()
  })

  it('does not crash the process when the vote tally interval rejects', async () => {
    fakeClient.say.mockRejectedValue(new Error('say failed'))
    const bot = new TwitchBot(CONFIG)
    bot.votes.set(1, 3)

    await vi.advanceTimersByTimeAsync(CONFIG.vote.interval * 1000)

    expect(fakeClient.say).toHaveBeenCalled()
    expect(unhandledRejections).toEqual([])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('tallyVotes'),
      expect.any(Error),
    )
  })

  it('does not crash the process when the dwell-timeout announce rejects', async () => {
    fakeClient.isConnected = true
    fakeClient.say.mockRejectedValue(new Error('say failed'))
    const bot = new TwitchBot(CONFIG)
    bot.streams = [STREAM]
    bot.listeningURL = STREAM.link

    bot.onListeningURLChange(STREAM.link)
    await vi.advanceTimersByTimeAsync(CONFIG.announce.delay * 1000)

    expect(fakeClient.say).toHaveBeenCalled()
    expect(unhandledRejections).toEqual([])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('announce'),
      expect.any(Error),
    )
  })

  it('tallies a vote when a chat message matches the vote pattern', () => {
    const bot = new TwitchBot(CONFIG)

    fakeClient.emit('message', CONFIG.channel, 'viewer', '!2')

    expect(bot.votes.get(2)).toBe(1)
  })

  it('ignores chat messages that do not match the vote pattern', () => {
    const bot = new TwitchBot(CONFIG)

    fakeClient.emit('message', CONFIG.channel, 'viewer', 'hello there')

    expect(bot.votes.size).toBe(0)
  })

  it('does not crash the process when the repeat-announce timeout rejects', async () => {
    fakeClient.isConnected = true
    const bot = new TwitchBot(CONFIG)
    bot.streams = [STREAM]
    bot.listeningURL = STREAM.link

    await bot.announce()
    expect(fakeClient.say).toHaveBeenCalledTimes(1)

    fakeClient.say.mockRejectedValue(new Error('say failed'))
    await vi.advanceTimersByTimeAsync(CONFIG.announce.interval * 1000)

    expect(fakeClient.say).toHaveBeenCalledTimes(2)
    expect(unhandledRejections).toEqual([])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('announce'),
      expect.any(Error),
    )
  })
})
