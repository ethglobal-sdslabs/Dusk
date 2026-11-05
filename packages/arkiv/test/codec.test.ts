import { describe, expect, it } from 'vitest'
import { render } from '@arkiv-network/sdk/query'
import type { Claim, Grant, Job, Receipt, Verification } from '@dusk/core'
import {
  attrCmp,
  attrEq,
  attributeTypesFor,
  AttributeTooLongError,
  decode,
  encode,
  fieldsFor,
  kindTag,
  openJobsFilter,
  SCHEMAS,
  schemaFor,
  UnknownKindError,
  type SchemaRow,
} from '../src/codec'
import { gte } from '@arkiv-network/sdk/query'
import { describeColumns, lookupColumn } from '@arkiv-network/sdk/schema'

const ENTITY_OWNER = `0x${'ab'.repeat(20)}` as const
const KEY = `0x${'ef'.repeat(32)}` as const

const job: Job = {
  id: '',
  model: '0gm-1.0-35b-a3b',
  maxPricePer1kOut: 1_000n,
  maxTokens: 16,
  trustMode: 'verified',
  visibility: 'public',
  inputRef: 'a'.repeat(64),
  inputHash: `0x${'11'.repeat(32)}`,
  buyerPubkey: `0x${'22'.repeat(33)}`,
  escrowId: `0x${'33'.repeat(32)}`,
  status: 'open',
  expiresAt: 1_800_000_000_000,
}

function asRow(kind: 'job' | 'claim' | 'grant' | 'receipt' | 'verification', data: unknown, over: Partial<SchemaRow> = {}): SchemaRow {
  return { $key: KEY, $owner: ENTITY_OWNER, ...encode(kind, data), ...over } as SchemaRow
}

describe('encode/decode job', () => {
  it('round-trips every field', () => {
    const back = decode<Job>('job', asRow('job', job))
    expect({ ...back, id: '' }).toEqual({ ...job, owner: ENTITY_OWNER })
  })

  it('returns the entity key as the id', () => {
    expect(decode<Job>('job', asRow('job', job)).id).toBe(KEY)
  })

  it('surfaces the owner the engine recorded', () => {
    expect(decode<Job>('job', asRow('job', job)).owner).toBe(ENTITY_OWNER)
  })

  it('leaves owner absent when the row carries none, rather than inventing one', () => {
    const { $owner: _omitted, ...rest } = asRow('job', job)
    expect(decode<Job>('job', rest as SchemaRow).owner).toBeUndefined()
  })

  it('surfaces the engine-recorded creation block as createdAtBlock', () => {
    expect(decode<Job>('job', asRow('job', job, { $createdAt: 4_242n })).createdAtBlock).toBe(4_242n)
  })

  it('keeps immutable creator provenance separate from a transferable current owner', () => {
    const creator = `0x${'cd'.repeat(20)}` as const
    const flags = { readonly: true, permissionlessExtension: false, raw: 1 }
    const result = decode<Job>('job', asRow('job', job, { $owner: ENTITY_OWNER, $creator: creator, $creationFlags: flags }))
    expect(result.owner).toBe(ENTITY_OWNER)
    expect(result.creator).toBe(creator)
    expect(result.creationFlags).toEqual(flags)
  })

  it('leaves createdAtBlock absent when the row carries none', () => {
    expect(decode<Job>('job', asRow('job', job)).createdAtBlock).toBeUndefined()
  })

  it('never writes a column that could shadow an engine field', () => {
    const written = Object.keys(encode('job', { ...job, owner: ENTITY_OWNER, createdAtBlock: 9n }))
    for (const name of ['id', 'owner', 'createdAtBlock', '$key', '$owner', '$createdAt']) {
      expect(written).not.toContain(name)
    }
  })

  it('uses only lowercase column names, as the engine requires', () => {
    for (const name of Object.keys(encode('job', job))) {
      expect(name).toMatch(/^[a-z][a-z0-9._-]*$/)
    }
  })

  it('keeps every column name within the 32-byte limit', () => {
    for (const name of Object.keys(encode('job', job))) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(32)
    }
  })

  it('stays within the Arkiv 32-column limit', () => {
    for (const kind of ['job', 'worker', 'claim', 'grant', 'receipt'] as const) {
      expect(Object.keys(attributeTypesFor(kind)).length).toBeLessThanOrEqual(32)
    }
  })

  it('rejects a string column over 128 bytes, naming the field', () => {
    expect(() => encode('job', { ...job, inputRef: 'a'.repeat(129) })).toThrow(AttributeTooLongError)
    expect(() => encode('job', { ...job, inputRef: 'a'.repeat(129) })).toThrow(/inputRef/)
  })

  it('accepts a 128-char encrypted Swarm ref exactly at the limit', () => {
    expect(() => encode('job', { ...job, inputRef: 'a'.repeat(128) })).not.toThrow()
  })

  it('round-trips a bigint price without precision loss', () => {
    const big = 2n ** 200n
    const back = decode<Job>('job', asRow('job', { ...job, maxPricePer1kOut: big }))
    expect(back.maxPricePer1kOut).toBe(big)
  })

  it('omits inputRef entirely when the job is private', () => {
    const { inputRef: _dropped, ...priv } = job
    expect(Object.keys(encode('job', { ...priv, visibility: 'private' }))).not.toContain('input_ref')
  })

  it('throws when a required field is absent entirely', () => {
    const { model: _missing, ...partial } = job
    expect(() => encode('job', partial)).toThrow(/model/)
  })

  it('throws on an unknown kind', () => {
    expect(() => encode('nope' as never, {})).toThrow(UnknownKindError)
  })
})

