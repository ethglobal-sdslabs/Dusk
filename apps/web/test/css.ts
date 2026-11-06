import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function sheet(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/app/${name}`, import.meta.url)), 'utf8')
}

export const CSS = sheet('globals.css')

export const SPACE_CSS = sheet('space.css')

export const ALL_CSS = [CSS, SPACE_CSS, sheet('workspace.css')].join('\n')

export function worstOverCycle(fn: (progress: number) => number): number {
  let worst = Infinity
  for (let i = 0; i <= 100; i++) worst = Math.min(worst, fn(i / 100))
  return worst
}
