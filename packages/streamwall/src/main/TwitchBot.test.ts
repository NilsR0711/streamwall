import { EventEmitter } from 'events'
import type { StreamData } from 'streamwall-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type TwitchBotType from './TwitchBot'

class FakeChatClient extends EventEmitter {
  ready = false
  setColor = vi.fn().mockResolvedValue(undefined)
  join = vi.fn().mockResolvedValue(undefined)
  say = vi.fn().mockResolvedValue(undefined)
  connect = vi.fn()
  close = vi.fn()
  use = vi.fn()
}

let fakeClient: FakeChatClient

vi.mock('dank-twitch-irc', () => ({
  ChatClient: vi.fn().mockImplementation(function ChatClient() {
    return fakeClient
  }),
  LoginError: class LoginError extends Error {},
  SlowModeRateLimiter: vi.fn(),
}))

const CONFIG = {
  channel: 'testchannel',
  username: 'testuser',
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
    ;({ default: TwitchBot } = await import('./TwitchBot'))
    vi.useFakeTimers()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    unhandledRejections = []
    onUnhandledRejection = (err) => unhandledRejections.push(err)
    process.on('unhandledRejection', onUnhandledRejection)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('connects and emits "connected" once the client is ready', async () => {
    const bot = new TwitchBot(CONFIG)
    const connected = vi.fn()
    bot.on('connected', connected)

    fakeClient.emit('ready')
    await vi.advanceTimersByTimeAsync(0)

    expect(fakeClient.join).toHaveBeenCalledWith(CONFIG.channel)
    expect(connected).toHaveBeenCalled()
    expect(unhandledRejections).toEqual([])
  })

  it('does not crash the process when onReady rejects', async () => {
    fakeClient.setColor.mockRejectedValue(new Error('setColor failed'))
    new TwitchBot(CONFIG)

    fakeClient.emit('ready')
    await vi.advanceTimersByTimeAsync(0)

    expect(unhandledRejections).toEqual([])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('onReady'),
      expect.any(Error),
    )
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
    fakeClient.ready = true
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

  it('does not crash the process when the repeat-announce timeout rejects', async () => {
    fakeClient.ready = true
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
