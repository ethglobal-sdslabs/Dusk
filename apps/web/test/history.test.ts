import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import type { Receipt } from '@dusk/core'
import {
  deliveryPatch,
  dropRow,
  inFlightRows,
  ledgerKey,
  loadLedger,
  patchRow,
  REFUND_GRACE_MS,
  rowFromPosted,
  saveRow,
  type LedgerRow,
} from '../src/lib/history'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

function throwingStorage(): Storage {
  const die = (): never => {
    throw new DOMException('QuotaExceededError')
  }
  return {
    get length(): number {
      return die()
    },
    clear: die,
    getItem: die,
    key: die,
    removeItem: die,
    setItem: die,
  }
}

const NOW = 1_700_000_000_000

const ALICE = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const BOB = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'

const dump = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    escrowId: `0x${'33'.repeat(32)}`,
    jobId: `0x${'44'.repeat(32)}`,
    fundTx: `0x${'55'.repeat(32)}`,
    amountWei: 8_000n,
    model: '0gm-1.0-35b-a3b',
    maxTokens: 8,
    visibility: 'public',
    inputHash: `0x${'66'.repeat(32)}`,
    prompt: 'summarise this',
    expiresAt: NOW + 600_000,
    postedAt: NOW,
    ...over,
  }
}

describe('the buy ledger', () => {
  it('round-trips a row including its bigint amount', () => {
    const store = memoryStorage()
    const r = row()
    saveRow(ALICE, r, store, NOW)
    const [back] = loadLedger(ALICE, store, NOW)
    expect(back).toEqual(r)
    expect(typeof back!.amountWei).toBe('bigint')
  })

  it('holds many jobs at once, newest first', () => {
    const store = memoryStorage()
    const a = row({ escrowId: `0x${'a1'.repeat(32)}`, postedAt: NOW })
    const b = row({ escrowId: `0x${'b2'.repeat(32)}`, postedAt: NOW + 1_000 })
    const c = row({ escrowId: `0x${'c3'.repeat(32)}`, postedAt: NOW + 2_000 })
    saveRow(ALICE, a, store, NOW)
    saveRow(ALICE, b, store, NOW)
    saveRow(ALICE, c, store, NOW)
    expect(loadLedger(ALICE, store, NOW).map((r) => r.escrowId)).toEqual([c.escrowId, b.escrowId, a.escrowId])
  })

  it('updates a row in place rather than duplicating it', () => {
    const store = memoryStorage()
    saveRow(ALICE, row(), store, NOW)
    saveRow(ALICE, row({ fundTx: `0x${'99'.repeat(32)}` }), store, NOW)
    const all = loadLedger(ALICE, store, NOW)
    expect(all).toHaveLength(1)
    expect(all[0]!.fundTx).toBe(`0x${'99'.repeat(32)}`)
  })

  it('drops one row without touching the others', () => {
    const store = memoryStorage()
    const a = row({ escrowId: `0x${'a1'.repeat(32)}` })
    const b = row({ escrowId: `0x${'b2'.repeat(32)}` })
    saveRow(ALICE, a, store, NOW)
    saveRow(ALICE, b, store, NOW)
    dropRow(ALICE, a.escrowId, store, NOW)
    expect(loadLedger(ALICE, store, NOW).map((r) => r.escrowId)).toEqual([b.escrowId])
  })

  it('never writes anything key-shaped', () => {
    const store = memoryStorage()
    saveRow(ALICE, row(), store, NOW)
    expect(store.getItem(ledgerKey(ALICE))).not.toMatch(/\b(sk|mk)-/)
  })

  it('never writes a 64-hex value, so no signing key or encrypted ref lands on disk', () => {
    const store = memoryStorage()
    saveRow(ALICE, row(), store, NOW)
    const written = store.getItem(ledgerKey(ALICE)) ?? ''
    expect(written).not.toMatch(/(?<!0x)\b[0-9a-fA-F]{64}\b/)
    expect(written).not.toMatch(/[0-9a-fA-F]{128}/)
  })

  it('keeps a row past its job deadline, which is when refund becomes callable', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ expiresAt: NOW }), store, NOW)
    expect(loadLedger(ALICE, store, NOW + 1_000)).toHaveLength(1)
    expect(loadLedger(ALICE, store, NOW + 86_400_000)).toHaveLength(1)
  })

  it('keeps a row whose deadline is exactly now, since the job is still live', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ expiresAt: NOW }), store, NOW)
    expect(loadLedger(ALICE, store, NOW)).toHaveLength(1)
  })

  it('prunes only once the refund window is long gone', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ expiresAt: NOW }), store, NOW)
    expect(loadLedger(ALICE, store, NOW + REFUND_GRACE_MS)).toHaveLength(1)
    expect(loadLedger(ALICE, store, NOW + REFUND_GRACE_MS + 1)).toEqual([])
  })

  it('does not write expired rows back when saving or dropping another row', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ escrowId: `0x${'a1'.repeat(32)}`, expiresAt: NOW }), store, NOW)
    const later = NOW + REFUND_GRACE_MS + 1
    saveRow(ALICE, row({ escrowId: `0x${'b2'.repeat(32)}`, expiresAt: later }), store, later)
    expect(JSON.parse(store.getItem(ledgerKey(ALICE)) ?? '[]')).toHaveLength(1)
  })

  it('merges rather than clobbers, so a second tab does not lose its rows', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ escrowId: `0x${'a1'.repeat(32)}` }), store, NOW)
    saveRow(ALICE, row({ escrowId: `0x${'b2'.repeat(32)}` }), store, NOW)
    expect(loadLedger(ALICE, store, NOW)).toHaveLength(2)
  })

  it('returns an empty ledger when the stored value is corrupt', () => {
    const store = memoryStorage()
    store.setItem(ledgerKey(ALICE), '{not json')
    expect(loadLedger(ALICE, store, NOW)).toEqual([])
  })

  it('ignores a stored row that is missing the fields that matter', () => {
    const store = memoryStorage()
    store.setItem(ledgerKey(ALICE), JSON.stringify([{ nonsense: true }, { escrowId: '0x1' }]))
    expect(loadLedger(ALICE, store, NOW)).toEqual([])
  })

  it('does not throw when storage is unavailable or full', () => {
    const store = throwingStorage()
    expect(() => loadLedger(ALICE, store, NOW)).not.toThrow()
    expect(loadLedger(ALICE, store, NOW)).toEqual([])
    expect(() => saveRow(ALICE, row(), store, NOW)).not.toThrow()
    expect(() => dropRow(ALICE, row().escrowId, store, NOW)).not.toThrow()
    expect(() => patchRow(ALICE, row().escrowId, { outputText: 'hi' }, store, NOW)).not.toThrow()
  })
})

