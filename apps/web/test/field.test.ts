import type { Claim, Job, Receipt, WorkerAd } from '@dusk/core'
import { describe, expect, it } from 'vitest'
import { EMPTY_SNAPSHOT, type Burn, type MarketSnapshot } from '../src/lib/arkiv'
import { hexToRgb } from '../src/lib/color'
import { claimHeat, JOB_BAND, layoutField, MAX_LIGHTS, positionOf, WORKER_BAND, type FieldLight } from '../src/three/field'
import { EMBER, HORIZON_Y, LASTLIGHT, PALE } from '../src/three/sky.glsl'

const TTL_CLAIM = 90
const BURN_MS = 2500
const NOW = 1_700_000_000_000

function worker(id: string): WorkerAd {
  return {
    id,
    models: ['0gm-1.0-35b-a3b'],
    pricePer1kOut: 4n,
    creditsBucket: '>50%',
    trustModes: ['verified'],
    payout: `0x${'44'.repeat(20)}`,
  }
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    model: '0gm-1.0-35b-a3b',
    maxPricePer1kOut: 1000n,
    maxTokens: 8,
    trustMode: 'verified',
    visibility: 'public',
    inputHash: `0x${'11'.repeat(32)}`,
    buyerPubkey: `0x${'22'.repeat(65)}`,
    escrowId: `0x${'33'.repeat(32)}`,
    status: 'open',
    expiresAt: NOW + 600_000,
    ...over,
  }
}

function claim(id: string, jobId: string, workerId: string, claimedAt = NOW): Claim {
  return { id, jobId, workerId, price: 8n, claimedAt }
}

function receipt(id: string, jobId: string): Receipt {
  return {
    id,
    jobId,
    escrowId: `0x${'33'.repeat(32)}`,
    worker: `0x${'44'.repeat(20)}`,
    modelServed: '0gm-1.0-35b-a3b',
    creditsSpent: 'tokens:31/8',
    tokensIn: 31,
    tokensOut: 8,
    outputRef: 'ab'.repeat(32),
    outputHash: `0x${'55'.repeat(32)}`,
    latencyMs: 900,
    trustMode: 'verified',
  }
}

function field(over: Partial<MarketSnapshot>, burns: Burn[] = [], nowMs = NOW): FieldLight[] {
  return layoutField({ snapshot: { ...EMPTY_SNAPSHOT, ...over }, burns, ttlClaimSec: TTL_CLAIM, burnMs: BURN_MS }, nowMs)
}

const of = (lights: FieldLight[], kind: FieldLight['kind']) => lights.filter((l) => l.kind === kind)

describe('positionOf', () => {
  it('is stable for the same entity, so a light does not jump between reads', () => {
    expect(positionOf('worker', 'w-abc')).toEqual(positionOf('worker', 'w-abc'))
  })

  it('separates two entities', () => {
    expect(positionOf('job', 'j1')).not.toEqual(positionOf('job', 'j2'))
  })

  it('puts every light above the horizon, which is where the sky is', () => {
    for (let i = 0; i < 400; i++) {
      for (const kind of ['worker', 'job'] as const) {
        const [x, y] = positionOf(kind, `e${i}`)
        expect(y).toBeGreaterThan(HORIZON_Y)
        expect(y).toBeLessThanOrEqual(1)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(1)
      }
    }
  })

  it('sits supply low and demand high, so a claim reads as a line between the two', () => {
    for (let i = 0; i < 200; i++) {
      expect(positionOf('worker', `w${i}`)[1]).toBeGreaterThanOrEqual(WORKER_BAND[0])
      expect(positionOf('worker', `w${i}`)[1]).toBeLessThanOrEqual(WORKER_BAND[1])
      expect(positionOf('job', `j${i}`)[1]).toBeGreaterThanOrEqual(JOB_BAND[0])
      expect(positionOf('job', `j${i}`)[1]).toBeLessThanOrEqual(JOB_BAND[1])
    }
    expect(WORKER_BAND[1]).toBeLessThan(JOB_BAND[0])
  })

  it('spreads across the width rather than clustering in one place', () => {
    const xs = Array.from({ length: 200 }, (_, i) => positionOf('job', `job-${i}`)[0])
    const buckets = new Set(xs.map((x) => Math.floor(x * 8)))
    expect(buckets.size).toBeGreaterThanOrEqual(7)
  })
})

