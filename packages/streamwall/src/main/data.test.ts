import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StreamDataContent } from 'streamwall-shared'
import { afterEach, describe, expect, test } from 'vitest'
import { pollDataURL, watchDataFile } from './data'

function writeTomlFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-data-'))
  const file = path.join(dir, 'streams.toml')
  writeFileSync(file, contents)
  return file
}

describe('watchDataFile', () => {
  test('keeps valid entries and skips invalid ones', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
kind = "video"

[[streams]]
kind = "audio"

[[streams]]
link = "https://c.example/s"
`)
    const gen = watchDataFile(file)
    try {
      const { value } = await gen.next()
      expect(value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://a.example/s',
        'https://c.example/s',
      ])
    } finally {
      await gen.return(undefined)
    }
  })

  test('strips injected internal identity fields', async () => {
    const file = writeTomlFile(`
[[streams]]
link = "https://a.example/s"
_id = "injected"
_dataSource = "attacker"
`)
    const gen = watchDataFile(file)
    try {
      const { value } = await gen.next()
      expect(value).toHaveLength(1)
      expect(value?.[0]).not.toHaveProperty('_id')
      expect(value?.[0]).not.toHaveProperty('_dataSource')
    } finally {
      await gen.return(undefined)
    }
  })

  test('yields an empty list when streams is not an array', async () => {
    const file = writeTomlFile('streams = "not an array"\n')
    const gen = watchDataFile(file)
    try {
      const { value } = await gen.next()
      expect(value).toEqual([])
    } finally {
      await gen.return(undefined)
    }
  })
})

describe('pollDataURL', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  async function serveJson(body: unknown): Promise<string> {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    )
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}/`
  }

  test('keeps valid entries and skips invalid ones from a JSON body', async () => {
    const url = await serveJson([
      { link: 'https://a.example/s', kind: 'video' },
      { kind: 'audio' },
      { link: 'https://b.example/s', _id: 'injected' },
    ])
    const gen = pollDataURL(url, 999)
    try {
      const { value } = await gen.next()
      expect(value?.map((s: StreamDataContent) => s.link)).toEqual([
        'https://a.example/s',
        'https://b.example/s',
      ])
      expect(value?.[1]).not.toHaveProperty('_id')
    } finally {
      await gen.return(undefined)
    }
  })

  test('yields an empty list when the JSON body is not an array', async () => {
    const url = await serveJson({ not: 'an array' })
    const gen = pollDataURL(url, 999)
    try {
      const { value } = await gen.next()
      expect(value).toEqual([])
    } finally {
      await gen.return(undefined)
    }
  })
})
