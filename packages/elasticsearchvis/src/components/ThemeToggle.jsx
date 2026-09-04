import { useEffect, useState } from 'react'

// Dark/light switch for the header. The whole theme is CSS custom properties
// (see the two :root blocks in index.css); this just flips the `data-theme`
// attribute on <html> that the light block keys off, and remembers the choice
// in localStorage. index.html reads that key before first paint, so a returning
// light-mode reader never sees the dark theme flash.
const STORAGE_KEY = 'esvis-theme'

function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' ? 'light' : 'dark'
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(currentTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* private mode / storage disabled — the toggle still works for the session */
    }
  }, [theme])

  const next = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      className="btn theme-toggle"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  )
}
