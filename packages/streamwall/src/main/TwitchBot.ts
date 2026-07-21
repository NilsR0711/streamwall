import { ApiClient } from '@twurple/api'
import { getTokenInfo, StaticAuthProvider } from '@twurple/auth'
import { ChatClient } from '@twurple/chat'
import Color from 'color'
import * as ejs from 'ejs'
import EventEmitter from 'events'
import { StreamList, StreamwallState } from 'streamwall-shared'
import { matchesState } from 'xstate'
import { StreamwallConfig } from './cliArgs'
import log from './logger'

const VOTE_RE = /^!(\d+)$/

type TwitchBotConfig = StreamwallConfig['twitch'] & {
  'client-id': string
  token: string
  channel: string
}

export default class TwitchBot extends EventEmitter {
  config: TwitchBotConfig
  announceTemplate: ejs.TemplateFunction
  voteTemplate!: ejs.TemplateFunction
  client: ChatClient
  streams: StreamList
  listeningURL: string | null
  dwellTimeout: NodeJS.Timeout | undefined
  announceTimeouts: Map<string, NodeJS.Timeout>
  votes!: Map<number, number>
  private apiClient: ApiClient
  private accessToken: string

  constructor(config: TwitchBotConfig) {
    super()
    const { channel, vote } = config
    this.config = config
    this.announceTemplate = ejs.compile(config.announce.template)

    // Tokens from the usual Twitch token helpers often carry the prefix used
    // by the raw IRC `PASS oauth:<token>` handshake; twurple wants the bare
    // token.
    this.accessToken = config.token.replace(/^oauth:/, '')
    const authProvider = new StaticAuthProvider(
      config['client-id'],
      this.accessToken,
    )
    this.apiClient = new ApiClient({ authProvider })

    const client = new ChatClient({ authProvider, channels: [channel] })
    this.client = client

    this.streams = []
    this.listeningURL = null
    this.dwellTimeout = undefined
    this.announceTimeouts = new Map()

    if (vote.interval) {
      this.voteTemplate = ejs.compile(config.vote.template)
      this.votes = new Map()
      setInterval(() => {
        this.tallyVotes().catch((err) =>
          this.handleAsyncError('tallyVotes', err),
        )
      }, vote.interval * 1000)
    }

    client.onConnect(() => {
      this.onReady().catch((err) => this.handleAsyncError('onReady', err))
    })
    client.onAuthenticationFailure((text) => {
      log.error('Twitch authentication failed:', text)
      client.quit()
    })
    client.onDisconnect((_manually, reason) => {
      log.info('Twitch bot disconnected.')
      if (reason != null) {
        log.error('Twitch bot disconnected due to error:', reason)
      }
    })
    client.onMessage((_channel, _user, text) => {
      this.onMsg(text)
    })
  }

  connect() {
    const { client } = this
    client.connect()
  }

  private handleAsyncError(context: string, err: unknown) {
    console.error(`Twitch bot error (${context}):`, err)
  }

  async onReady() {
    await this.setBotColor()
    this.emit('connected')
  }

  /**
   * Twitch retired the `/color` chat command, so the bot's username color is
   * set through Helix instead. That needs the `user:manage:chat_color` scope,
   * which older tokens won't carry — a purely cosmetic failure that must not
   * keep the bot from announcing.
   */
  private async setBotColor() {
    const { color: colorText } = this.config
    try {
      const { userId } = await getTokenInfo(
        this.accessToken,
        this.config['client-id'],
      )
      if (!userId) {
        log.warn('Twitch token has no associated user; skipping bot color.')
        return
      }
      const color = Color(colorText).hex() as `#${string}`
      await this.apiClient.chat.setColorForUser(userId, color)
    } catch (err) {
      log.warn(
        'Could not set Twitch bot username color (needs the "user:manage:chat_color" scope):',
        err,
      )
    }
  }

  onState({ views, streams }: StreamwallState) {
    this.streams = streams

    const listeningView = views.find(({ state }) =>
      matchesState(state, 'displaying.running.audio.listening'),
    )
    if (!listeningView) {
      return
    }

    const listeningURL = listeningView.context.content?.url ?? null
    if (listeningURL === this.listeningURL) {
      return
    }
    this.listeningURL = listeningURL
    this.onListeningURLChange(listeningURL)
  }

  onListeningURLChange(listeningURL: string | null) {
    if (!listeningURL) {
      return
    }

    const { announce } = this.config
    clearTimeout(this.dwellTimeout)
    this.dwellTimeout = setTimeout(() => {
      if (!this.announceTimeouts.has(listeningURL)) {
        this.announce().catch((err) => this.handleAsyncError('announce', err))
      }
    }, announce.delay * 1000)
  }

  async announce() {
    const { client, listeningURL, streams } = this
    const { channel, announce } = this.config

    if (!client.isConnected || !listeningURL) {
      return
    }

    const stream = streams.find((s) => s.link === listeningURL)
    if (!stream) {
      return
    }

    const msg = this.announceTemplate({ stream })
    await client.say(channel, msg)

    const timeout = setTimeout(() => {
      this.announceTimeouts.delete(listeningURL)
      if (this.listeningURL === listeningURL) {
        this.announce().catch((err) => this.handleAsyncError('announce', err))
      }
    }, announce.interval * 1000)
    this.announceTimeouts.set(listeningURL, timeout)
  }

  async tallyVotes() {
    const { client } = this
    const { channel } = this.config
    if (this.votes.size === 0) {
      return
    }

    let voteCount = 0
    let selectedIdx = null
    for (const [idx, value] of this.votes) {
      if (value > voteCount) {
        voteCount = value
        selectedIdx = idx
      }
    }

    if (selectedIdx === null) {
      return
    }

    const msg = this.voteTemplate({ selectedIdx, voteCount })
    await client.say(channel, msg)

    // Index spaces starting with 1
    this.emit('setListeningView', selectedIdx - 1)

    this.votes = new Map()
  }

  onMsg(messageText: string) {
    const { vote } = this.config
    if (!vote.interval) {
      return
    }

    const match = messageText.match(VOTE_RE)
    if (!match) {
      return
    }

    const idx = Number(match[1])

    this.votes.set(idx, (this.votes.get(idx) || 0) + 1)
  }
}