describe('layoutField', () => {
  it('draws nothing at all for an empty market', () => {
    expect(field({})).toEqual([])
  })

  it('draws one light per live worker ad, dim and steady', () => {
    const lights = of(field({ workers: [worker('w1'), worker('w2')] }), 'worker')
    expect(lights).toHaveLength(2)
    for (const light of lights) {
      expect(light.from).toEqual(light.to)
      expect(light.color).toEqual(hexToRgb(PALE))
    }
  })

  it('draws an open job brighter than a worker ad', () => {
    const lights = field({ workers: [worker('w1')], jobs: [job('j1')] })
    const w = of(lights, 'worker')[0]!
    const j = of(lights, 'job')[0]!
    expect(j.glow).toBeGreaterThan(w.glow)
    expect(j.sizePx).toBeGreaterThan(w.sizePx)
  })

  it('does not draw a job that is not open', () => {
    expect(of(field({ jobs: [job('j1', { status: 'settled' })] }), 'job')).toHaveLength(0)
  })

  it('draws a claim as a line from its job to its worker', () => {
    const lights = field({
      workers: [worker('w1')],
      jobs: [job('j1')],
      claims: [claim('c1', 'j1', 'w1')],
    })
    const line = of(lights, 'claim')[0]!
    expect(line.from).toEqual(positionOf('job', 'j1'))
    expect(line.to).toEqual(positionOf('worker', 'w1'))
  })

  it('draws no line for a claim whose job is not in the snapshot', () => {
    const lights = field({ workers: [worker('w1')], claims: [claim('c1', 'gone', 'w1')] })
    expect(of(lights, 'claim')).toHaveLength(0)
  })

  it('draws no line for a claim whose worker ad has lapsed', () => {
    const lights = field({ jobs: [job('j1')], claims: [claim('c1', 'j1', 'gone')] })
    expect(of(lights, 'claim')).toHaveLength(0)
  })

  it('dims a claim toward the cool expiry color as its lease runs down', () => {
    const base = { workers: [worker('w1')], jobs: [job('j1')] }
    const fresh = of(field({ ...base, claims: [claim('c1', 'j1', 'w1', NOW)] }), 'claim')[0]!
    const late = of(field({ ...base, claims: [claim('c1', 'j1', 'w1', NOW - 80_000)] }), 'claim')[0]!
    const pale = hexToRgb(PALE)
    const ember = hexToRgb(EMBER)
    expect(late.color[0]).toBeLessThan(fresh.color[0])
    expect(late.color[2]).toBeLessThan(fresh.color[2])
    expect(fresh.color).toEqual(pale)
    expect(late.color[2]).toBeGreaterThan(ember[2])
  })

  it('draws a burning credit as --lastlight, because a credit is money', () => {
    const lights = of(field({ receipts: [receipt('r1', 'j1')] }, [{ id: 'r1', jobId: 'j1', firstSeenMs: NOW }]), 'burn')
    expect(lights).toHaveLength(1)
    expect(lights[0]!.color).toEqual(hexToRgb(LASTLIGHT))
  })

  it('rises as the ember ages and fades out by the end of it', () => {
    const burn: Burn = { id: 'r1', jobId: 'j1', firstSeenMs: NOW }
    const young = of(field({}, [burn], NOW + 100), 'burn')[0]!
    const old = of(field({}, [burn], NOW + BURN_MS * 0.9), 'burn')[0]!
    expect(old.from[1]).toBeGreaterThan(young.from[1])
    expect(old.glow).toBeLessThan(young.glow)
  })

  it('keeps the ember and drops only its movement under prefers-reduced-motion', () => {
    const burn: Burn = { id: 'r1', jobId: 'j1', firstSeenMs: NOW }
    const still = (nowMs: number) =>
      layoutField(
        { snapshot: EMPTY_SNAPSHOT, burns: [burn], ttlClaimSec: TTL_CLAIM, burnMs: BURN_MS, reducedMotion: true },
        nowMs,
      ).filter((l) => l.kind === 'burn')[0]!
    expect(still(NOW + 100).from).toEqual(still(NOW + BURN_MS * 0.9).from)
    expect(still(NOW + BURN_MS * 0.9).glow).toBe(still(NOW + 100).glow)
    expect(still(NOW).glow).toBe(1)
  })

  it('draws nothing for an ember that has finished', () => {
    const burn: Burn = { id: 'r1', jobId: 'j1', firstSeenMs: NOW }
    expect(of(field({}, [burn], NOW + BURN_MS + 1), 'burn')).toHaveLength(0)
  })

  it('puts the ember where its job is when the job is still live', () => {
    const burn: Burn = { id: 'r1', jobId: 'j1', firstSeenMs: NOW }
    const light = of(field({ jobs: [job('j1')] }, [burn], NOW), 'burn')[0]!
    expect(light.from[0]).toBeCloseTo(positionOf('job', 'j1')[0], 5)
  })

  it('never exceeds the buffer the GPU has room for, even at four full query pages', () => {
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i))
    const lights = field({
      workers: many(200, (i) => worker(`w${i}`)) as WorkerAd[],
      jobs: many(200, (i) => job(`j${i}`)) as Job[],
      claims: many(200, (i) => claim(`c${i}`, `j${i}`, `w${i}`)) as Claim[],
      receipts: many(200, (i) => receipt(`r${i}`, `j${i}`)) as Receipt[],
    })
    expect(lights.length).toBeLessThanOrEqual(MAX_LIGHTS)
    expect(lights.length).toBeGreaterThan(500)
  })

  it('has no memory: the same snapshot lays out identically whatever came before', () => {
    const once = field({ workers: [worker('w1')], jobs: [job('j1')] })
    const twice = field({ workers: [worker('w1')], jobs: [job('j1')] })
    expect(twice).toEqual(once)
    expect(field({ workers: [worker('w1')] }).map((l) => l.id)).toEqual(['w1'])
  })
})

describe('claimHeat', () => {
  it('is zero on a brand new lease and one on a lease at its end', () => {
    expect(claimHeat(NOW, TTL_CLAIM, NOW)).toBe(0)
    expect(claimHeat(NOW - TTL_CLAIM * 1000, TTL_CLAIM, NOW)).toBe(1)
  })

  it('clamps rather than going negative on a claim whose clock is ahead of ours', () => {
    expect(claimHeat(NOW + 5000, TTL_CLAIM, NOW)).toBe(0)
  })

  it('clamps at one for a lease the chain has outlived, rather than overshooting', () => {
    expect(claimHeat(NOW - 200_000, TTL_CLAIM, NOW)).toBe(1)
  })
})
