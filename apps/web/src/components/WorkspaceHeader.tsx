import { SpaceNav } from './SpaceNav'

export function WorkspaceHeader({ current }: { current: 'market' | 'buy' | 'earn' | 'history' | 'reputation' }) {
  return <header className="workspace-header">
    <a className="skip-link" href={current === 'market' ? '#market-data' : '#start'}>Skip to content</a>
    <SpaceNav current={current} />
  </header>
}
