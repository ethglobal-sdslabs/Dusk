import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import { ViewTransition } from 'react'
import './globals.css'
import './space.css'
import './workspace.css'

const archivo = localFont({
  src: './fonts/archivo-latin-variable.woff2',
  weight: '400 700',
  style: 'normal',
  declarations: [{ prop: 'font-stretch', value: '62% 125%' }],
  display: 'swap',
  variable: '--font-text',
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
})

const instrumentSerif = localFont({
  src: './fonts/instrument-serif-italic.ttf',
  weight: '400',
  style: 'italic',
  display: 'swap',
  variable: '--font-accent',
  fallback: ['Georgia', 'serif'],
})

const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin-variable.woff2',
  weight: '100 800',
  display: 'swap',
  variable: '--font-mono',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
})

export const metadata: Metadata = {
  title: 'Dusk — compute that expires tonight',
  description:
    'A market for 0G inference credits that are destroyed at 00:00 UTC. Holders sell what they will never spend; buyers get the cheapest inference on the market.',
}

export const viewport: Viewport = {
  themeColor: '#03050A',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-workspace-theme="dark" className={`${archivo.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}>
      <body>
        <ViewTransition name="page" default="route-fade">{children}</ViewTransition>
      </body>
    </html>
  )
}
