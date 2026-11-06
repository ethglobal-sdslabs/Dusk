import type { ReactNode } from 'react'
export function WorkspaceHeading({ id = 'start', title, description, actions }: { page: 'buy' | 'earn' | 'market' | 'history' | 'reputation'; id?: string; title: ReactNode; description: string; actions?: ReactNode }) {
  return <div className="workspace-heading">
    <div className="workspace-heading-copy">
      <div><h1 id={id}>{title}</h1><p>{description}</p>
        {actions && <div className="surface-actions workspace-heading-actions">{actions}</div>}
      </div>
    </div>
  </div>
}