describe('queryable vs stored', () => {
  it('keeps every field a query filters on in the type table', () => {
    expect(Object.keys(attributeTypesFor('job'))).toEqual(
      expect.arrayContaining(['status', 'model', 'max_price_per_1k_out', 'escrow_id']),
    )
    expect(Object.keys(attributeTypesFor('receipt'))).toEqual(
      expect.arrayContaining(['job_id', 'worker', 'output_hash', 'escrow_id']),
    )
    expect(Object.keys(attributeTypesFor('claim'))).toEqual(
      expect.arrayContaining(['job_id', 'worker_id']),
    )
  })

  it('stores the 65-byte values as bytes, which are returned but not filterable', () => {
    expect(attributeTypesFor('grant').commit_auth).toBe('bytes')
    expect(attributeTypesFor('grant').sealed_ref).toBe('bytes')
    expect(attributeTypesFor('claim').worker_pubkey).toBe('bytes')
    expect(attributeTypesFor('job').buyer_pubkey).toBe('bytes')
  })

  it('refuses to build a filter on a bytes column, since the index cannot answer it', () => {
    expect(() => attrEq('grant', 'commitAuth', `0x${'00'.repeat(65)}`)).toThrow(/bytes column/)
    expect(() => attrEq('claim', 'workerPubkey', `0x${'04'.repeat(65)}`)).toThrow(/never/)
    expect(() => attrEq('grant', 'commitAuth', '0x00')).toThrow(/jobId/)
  })
})

