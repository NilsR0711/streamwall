import { useId } from 'preact/hooks'
import type { SVGProps } from 'react'

// Inlined from svg-loaders-react's TailSpin (MIT, Copyright (c) 2014 Sam
// Herbert, Copyright (c) 2018 Adam Wanninger), which is CJS-only and so has
// no ESM/browser build for Vite's resolver to route through the
// `react` -> `preact/compat` alias under this repo's vitest test stack (see
// vitest.config.ts and issue #182). Inlining it as a first-party component
// keeps the visuals identical while making it a plain function component
// that resolves correctly in both the app and its tests.
export function TailSpin(props: SVGProps<SVGSVGElement>) {
  // Multiple tiles can be loading at once (see overlay.tsx), so the gradient
  // id must be unique per instance rather than a hardcoded string (#212).
  const gradientId = `tailSpinGradient-${useId()}`

  return (
    <svg width={38} height={38} viewBox="0 0 38 38" {...props}>
      <defs>
        <linearGradient
          x1="8.042%"
          y1="0%"
          x2="65.682%"
          y2="23.865%"
          id={gradientId}
        >
          <stop stopColor="#fff" stopOpacity={0} offset="0%" />
          <stop stopColor="#fff" stopOpacity={0.631} offset="63.146%" />
          <stop stopColor="#fff" offset="100%" />
        </linearGradient>
      </defs>
      <g transform="translate(1 1)" fill="none" fillRule="evenodd">
        <path
          d="M36 18c0-9.94-8.06-18-18-18"
          stroke={`url(#${gradientId})`}
          strokeWidth={2}
        >
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 18 18"
            to="360 18 18"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </path>
        <circle fill="#fff" cx={36} cy={18} r={1}>
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 18 18"
            to="360 18 18"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </circle>
      </g>
    </svg>
  )
}
