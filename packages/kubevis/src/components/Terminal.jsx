import { useEffect, useRef, useState } from 'react'

// The kubectl terminal: scrollback + prompt + clickable preset commands.
// App owns the scrollback lines (ops append their output); this component
// owns only input-editing state (draft text, history cursor). Input is
// disabled while an op is mid-walk, like opensearchvis's action buttons.
export default function Terminal({ lines, onCommand, disabled, presets }) {
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState([])
  const [histIdx, setHistIdx] = useState(-1) // -1 = editing a fresh line
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  // Keep the newest line visible.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Hand focus back to the prompt when an op finishes.
  useEffect(() => {
    if (!disabled) inputRef.current?.focus()
  }, [disabled])

  function submit(cmd) {
    const trimmed = cmd.trim()
    if (!trimmed) return
    setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed]))
    setHistIdx(-1)
    setDraft('')
    onCommand(trimmed)
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') {
      submit(draft)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(next)
      setDraft(history[next])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx === -1) return
      const next = histIdx + 1
      if (next >= history.length) {
        setHistIdx(-1)
        setDraft('')
      } else {
        setHistIdx(next)
        setDraft(history[next])
      }
    }
  }

  return (
    <div className="terminal" data-fly="terminal">
      <div className="term-presets">
        {presets.map((p) => (
          <button
            key={p.cmd}
            className="preset-chip"
            disabled={disabled}
            title={p.cmd}
            onClick={() => submit(p.cmd)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div
        className="term-scroll"
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l) => (
          <div key={l.id} className={'term-line term-' + l.kind}>
            {l.kind === 'cmd' ? (
              <>
                <span className="term-prompt">$ </span>
                {l.text}
              </>
            ) : (
              l.text || ' '
            )}
          </div>
        ))}
        <div className="term-input-row">
          <span className="term-prompt">$ </span>
          <input
            ref={inputRef}
            className="term-input"
            value={draft}
            disabled={disabled}
            placeholder={
              disabled
                ? 'operation in progress — scrub it with the stepper below'
                : 'type a kubectl command… (or "help")'
            }
            onChange={(e) => {
              setDraft(e.target.value)
              setHistIdx(-1)
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoFocus
          />
        </div>
      </div>
    </div>
  )
}
