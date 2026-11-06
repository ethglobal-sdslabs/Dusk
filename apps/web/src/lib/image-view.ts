'use client'

import type { ImageContentType, SwarmRef, SwarmStore } from '@dusk/core'
import { sniffImage } from '@dusk/core'

export async function loadSwarmImage(
  swarm: Pick<SwarmStore, 'download'>,
  ref: SwarmRef,
): Promise<{ url: string; contentType: ImageContentType }> {
  const bytes = await swarm.download(ref)
  const contentType = sniffImage(bytes)
  if (!contentType) {
    throw new Error(`the blob at ${ref.slice(0, 12)}… is not an image (${bytes.length} bytes)`)
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }))
  return { url, contentType }
}
