import { attributeTypesFor } from '@dusk/arkiv'
import { loadConfig, type Claim, type DuskConfig, type Job } from '@dusk/core'
import { seal, unseal } from '@dusk/crypto'
import { render } from '@arkiv-network/sdk/query'
import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { buildBrowserBuyer, buyQueries, liveGrantedWorkers, nextGrant } from '../src/lib/buy'

const JOB_ID: Hex = `0x${'11'.repeat(32)}`
const ESCROW_ID: Hex = `0x${'44'.repeat(32)}`
const BUYER_KEY = generatePrivateKey()
const ESCROW_ADDRESS = '0x2cd51c09ca44001a86b8491fadef099d24560f75'

function configWith(env: Record<string, string> = {}): DuskConfig {
  return loadConfig({ OG_BASE_URL: 'https://example.invalid', ...env })
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    model: 'm',
    maxPricePer1kOut: 1n,
    maxTokens: 8,
    trustMode: 'verified',
    visibility: 'private',
    inputHash: `0x${'33'.repeat(32)}`,
    buyerPubkey: privateKeyToAccount(BUYER_KEY).publicKey,
    escrowId: ESCROW_ID,
    status: 'open',
    expiresAt: 10_000,
    ...over,
  }
}

function honestClaim(over: Partial<Claim> = {}): Claim {
  const account = privateKeyToAccount(generatePrivateKey())
  return {
    id: `claim-${account.address}`,
    jobId: JOB_ID,
    workerId: keccak256(toHex(account.address)),
    price: 1n,
    claimedAt: 1_000,
    workerPubkey: account.publicKey,
    owner: account.address,
    ...over,
  }
}

