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

import type { GmailHeader } from '../store/types.ts'

export function b64url(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export interface MimePart {
  headers: Map<string, string>
  body: Buffer
}

export interface ParsedAttachment {
  filename: string
  mimeType: string
  data: Buffer
}

export interface ParsedMessage {
  headers: GmailHeader[]
  bodyText: string
  attachments: ParsedAttachment[]
}

export function splitMime(raw: Buffer): MimePart {
  let sep = raw.indexOf('\r\n\r\n')
  let sepLen = 4
  if (sep === -1) {
    sep = raw.indexOf('\n\n')
    sepLen = 2
  }
  const headers = new Map<string, string>()
  const head = sep === -1 ? raw.toString('utf-8') : raw.subarray(0, sep).toString('utf-8')
  let lastKey = ''
  for (const line of head.split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lastKey !== '') {
      headers.set(lastKey, `${headers.get(lastKey) ?? ''} ${line.trim()}`)
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    lastKey = line.slice(0, colon).trim().toLowerCase()
    headers.set(lastKey, line.slice(colon + 1).trim())
  }
  return { headers, body: sep === -1 ? Buffer.alloc(0) : raw.subarray(sep + sepLen) }
}

export function decodePartBody(part: MimePart): Buffer {
  const cte = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase()
  if (cte === 'base64') {
    return Buffer.from(part.body.toString('ascii').replace(/\s+/g, ''), 'base64')
  }
  // 7bit/8bit: trim the trailing CRLF the MIME serialization appends.
  let body = part.body
  while (body.length > 0 && (body[body.length - 1] === 10 || body[body.length - 1] === 13)) {
    body = body.subarray(0, body.length - 1)
  }
  return body
}

export function filenameOf(part: MimePart): string {
  const disposition = part.headers.get('content-disposition') ?? ''
  const m = /filename="?([^";]+)"?/.exec(disposition)
  if (m !== null) return m[1] as string
  const n = /name="?([^";]+)"?/.exec(part.headers.get('content-type') ?? '')
  return n === null ? '' : (n[1] as string)
}

const WANTED_HEADERS = [
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'Message-ID',
  'In-Reply-To',
  'References',
]

// Parses the constrained MIME the adapters and mirage's send path emit:
// either a single text/plain message or multipart/mixed with one text part
// and base64 attachment parts.
export function parseRfc822(raw: Buffer): ParsedMessage {
  const top = splitMime(raw)
  const headers: GmailHeader[] = []
  for (const name of WANTED_HEADERS) {
    const value = top.headers.get(name.toLowerCase())
    if (value !== undefined) headers.push({ name, value })
  }
  const contentType = top.headers.get('content-type') ?? 'text/plain'
  if (!contentType.toLowerCase().startsWith('multipart/')) {
    return { headers, bodyText: decodePartBody(top).toString('utf-8'), attachments: [] }
  }
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  if (m === null) throw new Error('missing MIME boundary')
  const boundary = `--${((m[1] ?? m[2]) as string).trim()}`
  let bodyText = ''
  const attachments: ParsedAttachment[] = []
  const text = top.body
  let from = text.indexOf(boundary)
  while (from !== -1) {
    const start = from + boundary.length
    if (text.subarray(start, start + 2).toString() === '--') break
    const next = text.indexOf(boundary, start)
    if (next === -1) break
    let chunk = text.subarray(start, next)
    while (chunk.length > 0 && (chunk[0] === 10 || chunk[0] === 13)) chunk = chunk.subarray(1)
    const part = splitMime(chunk)
    const partType = (part.headers.get('content-type') ?? 'text/plain').split(';')[0]?.trim() ?? ''
    const filename = filenameOf(part)
    if (filename !== '') {
      attachments.push({ filename, mimeType: partType, data: decodePartBody(part) })
    } else if (partType === 'text/plain' || partType === '') {
      bodyText = decodePartBody(part).toString('utf-8')
    }
    from = next
  }
  return { headers, bodyText, attachments }
}

// Multipart/related upload: one JSON metadata part followed by the media.
export function parseMultipartRelated(
  body: Buffer,
  contentType: string,
): { metadata: string; media: Buffer } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  if (m === null) throw new Error('missing multipart boundary')
  const boundary = Buffer.from('--' + ((m[1] ?? m[2]) as string).trim())
  const parts: Buffer[] = []
  let from = body.indexOf(boundary)
  while (from !== -1) {
    const start = from + boundary.length
    const next = body.indexOf(boundary, start)
    if (next === -1) break
    parts.push(body.subarray(start, next))
    from = next
  }
  if (parts.length < 2) throw new Error('expected two multipart parts')
  return {
    metadata: stripPartHead(parts[0] as Buffer).toString('utf-8'),
    media: stripPartHead(parts[1] as Buffer),
  }
}

function stripPartHead(part: Buffer): Buffer {
  let sep = part.indexOf('\r\n\r\n')
  let sepLen = 4
  if (sep === -1) {
    sep = part.indexOf('\n\n')
    sepLen = 2
  }
  let out = part.subarray(sep + sepLen)
  if (out.length >= 2 && out.subarray(out.length - 2).toString() === '\r\n') {
    out = out.subarray(0, out.length - 2)
  }
  return out
}
