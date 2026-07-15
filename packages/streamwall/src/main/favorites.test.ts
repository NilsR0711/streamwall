import { describe, expect, test } from 'vitest'
import { addFavorite, removeFavorite } from './favorites'

describe('addFavorite', () => {
  test('appends a new url', () => {
    expect(addFavorite(['https://a.example/s'], 'https://b.example/s')).toEqual(
      ['https://a.example/s', 'https://b.example/s'],
    )
  })

  test('appends to an empty list', () => {
    expect(addFavorite([], 'https://a.example/s')).toEqual([
      'https://a.example/s',
    ])
  })

  test('is a no-op (same array reference) when the url is already a favorite', () => {
    const favorites = ['https://a.example/s']
    expect(addFavorite(favorites, 'https://a.example/s')).toBe(favorites)
  })
})

describe('removeFavorite', () => {
  test('removes an existing url', () => {
    expect(
      removeFavorite(
        ['https://a.example/s', 'https://b.example/s'],
        'https://a.example/s',
      ),
    ).toEqual(['https://b.example/s'])
  })

  test('is a no-op (same array reference) when the url is not a favorite', () => {
    const favorites = ['https://a.example/s']
    expect(removeFavorite(favorites, 'https://not-a-favorite.example/s')).toBe(
      favorites,
    )
  })

  test('removing from an empty list stays empty', () => {
    expect(removeFavorite([], 'https://a.example/s')).toEqual([])
  })
})
