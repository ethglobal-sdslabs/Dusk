'use client'

import type { ListPrice } from '../lib/list-price'
import { shareOfList, weiAsOg } from '../lib/list-price'
import { formatWei } from '../lib/market'
import { formatUsd } from '../lib/past'

export function ListPriceNote(props: { price: ListPrice | null | undefined; typed?: bigint | null; model?: string }) {
  const { price } = props
  const prefix = props.model ? <><span className="figure">{props.model}</span>: </> : null
  if (price === undefined || price === null) return null
  const share = props.typed !== undefined && props.typed !== null ? shareOfList(props.typed, price.wei) : null
  return (
    <span className="meta">
      {prefix}0G list price <span className="figure money">{formatWei(price.wei)}</span> wei{' '}
      {price.unit === 'image' ? 'per image' : 'per 1,000 output tokens'} (≈ {weiAsOg(price.wei)} 0G
      {price.unit === 'image'
        ? price.usd !== undefined && <>, {formatUsd(price.usd)}</>
        : price.usdPer1mOut !== undefined && (
            <>
              ; {formatUsd(price.usdPer1mIn ?? 0)} in · {formatUsd(price.usdPer1mOut)} out per 1M tokens
            </>
          )}
      ).{share && <> Yours is {share}.</>}
    </span>
  )
}