describe('encode/decode receipt', () => {
  const receipt: Receipt = {
    id: '',
    jobId: KEY,
    escrowId: `0x${'33'.repeat(32)}`,
    worker: `0x${'44'.repeat(20)}`,
    modelServed: '0gm-1.0-35b-a3b',
    creditsSpent: 'tokens:1/1',
    tokensIn: 3,
    tokensOut: 5,
    outputRef: 'b'.repeat(64),
    outputHash: `0x${'55'.repeat(32)}`,
    latencyMs: 1234,
    trustMode: 'verified',
    visibility: 'public',
  }

  it('round-trips a receipt', () => {
    const back = decode<Receipt>('receipt', asRow('receipt', receipt))
    expect({ ...back, id: '' }).toEqual({ ...receipt, owner: ENTITY_OWNER })
  })

  it('makes jobId queryable so a buyer can find its own receipt', () => {
    expect(Object.keys(encode('receipt', receipt))).toContain('job_id')
  })

  it('makes escrowId queryable, which settleDue needs to enumerate what it is owed', () => {
    expect(Object.keys(attributeTypesFor('receipt'))).toContain('escrow_id')
  })

  const SEALED_REF = `0x${'ab'.repeat(225)}` as const

  it('stores a private receipt’s sealed ref in a bytes column, not the 128-byte str one', () => {
    const cols = encode('receipt', { ...receipt, visibility: 'private', outputRef: SEALED_REF })
    expect(cols).not.toHaveProperty('output_ref')
    expect(cols).toHaveProperty('sealed_output_ref')
    expect(lookupColumn(schemaFor('receipt'), 'sealed_output_ref')?.type).toBe('bytes')
  })

  it('round-trips a private receipt’s sealed ref back to outputRef, where every reader looks', () => {
    const priv: Receipt = { ...receipt, visibility: 'private', outputRef: SEALED_REF }
    const back = decode<Receipt>('receipt', asRow('receipt', priv))
    expect({ ...back, id: '' }).toEqual({ ...priv, owner: ENTITY_OWNER })
  })

  it('keeps a public receipt’s ref in output_ref, so receipts already on chain still match', () => {
    const cols = encode('receipt', receipt)
    expect(cols).toHaveProperty('output_ref')
    expect(cols).not.toHaveProperty('sealed_output_ref')
  })

  it('still refuses a receipt with no outputRef at all', () => {
    const { outputRef: _drop, ...rest } = receipt
    expect(() => encode('receipt', rest)).toThrow(/outputRef/)
  })
})

describe('codec agrees with schemas', () => {
  for (const kind of Object.keys(SCHEMAS) as Array<keyof typeof SCHEMAS>) {
    it(`${kind}: every codec field names a schema column of the same type and optionality`, () => {
      const schema = schemaFor(kind)
      for (const [field, spec] of Object.entries(fieldsFor(kind))) {
        const column = lookupColumn(schema, spec.attr)
        expect(column, `${kind}.${field} → "${spec.attr}" has no schema column`).toBeDefined()
        const want = spec.type === 'json' ? 'bytes' : spec.type
        expect(column!.type, `${kind}.${field} type`).toBe(want)
        expect(column!.isOptional, `${kind}.${field} optionality`).toBe(spec.optional === true)
      }
    })

    it(`${kind}: every schema column has a codec field`, () => {
      const attrs = new Set(Object.values(fieldsFor(kind)).map((s) => s.attr))
      for (const name of describeColumns(schemaFor(kind)).split(', ')) {
        expect(attrs.has(name), `${kind} column "${name}" has no codec field`).toBe(true)
      }
    })
  }
})

