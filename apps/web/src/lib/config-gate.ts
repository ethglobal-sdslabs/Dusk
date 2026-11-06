function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

export function configRequestAllowed(headers: Headers): boolean {
  if (!isLoopbackHost(headers.get('host'))) return false
  const site = headers.get('sec-fetch-site')
  return site === null || site === 'same-origin' || site === 'none'
}
