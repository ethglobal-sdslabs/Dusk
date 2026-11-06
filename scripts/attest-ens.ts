import '@dusk/core/env'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { galileoChain, loadConfig } from '@dusk/core'
import {
  DuskAdmissionAbi, DuskIdentityControllerAbi, coSignRefusal, createEnsReader, loadEnsConfig, mirrorsFromLogs, orderSignatures, signStatus,
  statusFor, type AdmissionStatus,
} from '@dusk/ens'

const args = process.argv.slice(2)
const arg = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const all = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))
const key = (raw: string) => (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
const json = (v: unknown) => JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))
const VALIDITY_SEC = Number(process.env.ENS_ATTESTATION_VALIDITY_SEC ?? 6 * 3600)

type Signed = { status: AdmissionStatus; signer: Address; signature: Hex }

function parseSigned(raw: string): Signed[] {
  return (JSON.parse(raw) as Array<{ status: Record<string, string | number | boolean>; signer: Address; signature: Hex }>).map((s) => ({
    signer: s.signer, signature: s.signature,
    status: {
      sourceChainId: BigInt(s.status.sourceChainId as string), controller: s.status.controller as Address, wallet: s.status.wallet as Address,
      admitted: Boolean(s.status.admitted), sourceBlock: BigInt(s.status.sourceBlock as string), validUntil: BigInt(s.status.validUntil as string),
      epoch: Number(s.status.epoch),
    },
  }))
}

const sameStatus = (a: AdmissionStatus, b: AdmissionStatus) => json(a) === json(b)

