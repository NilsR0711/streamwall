// This package is isomorphic (runs in Node and in the browser). @types/node 24
// only exposes WHATWG globals like URL/URLSearchParams when a DOM lib is present,
// so pull in the DOM lib here to type the web-standard globals this shared code
// relies on. Scoped to this package's type-check; consumers keep their own libs.
/// <reference lib="dom" />
