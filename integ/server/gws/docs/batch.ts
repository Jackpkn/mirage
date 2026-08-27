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

import type { JsonValue, Reply } from '../../kit/typescript/index.ts'
import { touchNative } from '../drive/item.ts'
import type { GwsState } from '../store/state.ts'
import { asBool, asNum, asObj, asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { NOT_FOUND, googleError, ok } from '../wire/reply.ts'
import { replaceAllText } from './body.ts'

export function docsBatchUpdate(st: GwsState, id: string, requests: JsonObj[]): Reply {
  const doc = st.docs.get(id)
  if (doc === undefined) return NOT_FOUND
  const replies: JsonValue[] = []
  for (const request of requests) {
    if ('insertText' in request) {
      const r = asObj(request.insertText)
      const text = asStr(r.text) ?? ''
      const index = asNum(asObj(r.location).index)
      if (index !== undefined) {
        const offset = Math.max(0, Math.min(doc.text.length, index - 1))
        doc.text = doc.text.slice(0, offset) + text + doc.text.slice(offset)
      } else {
        doc.text += text
      }
      replies.push({})
    } else if ('deleteContentRange' in request) {
      const range = asObj(asObj(request.deleteContentRange).range)
      const start = Math.max(0, (asNum(range.startIndex) ?? 1) - 1)
      const end = Math.max(start, (asNum(range.endIndex) ?? 1) - 1)
      doc.text = doc.text.slice(0, start) + doc.text.slice(end)
      replies.push({})
    } else if ('replaceAllText' in request) {
      const r = asObj(request.replaceAllText)
      const contains = asObj(r.containsText)
      const [text, occurrences] = replaceAllText(
        doc.text,
        asStr(contains.text) ?? '',
        asStr(r.replaceText) ?? '',
        asBool(contains.matchCase) ?? false,
      )
      doc.text = text
      replies.push({ replaceAllText: { occurrencesChanged: occurrences } })
    } else {
      return googleError(
        400,
        `Unsupported request: ${Object.keys(request).join(',')}`,
        'INVALID_ARGUMENT',
      )
    }
  }
  touchNative(st, id)
  return ok({ documentId: id, replies })
}