async function pass(): Promise<void> {
  const ens = loadEnsConfig({ ...process.env, ENS_MODE: 'display', ...(arg('--sepolia-rpc') ? { ENS_RPC: arg('--sepolia-rpc') } : {}) })
  if (!ens.controller) throw new Error('ENS_CONTROLLER_ADDRESS is required')
  const controller = ens.controller
  const admissionRaw = process.env.DUSK_ADMISSION_ADDRESS?.trim()
  if (!admissionRaw || !isAddress(admissionRaw)) throw new Error('DUSK_ADMISSION_ADDRESS is required')
  const admission = getAddress(admissionRaw)
  const config = loadConfig(process.env)
  const galileoRpc = arg('--galileo-rpc') ?? config.escrow.rpc
  const galileo = galileoChain({ chainId: config.escrow.chainId, rpc: galileoRpc })
  const dest = createPublicClient({ chain: galileo, transport: http(galileoRpc) })
  const sepoliaPub = createPublicClient({ chain: sepolia, transport: http(ens.rpc) })
  const reader = createEnsReader(ens, sepoliaPub)

  const attesterRaw = process.env.ENS_ATTESTER_PRIVATE_KEY?.trim()
  if (!attesterRaw) throw new Error('config.json operators.ensAttesterPrivateKey is required')
  const attester = privateKeyToAccount(key(attesterRaw))
  if (!(await dest.readContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'isAttester', args: [attester.address] }))) {
    throw new Error(`${attester.address} is not an attester on ${admission}`)
  }
  const [epoch, quorum, controllerOnDest] = await Promise.all([
    dest.readContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'epoch' }),
    dest.readContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'quorum' }),
    dest.readContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'CONTROLLER' }),
  ])
  if (controllerOnDest.toLowerCase() !== controller.toLowerCase()) throw new Error(`DuskAdmission trusts controller ${controllerOnDest}, not ${controller}`)

  const knownPath = `.dusk/attest-wallets-${galileo.id}-${admission.toLowerCase()}.json`
  const knownWallets = new Set<string>(existsSync(knownPath) ? (JSON.parse(readFileSync(knownPath, 'utf8')) as string[]) : [])
  let wallets = all('--wallet').flatMap((w) => w.split(',')).filter(Boolean).map((w) => getAddress(w))
  if (wallets.length === 0) {
    const head = await sepoliaPub.getBlockNumber()
    const span = BigInt(arg('--blocks') ?? '5000')
    const logs = await sepoliaPub.getLogs({ address: controller, fromBlock: head > span ? head - span : 0n, toBlock: head })
    const registry = await sepoliaPub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'REGISTRY' }) as Address
    const { identities, moderations } = mirrorsFromLogs(ens, registry, logs)
    wallets = [...new Set([...identities.map((r) => r.wallet), ...moderations.map((r) => r.subjectWallet), ...knownWallets].map((w) => getAddress(w)))]
  }
  for (const w of wallets) knownWallets.add(w.toLowerCase())
  mkdirSync(dirname(knownPath), { recursive: true })
  writeFileSync(knownPath, JSON.stringify([...knownWallets].sort()))

  const extra = all('--with').flatMap((file) => parseSigned(readFileSync(file, 'utf8')))
  const signOnly = args.includes('--sign-only')
  const out: Signed[] = []
  const submitter = privateKeyToAccount(key(process.env.ENS_SUBMITTER_PRIVATE_KEY?.trim() || attesterRaw))
  const wallet = createWalletClient({ chain: galileo, transport: http(galileoRpc), account: submitter })

  for (const w of wallets) {
    const shared = extra.find((s) => s.status.wallet.toLowerCase() === w.toLowerCase())
    let status = shared?.status
    if (!status) {
      const identity = await reader.identityOf(w)
      status = statusFor(identity, { controller, nowSec: Math.floor(Date.now() / 1000), validitySec: VALIDITY_SEC, epoch }) ?? undefined
      if (!status) { console.error(`  ${w}: identity unreadable (${identity.reason ?? 'unknown'}) — not attested; any old status will expire`); continue }
    } else {
      const identity = await reader.identityOf(w)
      const refusal = coSignRefusal(status, identity, { controller, nowSec: Math.floor(Date.now() / 1000), validitySec: VALIDITY_SEC, epoch })
      if (refusal) { console.error(`  ${w}: refusing to co-sign — ${refusal}`); continue }
    }
    const mine = await signStatus(attester, galileo.id, admission, status)
    if (signOnly) { out.push({ status, ...mine }); continue }

    const record = await dest.readContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'records', args: [w] })
    if (record[3] === epoch && record[1] >= status.sourceBlock) { console.log(`  ${w}: already current (block ${record[1]})`); continue }
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    if (!shared && record[3] === epoch && record[0] === status.admitted && record[2] - nowSec > BigInt(VALIDITY_SEC / 2)) {
      console.log(`  ${w}: unchanged (admitted=${status.admitted}), valid until ${record[2]}`)
      continue
    }
    const others = extra.filter((s) => sameStatus(s.status, status!) && s.signer.toLowerCase() !== attester.address.toLowerCase())
    const sigs = [mine]
    for (const o of others) {
      if (await dest.readContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'isAttester', args: [o.signer] })) sigs.push(o)
      else console.error(`  ${w}: ignoring a signature from ${o.signer}, which is not an attester`)
    }
    if (BigInt(sigs.length) < quorum) { console.error(`  ${w}: ${sigs.length} of ${quorum} signatures — run --sign-only on the other attesters and pass --with`); continue }
    const hash = await wallet.writeContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'submit', args: [status, orderSignatures(sigs)] })
    const receipt = await dest.waitForTransactionReceipt({ hash })
    console.log(`  ${w}: admitted=${status.admitted} at Sepolia block ${status.sourceBlock} → ${receipt.status} ${hash}`)
  }
  if (signOnly) console.log(json(out))
}

try {
  do {
    await pass()
    if (args.includes('--watch')) await new Promise((r) => setTimeout(r, 60_000))
  } while (args.includes('--watch'))
} catch (error) {
  console.error(error instanceof Error && !/https?:\/\//.test(error.message) ? error.message : 'Attestation failed; no URL is repeated here.')
  process.exitCode = 1
}