describe('verification', () => {
  const verification: Verification = {
    id: '',
    jobId: KEY,
    escrowId: `0x${'33'.repeat(32)}`,
    worker: `0x${'44'.repeat(20)}`,
    result: 'illegal',
    check: 'output-hash-mismatch',
  }

  it('round-trips a verdict', () => {
    const back = decode<Verification>('verification', asRow('verification', verification))
    expect({ ...back, id: '' }).toEqual({ ...verification, owner: ENTITY_OWNER })
  })

  it('makes worker and result queryable, which is what reputation reads by', () => {
    expect(Object.keys(attributeTypesFor('verification'))).toEqual(expect.arrayContaining(['worker', 'result', 'escrow_id']))
  })

  it('carries nothing key-shaped', () => {
    expect(JSON.stringify(encode('verification', verification))).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('grant', () => {
  const grant: Grant = {
    id: '',
    jobId: KEY,
    workerId: `0x${'77'.repeat(32)}`,
    sealedRef: `0x${'ab'.repeat(200)}`,
    commitAuth: `0x${'cd'.repeat(65)}`,
  }

  it('round-trips a sealed ref far longer than any string column could hold', () => {
    const back = decode<Grant>('grant', asRow('grant', grant))
    expect(back.sealedRef).toBe(grant.sealedRef)
  })

  it('round-trips a 65-byte commitAuth, which no str column could hold', () => {
    const back = decode<Grant>('grant', asRow('grant', grant))
    expect(back.commitAuth).toBe(grant.commitAuth)
  })

  it('omits both optional fields when absent, rather than writing empty ones', () => {
    const written = Object.keys(encode('grant', { jobId: KEY, workerId: grant.workerId }))
    expect(written).not.toContain('sealed_ref')
    expect(written).not.toContain('commit_auth')
  })
})

describe('claim', () => {
  const claim: Claim = {
    id: '',
    jobId: KEY,
    workerId: `0x${'77'.repeat(32)}`,
    price: 7n,
    claimedAt: 1_700_000_000_000,
    workerPubkey: `0x${'04'.repeat(65)}`,
  }

  it('round-trips, including the 65-byte pubkey', () => {
    const back = decode<Claim>('claim', asRow('claim', claim))
    expect({ ...back, id: '' }).toEqual({ ...claim, owner: ENTITY_OWNER })
  })

  it('keeps claimedAt a number and price a bigint', () => {
    const back = decode<Claim>('claim', asRow('claim', claim))
    expect(typeof back.claimedAt).toBe('number')
    expect(typeof back.price).toBe('bigint')
  })
})

describe('worker ad', () => {
  it('round-trips the model and trust-mode arrays, which Arkiv has no column type for', () => {
    const ad = {
      pricePer1kOut: 1n,
      creditsBucket: '>50%',
      payout: `0x${'88'.repeat(20)}`,
      models: ['0gm-1.0-35b-a3b', 'another-model'],
      trustModes: ['verified', 'private'],
    }
    const back = decode<typeof ad & { id: string }>('worker', asRow('worker' as never, ad))
    expect(back.models).toEqual(ad.models)
    expect(back.trustModes).toEqual(ad.trustModes)
  })
})

describe('kindTag', () => {
  it('namespaces every kind under dusk.', () => {
    expect(kindTag('job')).toBe('dusk.job')
    expect(kindTag('receipt')).toBe('dusk.receipt')
  })
})

describe('attrEq', () => {
  it('tags an addr column as addr(), never as a bare string', () => {
    expect(render(attrEq('receipt', 'worker', `0x${'39'.repeat(20)}`))).toMatch(/addr\(/)
  })

  it('tags a u256 column as u256()', () => {
    expect(render(attrEq('job', 'maxPricePer1kOut', 1n))).toMatch(/u256\(/)
  })

  it('tags a key column as key(), because a job id is an entity reference', () => {
    expect(render(attrEq('claim', 'jobId', KEY))).toMatch(/key\(/)
  })

  it('still renders a str column as str()', () => {
    expect(render(attrEq('job', 'status', 'open'))).toMatch(/str\(/)
  })

  it('maps the camelCase field to its snake_case column', () => {
    expect(render(attrEq('job', 'maxPricePer1kOut', 1n))).toContain('max_price_per_1k_out')
  })

  it('refuses a field the kind does not have', () => {
    expect(() => attrEq('job', 'nope', 1)).toThrow(/nope/)
  })
})

describe('attrCmp', () => {
  it('tags a u256 column as u256(), via gte', () => {
    expect(render(attrCmp('job', 'maxPricePer1kOut', gte, 5n))).toMatch(/u256\(/)
  })

  it('tags a u64 column as u64(), not the bare-number default', () => {
    expect(render(attrCmp('claim', 'claimedAt', gte, 1_700_000_000_000))).toMatch(/u64\(/)
  })

  it('refuses a field the kind does not have', () => {
    expect(() => attrCmp('job', 'nope', gte, 1)).toThrow(/nope/)
  })
})

describe('openJobsFilter', () => {
  const f = openJobsFilter(['a', 'b'], 10n)

  it('composes or() for models because Arkiv has no IN', () => {
    const r = render(f)
    expect(r).toContain('model')
    expect(r).toMatch(/\bor\b|\|\|/i)
  })

  it('filters on price in the query, tagged as u256 rather than compared lexically', () => {
    expect(render(f)).toMatch(/u256\(/)
  })

  it('restricts to open jobs', () => {
    expect(render(f)).toContain('open')
  })
})

describe('a piece of a split job', () => {
  it('round-trips parent, position and count through the real column encoding', () => {
    const piece: Job = { ...job, parentId: `0x${'5a'.repeat(32)}`, pieceIndex: 2, pieceCount: 3 }
    const row = encode('job', piece)
    expect(row).toMatchObject({ piece_index: expect.anything(), piece_count: expect.anything() })
    expect(decode<Job>('job', row as never)).toMatchObject({ parentId: piece.parentId, pieceIndex: 2, pieceCount: 3 })
  })

  it('leaves an ordinary job without those columns', () => {
    expect(Object.keys(encode('job', job))).not.toContain('parent_id')
  })

  it('can filter on parent_id', () => {
    expect(render(attrEq('job', 'parentId', `0x${'5a'.repeat(32)}`))).toContain('parent_id')
  })
})

// A field the codec writes that the schema has no column for is a `SchemaMismatchError`
// on the real chain — and for a receipt that error comes after the completion is billed
// and the hash committed. The fake store never checks, so this is the only guard.
describe('codec ↔ schema agreement', () => {
  it.each(Object.keys(SCHEMAS))('every column the codec writes for %s exists in its schema', (kind) => {
    const columns = (SCHEMAS[kind as keyof typeof SCHEMAS] as unknown as { columns: Record<string, unknown> }).columns
    const names = new Set(Object.keys(columns))
    expect(names.size).toBeGreaterThan(0)
    for (const spec of Object.values(fieldsFor(kind as never))) {
      expect(names, `${kind}.${spec.attr}`).toContain(spec.attr)
    }
  })
})

describe('a receipt carrying a TEE proof', () => {
  const base: Receipt = {
    id: '',
    jobId: KEY,
    escrowId: `0x${'33'.repeat(32)}`,
    worker: `0x${'44'.repeat(20)}`,
    modelServed: '0gm-1.0-35b-a3b',
    creditsSpent: 'tokens:1/1',
    tokensIn: 3,
    tokensOut: 5,
    outputRef: 'b'.repeat(64),
    outputHash: `0x${'55'.repeat(32)}`,
    latencyMs: 1234,
    trustMode: 'verified',
    visibility: 'public',
  }

  it('stores a public proof ref in proof_ref and reads it back', () => {
    const r = { ...base, proofRef: 'c'.repeat(64) }
    expect(encode('receipt', r)).toHaveProperty('proof_ref')
    expect(decode<Receipt>('receipt', asRow('receipt', r)).proofRef).toBe('c'.repeat(64))
  })

  // Sealed to the buyer, a proof ref is ~452 hex — far over the 128-byte str limit.
  it('stores a private, sealed proof ref in the bytes column and reads it back', () => {
    const sealed = `0x${'d'.repeat(452)}`
    const r = { ...base, visibility: 'private' as const, outputRef: `0x${'e'.repeat(452)}`, proofRef: sealed }
    const row = encode('receipt', r)
    expect(row).toHaveProperty('sealed_proof_ref')
    expect(row).not.toHaveProperty('proof_ref')
    expect(decode<Receipt>('receipt', asRow('receipt', r)).proofRef).toBe(sealed)
  })

  it('leaves a receipt without a proof free of both columns', () => {
    const row = encode('receipt', base)
    expect(row).not.toHaveProperty('proof_ref')
    expect(row).not.toHaveProperty('sealed_proof_ref')
  })
})