describe('one ledger per wallet', () => {
  it('keeps two wallets apart in the same browser', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ escrowId: `0x${'a1'.repeat(32)}` }), store, NOW)
    saveRow(BOB, row({ escrowId: `0x${'b2'.repeat(32)}` }), store, NOW)
    expect(loadLedger(ALICE, store, NOW).map((r) => r.escrowId)).toEqual([`0x${'a1'.repeat(32)}`])
    expect(loadLedger(BOB, store, NOW).map((r) => r.escrowId)).toEqual([`0x${'b2'.repeat(32)}`])
  })

  it('does not let one wallet drop another wallet’s row', () => {
    const store = memoryStorage()
    saveRow(ALICE, row(), store, NOW)
    dropRow(BOB, row().escrowId, store, NOW)
    expect(loadLedger(ALICE, store, NOW)).toHaveLength(1)
  })

  it('treats an address case-insensitively, since a checksummed and a lowercase form are one wallet', () => {
    const store = memoryStorage()
    saveRow(ALICE.toUpperCase().replace('0XA', '0xA'), row(), store, NOW)
    expect(loadLedger(ALICE.toLowerCase(), store, NOW)).toHaveLength(1)
  })

  it('scopes the storage key by address', () => {
    expect(ledgerKey(ALICE)).toContain(ALICE.toLowerCase())
    expect(ledgerKey(ALICE)).not.toBe(ledgerKey(BOB))
  })

  it('adopts a pre-wallet ledger once, for the first wallet that reads it', () => {
    const store = memoryStorage()
    store.setItem('dusk.buy.v1', JSON.stringify([{ ...row(), amountWei: '8000n' }]))
    expect(loadLedger(ALICE, store, NOW)).toHaveLength(1)
    expect(store.getItem('dusk.buy.v1')).toBeNull()
    expect(loadLedger(BOB, store, NOW)).toEqual([])
    expect(loadLedger(ALICE, store, NOW)).toHaveLength(1)
  })

  it('does not let a legacy ledger overwrite rows the wallet already has', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ escrowId: `0x${'a1'.repeat(32)}`, prompt: 'mine' }), store, NOW)
    store.setItem(
      'dusk.buy.v1',
      JSON.stringify([{ ...row(), escrowId: `0x${'a1'.repeat(32)}`, prompt: 'legacy', amountWei: '8000n' }]),
    )
    const all = loadLedger(ALICE, store, NOW)
    expect(all).toHaveLength(1)
    expect(all[0]!.prompt).toBe('mine')
  })
})

