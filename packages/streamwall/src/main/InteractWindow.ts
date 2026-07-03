/**
 * The subset of Electron's `BrowserWindow` that {@link InteractWindow} needs.
 * Keeping this narrow lets the window be faked in tests without loading Electron.
 */
export interface InteractBrowserWindow {
  loadURL(url: string): unknown
  setTitle(title: string): void
  focus(): void
  isDestroyed(): boolean
  destroy(): void
  on(event: 'closed', listener: () => void): unknown
}

export type InteractBrowserWindowFactory<Session extends object> = (
  session: Session,
) => InteractBrowserWindow

export interface InteractTarget<Session extends object> {
  /** URL to open interactively (the stream's own page, with native controls). */
  url: string
  /** Window title, e.g. `Interact: <label>`. */
  title: string
  /**
   * Session of the target view. The window is created against this session so
   * it shares cookies/localStorage with the view, letting settings such as
   * player quality/bitrate carry over when the view reloads. Compared by
   * identity to decide whether an open window can be reused.
   */
  session: Session
}

/**
 * Manages a single, reusable pop-out window that loads a stream's original page
 * with its native player controls intact, so an operator can adjust settings
 * such as video quality/bitrate that the wall's media override hides.
 *
 * Each view has its own isolated session, bound to a window when it is created,
 * so interacting with a different view requires a new window. Whenever the
 * operator finishes with a view — either by switching to another one or by
 * closing the window — the supplied `onApply` callback fires so the caller can
 * reload that wall view and pick up the new settings.
 */
export class InteractWindow<Session extends object> {
  private readonly createWindow: InteractBrowserWindowFactory<Session>
  private window: InteractBrowserWindow | null = null
  private current: { session: Session; onApply: () => void } | null = null

  constructor(createWindow: InteractBrowserWindowFactory<Session>) {
    this.createWindow = createWindow
  }

  open(target: InteractTarget<Session>, onApply: () => void): void {
    const window =
      this.window !== null &&
      !this.window.isDestroyed() &&
      this.current?.session === target.session
        ? this.window
        : this.replaceWindow(target.session)

    window.loadURL(target.url)
    window.setTitle(target.title)
    window.focus()
    this.current = { session: target.session, onApply }
  }

  private replaceWindow(session: Session): InteractBrowserWindow {
    const previous = this.window
    const previousApply = this.current?.onApply
    this.window = null
    this.current = null

    const window = this.createWindow(session)
    window.on('closed', () => {
      // Ignore stray close events from a window we have already replaced.
      if (this.window !== window) {
        return
      }
      this.window = null
      const onApply = this.current?.onApply
      this.current = null
      onApply?.()
    })
    this.window = window

    // Tear down the previous window (bound to another view's session) and
    // reload its view. The guard above stops its close event double-applying.
    if (previous && !previous.isDestroyed()) {
      previous.destroy()
    }
    previousApply?.()

    return window
  }
}