function comparisons(rendered: string): Array<{ name: string; tag: string }> {
  return [...rendered.matchAll(/([a-z][a-z0-9._]*)\s*(?:=|>=|<=|>|<|!=)\s*([a-z0-9]+)\(/g)].map((m) => ({
    name: m[1]!,
    tag: m[2]!,
  }))
}

describe('buyQueries', () => {
  it('reads only the three entities this job is made of', () => {
    expect(Object.keys(buyQueries(job())).sort()).toEqual(['claims', 'job', 'receipt'])
  })

  it('filters all three, so none of them enumerates a kind', () => {
    for (const query of Object.values(buyQueries(job()))) {
      expect(query.filter, `${query.kind} must be filtered`).toBeDefined()
    }
  })

  it('tags every comparison with the attribute’s own stored Arkiv type', () => {
    for (const query of Object.values(buyQueries(job()))) {
      const types = attributeTypesFor(query.kind)
      const found = comparisons(render(query.filter!))
      expect(found.length, `${query.kind}: a filter that renders no comparison filters nothing`).toBeGreaterThan(0)
      for (const { name, tag } of found) {
        expect(types[name], `${query.kind}.${name} is not a queryable attribute`).toBeDefined()
        expect(tag, `${query.kind}.${name} is stored as ${types[name]} and queried as ${tag}`).toBe(types[name])
      }
    }
  })

  it('finds the job by its escrow id, the one attribute unique to it', () => {
    const rendered = render(buyQueries(job()).job.filter!)
    expect(rendered).toContain('escrow_id')
    expect(rendered.toLowerCase()).toContain(ESCROW_ID.slice(2, 10))
  })

  it('finds claims and the receipt by job id', () => {
    expect(render(buyQueries(job()).claims.filter!)).toContain('job_id')
    expect(render(buyQueries(job()).receipt.filter!)).toContain('job_id')
  })
})

describe('buildBrowserBuyer', () => {
  it('signs as the pasted key’s account and publishes that account’s public key', () => {
    const buyer = buildBrowserBuyer({ config: configWith(), signingKey: BUYER_KEY })
    const account = privateKeyToAccount(BUYER_KEY)
    expect(buyer.address).toBe(account.address)
    expect(buyer.buyerPubkey).toBe(account.publicKey)
  })

  it('carries no key material, even serialised', () => {
    const buyer = buildBrowserBuyer({
      config: configWith({ DUSK_ESCROW_ADDRESS: ESCROW_ADDRESS }),
      signingKey: BUYER_KEY,
    })
    const dumped = JSON.stringify(buyer, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
    expect(dumped).not.toContain(BUYER_KEY)
    expect(dumped).not.toContain(BUYER_KEY.slice(2))
    expect(dumped).not.toMatch(/\b(sk|mk)-/)
    for (const value of Object.values(buyer)) {
      if (typeof value !== 'string') continue
      expect(value).not.toMatch(/^0x[0-9a-fA-F]{64}$/)
    }
  })

  it('opens an output sealed to its own public key', () => {
    const buyer = buildBrowserBuyer({ config: configWith(), signingKey: BUYER_KEY })
    const sealed = seal('a'.repeat(128), buyer.buyerPubkey)
    expect(buyer.unsealOutput?.(sealed)).toBe('a'.repeat(128))
  })

  it('has an escrow whenever a contract is configured, because one key does both', () => {
    const buyer = buildBrowserBuyer({
      config: configWith({ DUSK_ESCROW_ADDRESS: ESCROW_ADDRESS }),
      signingKey: BUYER_KEY,
    })
    expect(buyer.escrow).toBeDefined()
  })

  it('has no escrow without a deployed contract address either', () => {
    const buyer = buildBrowserBuyer({
      config: configWith(),
      signingKey: BUYER_KEY,
    })
    expect(buyer.escrow).toBeUndefined()
  })

  it('has an escrow when both are present', () => {
    const buyer = buildBrowserBuyer({
      config: configWith({ DUSK_ESCROW_ADDRESS: ESCROW_ADDRESS }),
      signingKey: BUYER_KEY,
    })
    expect(buyer.escrow).toBeDefined()
  })

  it('takes the grant TTL from config rather than naming a number', () => {
    const buyer = buildBrowserBuyer({
      config: configWith({ DUSK_TTL_GRANT: '120' }),
      signingKey: BUYER_KEY,
    })
    expect(buyer.ttlGrantSeconds).toBe(120)
  })
})

describe('liveGrantedWorkers', () => {
  it('forgets a grant once its TTL has passed, so the worker can be authorised again', () => {
    const granted = new Map([['w-old', 1_000], ['w-new', 250_000]])
    expect([...liveGrantedWorkers(granted, 302_000, 300_000)]).toEqual(['w-new'])
    expect([...liveGrantedWorkers(granted, 200_000, 300_000)].sort()).toEqual(['w-new', 'w-old'])
  })
})

describe('nextGrant', () => {
  it('names the owner-bound claim to seal to', () => {
    const claim = honestClaim()
    expect(nextGrant({ job: job(), claims: [claim], granted: new Set() })?.id).toBe(claim.id)
  })

  it('declines a claim it cannot prove, exactly as grantOnClaim does in Node', () => {
    const impostor = privateKeyToAccount(generatePrivateKey())
    const forged = honestClaim({
      workerPubkey: privateKeyToAccount(generatePrivateKey()).publicKey,
      owner: impostor.address,
      workerId: keccak256(toHex(impostor.address)),
    })
    expect(nextGrant({ job: job(), claims: [forged], granted: new Set() })).toBeNull()
  })

  it('does not grant twice to the same worker', () => {
    const claim = honestClaim()
    expect(nextGrant({ job: job(), claims: [claim], granted: new Set([claim.workerId]) })).toBeNull()
  })

  it('grants again when a new worker claims after the first lease lapsed', () => {
    const gone = honestClaim({ claimedAt: 1_000 })
    const fresh = honestClaim({ claimedAt: 5_000 })
    const chosen = nextGrant({ job: job(), claims: [gone, fresh], granted: new Set([gone.workerId]) })
    expect(chosen?.id).toBe(fresh.id)
  })

  it('returns a candidate for a public job, which still needs its CommitAuth', () => {
    const claim = honestClaim()
    const picked = nextGrant({
      job: job({ visibility: 'public' }),
      claims: [claim],
      granted: new Set(),
    })
    expect(picked?.workerId).toBe(claim.workerId)
  })

  it('accepts a public job’s claim with no workerPubkey, since nothing is sealed to it', () => {
    const { workerPubkey: _omitted, ...bare } = honestClaim()
    const picked = nextGrant({
      job: job({ visibility: 'public' }),
      claims: [bare],
      granted: new Set(),
    })
    expect(picked?.workerId).toBe(bare.workerId)
  })

  it('returns null when nobody has claimed', () => {
    expect(nextGrant({ job: job(), claims: [], granted: new Set() })).toBeNull()
  })

  it('seals to the key the claim published, which only that worker can open', () => {
    const claim = honestClaim()
    const chosen = nextGrant({ job: job(), claims: [claim], granted: new Set() })!
    const sealed = seal('b'.repeat(128), chosen.workerPubkey!)
    expect(() => unseal(sealed, BUYER_KEY)).toThrow()
  })
})
