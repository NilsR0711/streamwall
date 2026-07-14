import { Color } from 'streamwall-shared'

// `import { Color } from 'streamwall-shared'` binds only the value; alias
// the instance type (as returned by the Color factory) for use in
// styled-component prop types.
export type ColorInstance = ReturnType<typeof Color>
