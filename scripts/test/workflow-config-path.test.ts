import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('reputation workflow output', () => {
  it('refuses to overwrite either template or an explicitly configured source file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dusk-config-guard-'))
    try {
      const source = join(dir, 'company.json')
      copyFileSync(resolve('config.user.example.json'), source)
      for (const target of ['config.user.example.json', 'config.developer.example.json', source]) {
        const path = resolve(target)
        const before = readFileSync(path, 'utf8')
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/prepare-reputation-workflow.ts', '--out', path], {
          cwd: process.cwd(), env: { ...process.env, DUSK_CONFIG_FILE: source }, encoding: 'utf8',
        })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('must not replace')
        expect(readFileSync(path, 'utf8')).toBe(before)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
