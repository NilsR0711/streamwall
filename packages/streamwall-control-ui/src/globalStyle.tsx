import { useEffect, useState } from 'preact/hooks'
import { createGlobalStyle, styled } from 'styled-components'

/**
 * Theme tokens. Light is the base; dark is applied either by the OS setting
 * (prefers-color-scheme) when no explicit choice is made, or by an explicit
 * `data-theme` attribute on <html> (set by the theme switcher).
 *
 *   <html>                       -> follow OS
 *   <html data-theme="system">   -> follow OS
 *   <html data-theme="light">    -> force light
 *   <html data-theme="dark">     -> force dark
 */
const lightTokens = `
  --bg:         #eef1f6;
  --surface:    #ffffff;
  --surface-2:  #f4f6fa;
  --surface-3:  #e9edf3;
  --border:     #dce1ea;
  --border-2:   #c9d1dd;
  --text:       #161b24;
  --text-dim:   #5a6473;
  --text-faint: #9aa3b1;
  --accent:     #d6402a;
  --accent-2:   #0a84ff;
  --accent-soft:#fbe4df;
  --live:       #d6402a;
  --ok:         #17a35a;
  --cell-bg:    #20242c;
  --shadow:     0 6px 22px rgba(40,55,80,.12);
`
const darkTokens = `
  --bg:         #0b0d11;
  --surface:    #13161c;
  --surface-2:  #191d25;
  --surface-3:  #222731;
  --border:     #2a303b;
  --border-2:   #353c49;
  --text:       #e8ecf2;
  --text-dim:   #939cab;
  --text-faint: #5b6470;
  --accent:     #f24d2e;
  --accent-2:   #4cc2ff;
  --accent-soft:#2a1a16;
  --live:       #ff445e;
  --ok:         #3ddc84;
  --cell-bg:    #0e1115;
  --shadow:     0 8px 28px rgba(0,0,0,.45);
`

export const GlobalStyle = createGlobalStyle`
  :root {
    color-scheme: light dark;

    --font-display: 'Saira Stencil One', 'Oswald', system-ui, sans-serif;
    --font-ui: 'IBM Plex Sans', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace;

    --r-sm: 6px;
    --r-md: 9px;
    --r-lg: 12px;
    --sp: 4px;

    /* base = light */
    ${lightTokens}
  }

  /* Follow the OS when no explicit choice was made */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]),
    :root[data-theme='system'] {
      ${darkTokens}
    }
  }

  /* Explicit overrides from the theme switcher */
  :root[data-theme='light'] { ${lightTokens} }
  :root[data-theme='dark']  { ${darkTokens} }

  html {
    height: 100%;
  }

  html, body {
    display: flex;
    flex: 1;
    margin: 0;
    /* body is a flex item of html with no explicit min-width, so its
       automatic minimum size falls back to its content's min-content width -
       which can exceed the viewport and inflate body past it even with the
       margin reset above (see #225). */
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
  }

  * { box-sizing: border-box; }

  /* ---- Sidebar (stream list / custom streams / access) ---- */
  .stream-list h2 {
    font-family: var(--font-display);
    font-weight: normal;
    font-size: 15px;
    letter-spacing: 0.04em;
    color: var(--text);
    margin: 24px 0 12px;
    padding-bottom: 6px;
    border-bottom: 2px solid var(--accent);
    display: inline-block;
  }
  .stream-list h3 {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-dim);
    margin: 18px 0 8px;
  }
  .stream-list h3 .ct {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 7px;
    margin-left: 6px;
  }
  .stream-list input,
  .stream-list select {
    font-family: var(--font-ui);
    font-size: 13px;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 7px 10px;
  }
  .stream-list input::placeholder { color: var(--text-faint); }
  .stream-list input:focus,
  .stream-list select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .stream-list .filter-input {
    width: 100%;
    margin-bottom: 4px;
  }
  .stream-list button {
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: var(--r-sm);
    padding: 7px 12px;
    cursor: pointer;
  }
  .stream-list button:hover { filter: brightness(1.08); }
  .stream-list a { color: var(--accent-2); text-decoration: none; }
  .stream-list a:hover { text-decoration: underline; }
`

type ThemeChoice = 'system' | 'light' | 'dark'
const THEME_KEY = 'streamwall:theme'

const StyledThemeToggle = styled.div`
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);

  button {
    display: grid;
    place-items: center;
    width: 27px;
    height: 24px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    padding: 0;
  }
  button:hover {
    color: var(--text-dim);
  }
  button.active {
    background: var(--accent);
    color: #fff;
  }
  svg {
    width: 15px;
    height: 15px;
  }
`

/**
 * Theme switcher. Writes the choice to <html data-theme> (read by GlobalStyle)
 * and persists it in localStorage. 'system' clears the override so the OS
 * setting (prefers-color-scheme) takes over.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as ThemeChoice) ?? 'system'
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // ignore (e.g. storage disabled)
    }
  }, [theme])

  const opts = [
    {
      key: 'system' as const,
      label: 'System',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      ),
    },
    {
      key: 'light' as const,
      label: 'Hell',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ),
    },
    {
      key: 'dark' as const,
      label: 'Dunkel',
      icon: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ),
    },
  ]

  return (
    <StyledThemeToggle role="group" aria-label="Color scheme">
      {opts.map(({ key, label, icon }) => (
        <button
          key={key}
          type="button"
          class={theme === key ? 'active' : undefined}
          title={label}
          aria-label={label}
          aria-pressed={theme === key}
          onClick={() => setTheme(key)}
        >
          {icon}
        </button>
      ))}
    </StyledThemeToggle>
  )
}
