import 'dotenv/config'
import '@dusk/core/env'
import { createPublicClient, http, formatEther } from 'viem'
import { loadConfig, partyKey } from '@dusk/core'
import { arkivChain } from '@dusk/arkiv'
import { privateKeyToAccount } from 'viem/accounts'
const config = loadConfig(process.env)
const accessKey = process.env.ARKIV_ACCESS_KEY?.trim()
const pub = createPublicClient({ chain: arkivChain(accessKey ? { accessKey } : {}), transport: http() })
console.log('chain', await pub.getChainId(), config.arkiv.rpc)
for (const party of ['buyer', 'worker'] as const) {
  const a = privateKeyToAccount(partyKey(process.env, party))
  console.log(party, a.address, formatEther(await pub.getBalance({ address: a.address })))
}
