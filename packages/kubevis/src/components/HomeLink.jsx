// The way back to the hub. Every visualizer is its own subdomain, so a visitor
// who enjoys one has no way to discover the others without this — it sits first
// in the topbar, where a site's mark is always the way home, and it carries the
// landing page's own 2×2 dot mark so the two read as one site.
//
// Same-tab on purpose: this is a home link, and everything in these apps is
// re-derivable from a fresh load, so there is no session worth preserving in a
// background tab. Every visualizer app carries an identical copy of this file.
const LANDING_URL = 'https://bitvis.bitsculpt.top'

export default function HomeLink() {
  return (
    <a
      className="home-link"
      href={LANDING_URL}
      title="All bitvis visualizations"
      aria-label="bitvis — all visualizations"
    >
      <span className="home-mark" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="home-word">bitvis</span>
      <span className="home-all">all visualizations</span>
    </a>
  )
}
