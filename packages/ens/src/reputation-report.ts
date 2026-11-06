import { encodeAbiParameters, getAbiItem, type Address, type Hex } from 'viem'
import { DuskReputationAbi } from './reputation-abi'
import type { ReputationEvaluation } from './reputation-score'

const evaluationArray = { ...getAbiItem({ abi: DuskReputationAbi, name: 'processEvaluation' }).inputs[0], type: 'tuple[]' as const }

export function encodeReputationReport(args: {
  chainId: number; receiver: Address; epoch: number; sources: Hex; evaluations: readonly ReputationEvaluation[];
}): Hex {
  return encodeAbiParameters([
    { type: 'uint256' }, { type: 'address' }, { type: 'uint32' }, { type: 'bytes32' }, evaluationArray,
  ], [BigInt(args.chainId), args.receiver, args.epoch, args.sources, args.evaluations])
}
