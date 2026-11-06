import 'dotenv/config'
import '@dusk/core/env'
import { attrEq } from '@dusk/arkiv'
import { keccak256 } from 'viem'
import { buildServiceDeps } from '../mcp/src/deps'
const jobId = process.argv[2]!
const { buyer } = buildServiceDeps(process.env)
const rs = (await buyer.arkiv.query<any>('receipt', attrEq('receipt', 'jobId', jobId))).filter((r: any) => r.jobId === jobId)
console.log('receipts', rs.length)
for (const r of rs) {
  const deal = await buyer.escrow!.deal(r.escrowId).catch((e: any) => { console.log('deal err', e.message); return null })
  console.log('deal', deal && { state: deal.state, buyer: deal.buyer, worker: deal.worker, outputHash: deal.outputHash })
  console.log('receipt', { owner: r.owner, worker: r.worker, outputHash: r.outputHash, visibility: r.visibility, refLen: r.outputRef?.length })
  console.log('check buyer match', deal?.buyer.toLowerCase() === buyer.address.toLowerCase())
  console.log('check hash match ', deal?.outputHash === r.outputHash)
  console.log('check owner match', r.owner?.toLowerCase() === deal?.worker.toLowerCase())
  let ref = r.outputRef
  if (r.visibility === 'private') {
    try { ref = buyer.unsealOutput!(r.outputRef); console.log('unseal OK, ref len', ref.length) } catch (e: any) { console.log('unseal FAIL', e.message); continue }
  }
  try { const b = await buyer.swarm.download(ref); console.log('download OK', b.length, 'hash match', keccak256(b) === r.outputHash) } catch (e: any) { console.log('download FAIL', e.message) }
}