describe('remembering the delivery', () => {
  const delivered = (over: Partial<LedgerRow> = {}): LedgerRow =>
    row({
      outputRef: 'ab'.repeat(32),
      outputHash: `0x${'77'.repeat(32)}`,
      outputText: 'the answer',
      receipt: { modelServed: '0gm-1.0-35b-a3b', tokensIn: 3, tokensOut: 8, latencyMs: 1_200, worker: BOB },
      deliveredAt: NOW + 30_000,
      ...over,
    })

  it('round-trips the reference, the hash, the answer and the receipt detail', () => {
    const store = memoryStorage()
    const r = delivered()
    saveRow(ALICE, r, store, NOW)
    expect(loadLedger(ALICE, store, NOW)[0]).toEqual(r)
  })

  it('patches a delivery onto a posted row without losing the prompt', () => {
    const store = memoryStorage()
    saveRow(ALICE, row(), store, NOW)
    patchRow(ALICE, row().escrowId, { outputRef: 'ab'.repeat(32), deliveredAt: NOW + 10 }, store, NOW)
    patchRow(ALICE, row().escrowId, { outputText: 'the answer' }, store, NOW)
    const [back] = loadLedger(ALICE, store, NOW)
    expect(back!.prompt).toBe('summarise this')
    expect(back!.outputRef).toBe('ab'.repeat(32))
    expect(back!.outputText).toBe('the answer')
    expect(loadLedger(ALICE, store, NOW)).toHaveLength(1)
  })

  it('ignores a patch for an escrow id this wallet has never seen', () => {
    const store = memoryStorage()
    patchRow(ALICE, `0x${'ee'.repeat(32)}`, { outputText: 'x' }, store, NOW)
    expect(loadLedger(ALICE, store, NOW)).toEqual([])
  })

  it('cannot patch another wallet’s row', () => {
    const store = memoryStorage()
    saveRow(ALICE, row(), store, NOW)
    patchRow(BOB, row().escrowId, { outputText: 'not yours' }, store, NOW)
    expect(loadLedger(ALICE, store, NOW)[0]!.outputText).toBeUndefined()
  })

  it('keeps a delivered row past the refund window, because the output outlives the money', () => {
    const store = memoryStorage()
    saveRow(ALICE, delivered({ expiresAt: NOW }), store, NOW)
    expect(loadLedger(ALICE, store, NOW + REFUND_GRACE_MS + 1)).toHaveLength(1)
    expect(loadLedger(ALICE, store, NOW + 10 * REFUND_GRACE_MS)).toHaveLength(1)
  })

  it('still prunes an undelivered row, which holds nothing worth keeping', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ expiresAt: NOW }), store, NOW)
    expect(loadLedger(ALICE, store, NOW + REFUND_GRACE_MS + 1)).toEqual([])
  })

  it('keeps a row that has only the cached answer, which a private job is', () => {
    const store = memoryStorage()
    saveRow(
      ALICE,
      row({ visibility: 'private', expiresAt: NOW, outputText: 'the secret answer' }),
      store,
      NOW,
    )
    expect(loadLedger(ALICE, store, NOW + REFUND_GRACE_MS + 1)).toHaveLength(1)
  })
})

describe('deliveryPatch', () => {
  const receipt = (over: Partial<Receipt> = {}): Receipt =>
    ({
      id: `0x${'11'.repeat(32)}`,
      jobId: `0x${'44'.repeat(32)}`,
      escrowId: `0x${'33'.repeat(32)}`,
      worker: BOB,
      modelServed: '0gm-1.0-35b-a3b',
      creditsSpent: '7',
      tokensIn: 3,
      tokensOut: 8,
      outputRef: 'ab'.repeat(32),
      outputHash: `0x${'77'.repeat(32)}`,
      latencyMs: 1_200,
      trustMode: 'verified',
      visibility: 'public',
      ...over,
    }) as Receipt

  it('takes the reference, hash and receipt detail from a public receipt', () => {
    const patch = deliveryPatch(receipt(), NOW)
    expect(patch.outputRef).toBe('ab'.repeat(32))
    expect(patch.outputHash).toBe(`0x${'77'.repeat(32)}`)
    expect(patch.deliveredAt).toBe(NOW)
    expect(patch.receipt).toEqual({
      modelServed: '0gm-1.0-35b-a3b',
      tokensIn: 3,
      tokensOut: 8,
      latencyMs: 1_200,
      worker: BOB,
    })
  })

  it('omits the reference on a private job, whose sealed form nothing can read later', () => {
    const patch = deliveryPatch(receipt({ visibility: 'private', outputRef: `0x${'ef'.repeat(97)}` }), NOW)
    expect(patch.outputRef).toBeUndefined()
    expect(patch.outputHash).toBe(`0x${'77'.repeat(32)}`)
    expect(dump(patch)).not.toContain('ef'.repeat(64))
  })

  it('treats a receipt with no visibility as public, matching every other reader', () => {
    const { visibility: _omitted, ...rest } = receipt()
    expect(deliveryPatch(rest as Receipt, NOW).outputRef).toBe('ab'.repeat(32))
  })

  it('takes only named fields, so a wider Receipt cannot smuggle one in', () => {
    const patch = deliveryPatch(receipt({ creditsSpent: 'sk-live-leak' } as Partial<Receipt>), NOW)
    expect(dump(patch)).not.toMatch(/\b(sk|mk)-/)
  })

  it('writes no 128-hex value for a private job even through storage', () => {
    const store = memoryStorage()
    saveRow(ALICE, row({ visibility: 'private' }), store, NOW)
    patchRow(
      ALICE,
      row().escrowId,
      deliveryPatch(receipt({ visibility: 'private', outputRef: `0x${'ef'.repeat(97)}` }), NOW),
      store,
      NOW,
    )
    expect(store.getItem(ledgerKey(ALICE)) ?? '').not.toMatch(/[0-9a-fA-F]{128}/)
  })
})

