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

import type { JsonValue } from '../../kit/typescript/index.ts'
import type { GwsState } from '../store/state.ts'
import type { JsonObj } from '../wire/json.ts'

// The flat text string is authoritative; the Document body JSON is rebuilt
// from it on read with real index arithmetic (offset 1 sits right after the
// sectionBreak slot, each paragraph carries its trailing newline).
export function buildDocBody(text: string): { content: JsonValue[] } {
  const content: JsonValue[] = [
    {
      startIndex: 1,
      endIndex: 1,
      sectionBreak: {
        sectionStyle: {
          columnSeparatorStyle: 'NONE',
          contentDirection: 'LEFT_TO_RIGHT',
          sectionType: 'CONTINUOUS',
        },
      },
    },
  ]
  const normalized = text + '\n'
  let cursor = 1
  const paragraphs = normalized.split('\n')
  if (paragraphs[paragraphs.length - 1] === '') paragraphs.pop()
  for (const para of paragraphs) {
    const paraText = para + '\n'
    const startIndex = cursor
    const endIndex = cursor + paraText.length
    content.push({
      startIndex,
      endIndex,
      paragraph: {
        elements: [{ startIndex, endIndex, textRun: { content: paraText, textStyle: {} } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT', direction: 'LEFT_TO_RIGHT' },
      },
    })
    cursor = endIndex
  }
  return { content }
}

export function fmtDocument(st: GwsState, id: string): JsonObj {
  const doc = st.docs.get(id) as { title: string; text: string }
  const file = st.files.get(id)
  return {
    documentId: id,
    title: doc.title,
    body: buildDocBody(doc.text),
    revisionId: `rev-${String(file?.revisions.length ?? 0)}`,
  }
}

// SubstringMatchCriteria.matchCase defaults to false, i.e. the search is
// case-INSENSITIVE unless the caller opts in. Shared by the Docs and Slides
// replaceAllText requests.
//
// Windows are compared at equal length rather than by lowercasing the whole
// haystack: a lowercase mapping can change a string's length, which would
// misalign every index after it.
export function replaceAllText(
  haystack: string,
  needle: string,
  replacement: string,
  matchCase: boolean,
): [string, number] {
  if (needle === '') return [haystack, 0]
  const find = matchCase ? needle : needle.toLowerCase()
  let out = ''
  let cursor = 0
  let count = 0
  while (cursor + needle.length <= haystack.length) {
    const window = haystack.slice(cursor, cursor + needle.length)
    if ((matchCase ? window : window.toLowerCase()) === find) {
      out += replacement
      cursor += needle.length
      count += 1
    } else {
      out += haystack[cursor] as string
      cursor += 1
    }
  }
  return [out + haystack.slice(cursor), count]
}
