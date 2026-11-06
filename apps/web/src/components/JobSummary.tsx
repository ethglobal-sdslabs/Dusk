import { isImageModel, jobAmountWei, planJob } from '@dusk/core'
import { MAX_TOKENS_CEILING, type RawJobForm } from '../lib/buy-form'
import { blockLabel, PromptBlocks, type BlocksMode } from './PromptBlocks'
import { formatWei } from '../lib/market'

export function JobSummary({ form, maxMinutes, funded, imageModels = [] }: { form: RawJobForm; maxMinutes: number; funded: boolean; imageModels?: readonly string[] }) {
  const isImage = isImageModel(form.model.trim(), imageModels)
  const tokens = isImage ? 1 : Number(form.maxTokens.trim())
  const price = form.maxPricePer1kOut.trim()
  const validAmount = /^\d+$/.test(price) && Number.isSafeInteger(tokens) && tokens >= 1
  const plan = validAmount && !isImage ? planJob(form.prompt, tokens, MAX_TOKENS_CEILING) : null
  const inOrder = plan?.kind === 'serial' && form.visibility !== 'private'
  const pieces = plan?.kind === 'parallel' || (plan?.kind === 'serial' && inOrder) ? plan.pieces : [{ prompt: form.prompt, maxTokens: tokens }]
  const amount = validAmount
    ? pieces.reduce(
        (sum, p) => sum + jobAmountWei({ model: form.model.trim(), maxTokens: p.maxTokens, inputChars: p.prompt.length }, BigInt(price), imageModels),
        0n,
      )
    : null
  const blocksMode: BlocksMode =
    plan?.kind === 'parallel' ? 'parallel' : inOrder ? 'serial' : plan?.kind === 'too-big' ? 'too-big' : 'single'
  const split =
    plan?.kind === 'parallel'
      ? `${plan.pieces.length} pieces, run at once`
      : plan?.kind === 'serial'
        ? inOrder
          ? `${plan.pieces.length} pieces, one after another`
          : 'One job — private steps cannot be passed between workers'
        : plan?.kind === 'too-big'
          ? `Too big — split it into tasks of ≤${plan.limit} tokens`
          : 'One job'
  const minutes = Number(form.deadlineMinutes.trim())
  const deadline = Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= maxMinutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'Choose a valid deadline'

  return <aside className="job-summary" aria-label="Job summary">
    <div className="job-summary-heading"><h3>Job summary</h3><span>{funded ? 'Escrow funding on' : 'Escrow funding off'}</span></div>
    {form.prompt.trim() && plan && (
      <PromptBlocks
        mode={blocksMode}
        pieces={pieces.map((p) => ({ label: blockLabel(p.prompt) }))}
      />
    )}
    <dl>
      <div className="job-summary-amount"><dt>Maximum job payment</dt><dd>{amount === null ? '—' : formatWei(amount)} <span>wei</span></dd></div>
      <div><dt>Deadline</dt><dd>{deadline}</dd></div>
      {isImage ? <div><dt>Output</dt><dd>1 image</dd></div> : plan && plan.kind !== 'single' && <div><dt>Runs as</dt><dd>{split}</dd></div>}
      <div><dt>Prompt</dt><dd>{form.visibility === 'private' ? 'Sealed for the worker' : 'Public'}</dd></div>
    </dl>
    <p>{amount === null
      ? isImage ? 'Enter a valid price per image to calculate the ceiling.' : 'Enter a valid price and token limit to calculate the ceiling.'
      : BigInt(price) === 0n
        ? 'Escrow requires at least 1 wei, even with a zero price. Network and storage fees are separate.'
        : isImage ? 'One image at your price per image. Network and storage fees are separate.' : 'Covers your prompt and the full answer at your price. Network and storage fees are separate.'}</p>
  </aside>
}