describe('rowFromPosted', () => {
  const posted = {
    id: `0x${'44'.repeat(32)}`,
    model: '0gm-1.0-35b-a3b',
    maxPricePer1kOut: 1_000n,
    maxTokens: 8,
    trustMode: 'verified' as const,
    visibility: 'public' as const,
    inputRef: 'ab'.repeat(32),
    inputHash: `0x${'66'.repeat(32)}` as Hex,
    buyerPubkey: `0x${'22'.repeat(33)}` as Hex,
    escrowId: `0x${'33'.repeat(32)}` as Hex,
    status: 'open' as const,
    expiresAt: NOW + 600_000,
    amountWei: 8_000n,
    fundTx: `0x${'55'.repeat(32)}` as Hex,
  }

  it('carries the identifiers a refund needs', () => {
    const r = rowFromPosted(posted, 'summarise this', NOW)
    expect(r.escrowId).toBe(posted.escrowId)
    expect(r.fundTx).toBe(posted.fundTx)
    expect(r.amountWei).toBe(8_000n)
  })

  it('carries the prompt, not the encrypted reference', () => {
    const r = rowFromPosted(
      { ...posted, visibility: 'private', encryptedRef: 'ef'.repeat(64) },
      'secret prompt',
      NOW,
    )
    expect(r.prompt).toBe('secret prompt')
    expect(dump(r)).not.toContain('ef'.repeat(64))
  })

  it('takes only named fields, so a wider PostedJob cannot smuggle one in', () => {
    const r = rowFromPosted({ ...posted, somethingNew: 'sk-live-leak' } as never, 'hi', NOW)
    expect(dump(r)).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('attachment names', () => {
  it('round-trips the names of what was attached, and never the attachments themselves', () => {
    const storage = memoryStorage()
    saveRow(ALICE, row({ attachmentNames: ['cat.jpg', 'notes.md'] }), storage, NOW)
    expect(loadLedger(ALICE, storage, NOW)[0]?.attachmentNames).toEqual(['cat.jpg', 'notes.md'])
  })

  it('drops a malformed list rather than the row', () => {
    const storage = memoryStorage()
    storage.setItem(ledgerKey(ALICE), dump([{ ...row(), attachmentNames: [1, 2] }]).replace(/"(\d+)n"/g, '"$1n"'))
    const rows = loadLedger(ALICE, storage, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attachmentNames).toBeUndefined()
  })

  it('rowFromPosted takes the names when given', () => {
    const posted = {
      id: `0x${'44'.repeat(32)}`, model: 'm', maxPricePer1kOut: 1n, maxTokens: 8,
      trustMode: 'verified' as const, visibility: 'public' as const, inputHash: `0x${'66'.repeat(32)}` as Hex,
      buyerPubkey: `0x${'22'.repeat(33)}` as Hex, escrowId: `0x${'33'.repeat(32)}` as Hex,
      status: 'open' as const, expiresAt: NOW + 1, amountWei: 1n,
    }
    expect(rowFromPosted(posted, 'look', NOW, ['a.png']).attachmentNames).toEqual(['a.png'])
    expect(rowFromPosted(posted, 'look', NOW).attachmentNames).toBeUndefined()
  })
})

describe('inFlightRows — what /buy picks back up after a reload', () => {
  it('keeps a posted, undelivered job that has not expired', () => {
    expect(inFlightRows([row()], NOW)).toHaveLength(1)
  })
  it.each([
    ['delivered (receipt saved)', { receipt: { modelServed: 'm', tokensIn: 1, tokensOut: 1, latencyMs: 1, worker: ALICE as `0x${string}` } }],
    ['delivered (hash saved)', { outputHash: `0x${'77'.repeat(32)}` as Hex }],
    ['expired', { expiresAt: NOW - 1 }],
    ['funded but never posted', { jobId: '' }],
  ])('drops a row that is %s', (_, over) => {
    expect(inFlightRows([row(over as Partial<LedgerRow>)], NOW)).toHaveLength(0)
  })
})
