import { describe, expect, it } from 'vitest'
import {
  normalizeVersion,
  parseRepositorySlug,
  releaseNotesUrl,
} from './updateStatus'

describe('parseRepositorySlug', () => {
  it("parses npm's github: shorthand into an owner/name slug", () => {
    expect(parseRepositorySlug('github:NilsR0711/streamwall')).toBe(
      'NilsR0711/streamwall',
    )
  })

  it('returns null for an unsupported form rather than throwing, so a bad repository field only costs the release-notes link', () => {
    expect(parseRepositorySlug('https://example.com/repo.git')).toBeNull()
    expect(parseRepositorySlug(undefined)).toBeNull()
  })
})

describe('releaseNotesUrl', () => {
  it('points at the v-prefixed tag the forge publisher creates', () => {
    expect(releaseNotesUrl('NilsR0711/streamwall', '0.9.2')).toBe(
      'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.2',
    )
  })

  it('does not double-prefix a release name that already carries the v', () => {
    expect(releaseNotesUrl('NilsR0711/streamwall', 'v0.9.2')).toBe(
      'https://github.com/NilsR0711/streamwall/releases/tag/v0.9.2',
    )
  })

  it('yields no link when the repository is unknown', () => {
    expect(releaseNotesUrl(null, '0.9.2')).toBeNull()
  })
})

describe('normalizeVersion', () => {
  it('strips the tag prefix so the banner can compare against app.getVersion()', () => {
    expect(normalizeVersion('v0.9.2')).toBe('0.9.2')
    expect(normalizeVersion('0.9.2')).toBe('0.9.2')
  })
})
