import Link from 'next/link'
import { SpaceNav } from '../components/SpaceNav'

export default function NotFound() {
  return (
    <main className="workspace">
      <header className="workspace-header">
        <a className="skip-link" href="#start">Skip to content</a>
        <SpaceNav current="home" />
      </header>
      <div className="ground">
        <div className="page stack">
          <div className="workspace-heading">
            <div className="workspace-heading-copy">
              <h1 id="start">Page not found</h1>
              <p>The page may have moved or no longer exists.</p>
              <div className="surface-actions workspace-heading-actions"><Link href="/market">Explore the market</Link><Link href="/">Go home</Link></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
