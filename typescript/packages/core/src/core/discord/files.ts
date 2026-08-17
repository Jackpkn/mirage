// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { apiRequest } from '../api/client.ts'
import { pathSafeName } from '../../utils/sanitize.ts'
import { windowFor } from '../../utils/ranges.ts'

export interface DiscordAttachment {
  id: string
  filename?: string
  title?: string
  url?: string
  proxy_url?: string
  content_type?: string
  size?: number
}

export function fileBlobName(att: DiscordAttachment): string {
  const rawName = att.filename ?? att.title ?? 'file'
  const aid = att.id
  const dot = rawName.lastIndexOf('.')
  if (dot >= 0 && dot < rawName.length - 1) {
    const stem = rawName.slice(0, dot)
    const ext = rawName.slice(dot + 1)
    return `${pathSafeName(stem)}__${aid}.${ext}`
  }
  return `${pathSafeName(rawName)}__${aid}`
}

function downloadError(response: Response): Error {
  return new Error(
    `discord download_file failed: ${String(response.status)} ${response.statusText}`,
  )
}

// Passes the window rather than a prepared header so the answer can be checked
// against it: a CDN is free to ignore Range and reply 200 with the whole file,
// which apiRequest's byte reader then trims.
export async function downloadFile(
  url: string,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const window = windowFor(offset, size)
  return (await apiRequest('GET', url, {
    errorOf: downloadError,
    read: 'bytes',
    ...(window !== undefined ? { window } : {}),
  })) as Uint8Array
}
