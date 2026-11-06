import { AsciiMastheadScene } from './AsciiMastheadScene'
import { SpaceNav } from './SpaceNav'

type SpaceMastheadProps = {
  label: string
  description: string
  action: string
}

export function SpaceMasthead({ label, description, action }: SpaceMastheadProps) {
  return (
    <div className="sky-band space-masthead">
      <a className="skip-link" href="#start">Skip to content</a>
      <AsciiMastheadScene />
      <SpaceNav current={label === 'EARN' ? 'earn' : 'buy'} />
      <div className="space-masthead-copy"><span>{label}</span><p>{description}</p><a href="#start">{action} <span aria-hidden="true">↓</span></a></div>
    </div>
  )
}

