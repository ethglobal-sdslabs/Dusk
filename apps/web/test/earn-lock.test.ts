import { describe, expect, it } from 'vitest'
import { holdLeadership, type LockLike } from '../src/lib/earn-lock'

function fakeLocks(): LockLike {
  const queues = new Map<string, Array<() => void>>()
  const held = new Set<string>()
  const pump = (name: string) => {
    if (held.has(name)) return
    const next = queues.get(name)?.shift()
    next?.()
  }
  return {
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const grant = () => {
          held.add(name)
          void Promise.resolve(callback({ name } as Lock)).then((v) => {
            held.delete(name)
            resolve(v)
            pump(name)
          })
        }
        const queue = queues.get(name) ?? []
        queues.set(name, queue)
        queue.push(grant)
        options.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(grant)
          if (i >= 0) {
            queue.splice(i, 1)
            reject(new DOMException('aborted', 'AbortError'))
          }
        })
        pump(name)
      })
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('holdLeadership', () => {
  it('leads at once when nobody holds the lock', async () => {
    let led = 0
    holdLeadership(fakeLocks(), 'w', () => led++)
    await flush()
    expect(led).toBe(1)
  })

  it('makes a second tab wait, and hands over when the first releases', async () => {
    const locks = fakeLocks()
    const order: string[] = []
    const a = holdLeadership(locks, 'w', () => order.push('a'))
    holdLeadership(locks, 'w', () => order.push('b'))
    await flush()
    expect(order).toEqual(['a'])
    a.release()
    await flush()
    expect(order).toEqual(['a', 'b'])
  })

  it('never leads once released while still waiting', async () => {
    const locks = fakeLocks()
    const a = holdLeadership(locks, 'w', () => {})
    let led = false
    const b = holdLeadership(locks, 'w', () => {
      led = true
    })
    await flush()
    b.release()
    a.release()
    await flush()
    expect(led).toBe(false)
  })

  it('leads without a lock API, which is the single-tab case anyway', async () => {
    let led = false
    holdLeadership(undefined, 'w', () => {
      led = true
    })
    await flush()
    expect(led).toBe(true)
  })
})
