/**
 * Appends `url` to `favorites` if it isn't already present. Returns the same
 * array reference when `url` is already a favorite, so a redundant
 * add-favorite command is a no-op rather than persisting/broadcasting an
 * unnecessary update.
 */
export function addFavorite(favorites: string[], url: string): string[] {
  if (favorites.includes(url)) {
    return favorites
  }
  return [...favorites, url]
}

/**
 * Removes `url` from `favorites`. Returns the same array reference when
 * `url` isn't present, so removing a non-favorite is a no-op.
 */
export function removeFavorite(favorites: string[], url: string): string[] {
  if (!favorites.includes(url)) {
    return favorites
  }
  return favorites.filter((favoriteUrl) => favoriteUrl !== url)
}
