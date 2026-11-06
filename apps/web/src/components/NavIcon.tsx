type Destination = 'market' | 'buy' | 'earn' | 'history' | 'reputation'

export function NavIcon({ destination }: { destination: Destination }) {
  const paths = {
    market: 'M3 13V9m5 4V3m5 10V6',
    buy: 'M9 1 3 9h4l-1 6 7-9H9l1-5Z',
    earn: 'M2 4h12v9H2V4Zm2-2h8M5 8h2m3 0h1',
    history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5',
    reputation: 'M8 1.5 3 3.5v4c0 3 2.2 5.4 5 6.5 2.8-1.1 5-3.5 5-6.5v-4L8 1.5ZM5.8 8l1.6 1.6L10.5 6.5',
  }
  return <svg className="nav-symbol" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[destination]} /></svg>
}
