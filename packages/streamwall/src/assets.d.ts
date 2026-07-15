// Ambient declarations for side-effect imports resolved by the bundler (Vite)
// but opaque to tsc: stylesheet imports and @fontsource font packages.
declare module '*.css'
declare module '@fontsource/*'

// Vite's `?raw` suffix inlines a file's contents as a string at build time.
declare module '*.toml?raw' {
  const content: string
  export default content
}
