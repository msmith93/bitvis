// A short list of official-docs links under an explanation, for readers who want
// to go past the walkthrough. Opens in a new tab — the simulation keeps its
// state.
//
// Two callers, deliberately: App's "What's happening" panel renders the running
// op's `docs` array (see `opDocs`), and a close-up step renders its own optional
// `link`. Same markup both places, so a link inside a zoom reads as the same
// affordance as a link outside one.
export default function DocLinks({ title, links }) {
  return (
    <div className="explain-docs">
      <span className="explain-docs-title">{title}</span>
      <ul>
        {links.map((l) => (
          <li key={l.url}>
            <a href={l.url} target="_blank" rel="noopener noreferrer">
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
