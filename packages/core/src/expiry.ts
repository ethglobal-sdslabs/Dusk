export const ARKIV_BLOCK_TIME_SEC = 2

export class TtlAlignmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TtlAlignmentError'
  }
}

export function assertBlockAligned(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new TtlAlignmentError(
      `a TTL must be a positive whole number of seconds, got ${seconds}`,
    )
  }
  if (seconds % ARKIV_BLOCK_TIME_SEC !== 0) {
    const below = seconds - (seconds % ARKIV_BLOCK_TIME_SEC)
    const above = below + ARKIV_BLOCK_TIME_SEC
    throw new TtlAlignmentError(
      `a TTL must be a multiple of the ${ARKIV_BLOCK_TIME_SEC}s Arkiv block time, got ` +
        `${seconds}. Use ${below} or ${above}.`,
    )
  }
  return seconds
}

export function secondsToBlocks(seconds: number): bigint {
  return BigInt(assertBlockAligned(seconds) / ARKIV_BLOCK_TIME_SEC)
}

export function driftRatio(nominalSec: number, observedSec: number): number {
  return observedSec / nominalSec
}
