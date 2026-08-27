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

import type { Json } from './types.ts'
import type { BlockRow } from './types.ts'
import { asObject } from './wire.ts'

export function plainTextOf(rich: unknown): string {
  if (!Array.isArray(rich)) return ''
  let out = ''
  for (const part of rich) {
    const item = part as Json
    if (typeof item.plain_text === 'string') {
      out += item.plain_text
      continue
    }
    const text = item.text as Json | undefined
    if (text !== undefined && typeof text.content === 'string') out += text.content
  }
  return out
}

// The title of a page is whichever property has type "title"; a database row
// names that column itself (Name, Task, ...) so it cannot be looked up by key.

export function normalizeRichText(value: unknown): Json[] {
  if (!Array.isArray(value)) return []
  const out: Json[] = []
  for (const part of value) {
    const item = asObject(part)
    const text = asObject(item.text)
    const content =
      typeof text.content === 'string'
        ? text.content
        : typeof item.plain_text === 'string'
          ? item.plain_text
          : ''
    const entry: Json = {
      type: typeof item.type === 'string' ? item.type : 'text',
      plain_text: typeof item.plain_text === 'string' ? item.plain_text : content,
    }
    if (item.annotations !== undefined) entry.annotations = item.annotations
    entry.text = { content }
    if (item.href !== undefined) entry.href = item.href
    out.push(entry)
  }
  return out
}

// The value key is the discriminator: {"select": {...}} says select on its
// own, which is how a body that omits `type` still names its own shape. The

export function richToMd(rich: unknown): string {
  if (!Array.isArray(rich)) return ''
  let out = ''
  for (const part of rich) {
    const item = asObject(part)
    let text = typeof item.plain_text === 'string' ? item.plain_text : ''
    const ann = asObject(item.annotations)
    if (ann.code === true) text = `\`${text}\``
    if (ann.bold === true) text = `**${text}**`
    if (ann.italic === true) text = `*${text}*`
    if (ann.strikethrough === true) text = `~~${text}~~`
    if (typeof item.href === 'string' && item.href !== '') text = `[${text}](${item.href})`
    out += text
  }
  return out
}

export function blockToMd(row: BlockRow, indent: number): string {
  const content = JSON.parse(row.payloadJson) as Json
  const text = richToMd(content.rich_text)
  const pad = '  '.repeat(indent)
  const t = row.type
  if (t === 'paragraph') return `${pad}${text}`
  if (t === 'heading_1' || t === 'heading_2' || t === 'heading_3') {
    return `${'#'.repeat(Number(t.slice(-1)))} ${text}`
  }
  if (t === 'bulleted_list_item') return `${pad}- ${text}`
  if (t === 'numbered_list_item') return `${pad}1. ${text}`
  if (t === 'to_do') return `${pad}- [${content.checked === true ? 'x' : ' '}] ${text}`
  if (t === 'toggle') return `${pad}<details><summary>${text}</summary></details>`
  if (t === 'code') return `\`\`\`${String(content.language ?? '')}\n${text}\n\`\`\``
  if (t === 'quote') return `${pad}> ${text}`
  if (t === 'divider') return '---'
  if (t === 'child_page' || t === 'child_database') return ''
  return text === '' ? '' : `${pad}${text}`
}

export function markdownToBlocks(markdown: string): Json[] {
  const blocks: Json[] = []
  const lines = markdown.split('\n')
  let fence: string[] | null = null
  let lang = ''
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (fence === null) {
        fence = []
        lang = line.slice(3).trim()
      } else {
        blocks.push({
          type: 'code',
          code: { rich_text: [plainRich(fence.join('\n'))], language: lang || 'plain text' },
        })
        fence = null
      }
      continue
    }
    if (fence !== null) {
      fence.push(line)
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '') continue
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      const level = heading[1]?.length ?? 1
      blocks.push({
        type: `heading_${String(level)}`,
        [`heading_${String(level)}`]: { rich_text: [plainRich(heading[2] ?? '')] },
      })
      continue
    }
    const todo = /^-\s+\[([ xX])\]\s+(.*)$/.exec(trimmed)
    if (todo !== null) {
      blocks.push({
        type: 'to_do',
        to_do: {
          rich_text: [plainRich(todo[2] ?? '')],
          checked: (todo[1] ?? ' ').toLowerCase() === 'x',
        },
      })
      continue
    }
    if (trimmed.startsWith('- ')) {
      blocks.push({
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [plainRich(trimmed.slice(2))] },
      })
      continue
    }
    blocks.push({ type: 'paragraph', paragraph: { rich_text: [plainRich(trimmed)] } })
  }
  return blocks
}

function plainRich(content: string): Json {
  return { type: 'text', plain_text: content, annotations: {}, text: { content } }
}
