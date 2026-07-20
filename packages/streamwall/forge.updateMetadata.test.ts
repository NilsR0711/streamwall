import type { ForgeMakeResult } from '@electron-forge/shared-types'
import { load } from 'js-yaml'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendUpdateMetadata,
  isUpdateArtifact,
  renderUpdateMetadata,
  updateMetadataFileName,
} from './forge.updateMetadata'

// Precomputed externally: base64 SHA-512 of the literal artifact bytes the
// tests write below, so the assertions do not re-run the implementation.
const NSIS_BYTES = 'nsis installer bytes'
const NSIS_SHA512 =
  'wdYJm9r51xTqFU9rcz7ZG3riwAZ6PNR39x4qGVF08F5Y6vlliVbOsOnZLxq3VAqIUgCzMaa13RKaZBrZo1BG/g=='
const ZIP_BYTES = 'mac zip bytes'
const ZIP_SHA512 =
  '4o8y907Llb+JGA249vShflSR/l55jC7mlXwYbzcroCkzHZ3++Uvz1qOEy3N0ohlWXnhOKCarZ2ck0644YPguJg=='

const releaseDate = new Date('2026-07-20T12:00:00.000Z')

async function makeArtifacts(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'streamwall-update-metadata-'))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content)
  }
  return dir
}

function makeResult(
  platform: string,
  dir: string,
  artifactNames: string[],
): ForgeMakeResult {
  return {
    artifacts: artifactNames.map((name) => path.join(dir, name)),
    packageJSON: { version: '0.9.2' },
    platform: platform as ForgeMakeResult['platform'],
    arch: 'x64',
  }
}

describe('updateMetadataFileName', () => {
  it("uses electron-updater's per-platform file names", () => {
    expect(updateMetadataFileName('win32')).toBe('latest.yml')
    expect(updateMetadataFileName('darwin')).toBe('latest-mac.yml')
  })

  it('produces none for Linux, where updates go through the package manager', () => {
    expect(updateMetadataFileName('linux')).toBeNull()
  })
})

describe('isUpdateArtifact', () => {
  it('selects the NSIS installer on Windows, not its blockmap', () => {
    expect(isUpdateArtifact('win32', '/make/streamwall-setup-0.9.2.exe')).toBe(
      true,
    )
    expect(
      isUpdateArtifact('win32', '/make/streamwall-setup-0.9.2.exe.blockmap'),
    ).toBe(false)
  })

  it('selects the ZIP on macOS, the only format Squirrel.Mac installs', () => {
    expect(
      isUpdateArtifact('darwin', '/make/Streamwall-darwin-arm64-0.9.2.zip'),
    ).toBe(true)
  })

  it('selects nothing on Linux', () => {
    expect(isUpdateArtifact('linux', '/make/streamwall_0.9.2_amd64.deb')).toBe(
      false,
    )
  })
})

describe('renderUpdateMetadata', () => {
  it('emits the fields electron-updater requires, including the legacy path/sha512 pair', () => {
    const yaml = renderUpdateMetadata(
      '0.9.2',
      [{ url: 'streamwall-setup-0.9.2.exe', sha512: NSIS_SHA512, size: 20 }],
      releaseDate,
    )

    expect(load(yaml)).toEqual({
      version: '0.9.2',
      files: [
        { url: 'streamwall-setup-0.9.2.exe', sha512: NSIS_SHA512, size: 20 },
      ],
      path: 'streamwall-setup-0.9.2.exe',
      sha512: NSIS_SHA512,
      releaseDate: '2026-07-20T12:00:00.000Z',
    })
  })
})

describe('appendUpdateMetadata', () => {
  it('writes latest.yml next to the Windows installer with its verified hash and size', async () => {
    const dir = await makeArtifacts({
      'streamwall-setup-0.9.2.exe': NSIS_BYTES,
      'streamwall-setup-0.9.2.exe.blockmap': 'blockmap bytes',
    })
    const result = makeResult('win32', dir, [
      'streamwall-setup-0.9.2.exe',
      'streamwall-setup-0.9.2.exe.blockmap',
    ])

    await appendUpdateMetadata([result], releaseDate)

    const written = load(await readFile(path.join(dir, 'latest.yml'), 'utf8'))
    expect(written).toEqual({
      version: '0.9.2',
      files: [
        {
          url: 'streamwall-setup-0.9.2.exe',
          sha512: NSIS_SHA512,
          size: 20,
        },
      ],
      path: 'streamwall-setup-0.9.2.exe',
      sha512: NSIS_SHA512,
      releaseDate: '2026-07-20T12:00:00.000Z',
    })
  })

  it('appends the metadata file to the artifacts so the GitHub publisher uploads it', async () => {
    const dir = await makeArtifacts({
      'Streamwall-darwin-arm64-0.9.2.zip': ZIP_BYTES,
    })
    const result = makeResult('darwin', dir, [
      'Streamwall-darwin-arm64-0.9.2.zip',
    ])

    const [updated] = await appendUpdateMetadata([result], releaseDate)

    expect(updated.artifacts).toContain(path.join(dir, 'latest-mac.yml'))
    const written = load(
      await readFile(path.join(dir, 'latest-mac.yml'), 'utf8'),
    ) as { files: unknown }
    expect(written.files).toEqual([
      {
        url: 'Streamwall-darwin-arm64-0.9.2.zip',
        sha512: ZIP_SHA512,
        size: 13,
      },
    ])
  })

  it('leaves Linux results untouched, since electron-updater cannot update .deb/.rpm installs', async () => {
    const dir = await makeArtifacts({ 'streamwall_0.9.2_amd64.deb': 'deb' })
    const result = makeResult('linux', dir, ['streamwall_0.9.2_amd64.deb'])

    const [updated] = await appendUpdateMetadata([result], releaseDate)

    expect(updated.artifacts).toEqual([
      path.join(dir, 'streamwall_0.9.2_amd64.deb'),
    ])
  })

  it('lists every arch of a platform in one metadata file, since electron-updater fetches exactly one per platform', async () => {
    const dir = await makeArtifacts({
      'streamwall-setup-0.9.2-x64.exe': NSIS_BYTES,
      'streamwall-setup-0.9.2-arm64.exe': NSIS_BYTES,
    })
    const x64 = makeResult('win32', dir, ['streamwall-setup-0.9.2-x64.exe'])
    const arm64 = makeResult('win32', dir, ['streamwall-setup-0.9.2-arm64.exe'])

    const [updatedX64, updatedArm64] = await appendUpdateMetadata(
      [x64, arm64],
      releaseDate,
    )

    const written = load(
      await readFile(path.join(dir, 'latest.yml'), 'utf8'),
    ) as { files: Array<{ url: string }> }
    expect(written.files.map((file) => file.url)).toEqual([
      'streamwall-setup-0.9.2-x64.exe',
      'streamwall-setup-0.9.2-arm64.exe',
    ])
    expect(updatedX64.artifacts).toContain(path.join(dir, 'latest.yml'))
    expect(updatedArm64.artifacts).not.toContain(path.join(dir, 'latest.yml'))
  })

  it('writes no metadata when a platform produced no updatable artifact, rather than an empty file', async () => {
    const dir = await makeArtifacts({ RELEASES: 'squirrel leftovers' })
    const result = makeResult('win32', dir, ['RELEASES'])

    const [updated] = await appendUpdateMetadata([result], releaseDate)

    expect(updated.artifacts).toEqual([path.join(dir, 'RELEASES')])
    await expect(
      readFile(path.join(dir, 'latest.yml'), 'utf8'),
    ).rejects.toThrow()
  })
})
