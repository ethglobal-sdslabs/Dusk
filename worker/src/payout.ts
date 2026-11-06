import { isAddress, type Address } from 'viem'

export type PayoutInput = {
  escrowSigner?: Address
  arkivAddress: Address
  configured?: Address
}

export function resolvePayout(input: PayoutInput): Address {
  const { escrowSigner, arkivAddress, configured } = input
  if (configured !== undefined && !isAddress(configured, { strict: false })) {
    throw new Error(
      `DUSK_PAYOUT_ADDRESS is ${JSON.stringify(configured)}, which is not a valid address. ` +
        'Unset it to fall back to this worker\'s own identity, or set it to a well-formed ' +
        'address — a bad value here is only caught later, by encode(\'receipt\'), after ' +
        'og.complete has already billed a mainnet completion.',
    )
  }
  if (!escrowSigner) return configured ?? arkivAddress
  if (configured && configured.toLowerCase() !== escrowSigner.toLowerCase()) {
    throw new Error(
      `DUSK_PAYOUT_ADDRESS is ${configured}, but DuskEscrow pays whoever calls commit — ` +
        `this worker's escrow signer, ${escrowSigner}. The contract has no payee field, so ` +
        'the override cannot redirect anything: it would only write receipts naming an ' +
        'address that never receives the money. Unset DUSK_PAYOUT_ADDRESS, set it to ' +
        `${escrowSigner}, or run with DUSK_WORKER_PRIVATE_KEY set to the key you want paid.`,
    )
  }
  return escrowSigner
}
