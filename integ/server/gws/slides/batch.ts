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
import { replaceAllText } from '../docs/body.ts'
import { touchNative } from '../drive/item.ts'
import type { GwsState } from '../store/state.ts'
import type { SlidePage } from '../store/types.ts'
import { asBool, asNum, asObj, asStr, asStrArr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'
import { NOT_FOUND, googleError, ok } from '../wire/reply.ts'
import { newSlide } from './page.ts'

function renamedId(map: JsonObj, key: string): string | undefined {
  return asStr(map[key])
}

export function slidesBatchUpdate(st: GwsState, id: string, requests: JsonObj[]): Reply {
  const pres = st.presentations.get(id)
  if (pres === undefined) return NOT_FOUND
  const replies: JsonValue[] = []
  for (const request of requests) {
    if ('createSlide' in request) {
      const r = asObj(request.createSlide)
      const slide = newSlide(st, asStr(r.objectId))
      // insertionIndex places the slide; omitted means append, which is
      // what every existing caller relies on.
      pres.slides.splice(asNum(r.insertionIndex) ?? pres.slides.length, 0, slide)
      replies.push({ createSlide: { objectId: slide.objectId } })
    } else if ('createShape' in request) {
      const r = asObj(request.createShape)
      const pageObjectId = asStr(asObj(r.elementProperties).pageObjectId)
      const page = pres.slides.find((s) => s.objectId === pageObjectId)
      const objectId = asStr(r.objectId) ?? st.nextId('shape')
      if (page === undefined) {
        return googleError(400, 'Invalid pageObjectId.', 'INVALID_ARGUMENT')
      }
      if (pres.slides.some((s) => s.objectId === objectId || s.texts.has(objectId))) {
        return googleError(400, `Object id already exists: ${objectId}`, 'INVALID_ARGUMENT')
      }
      page.texts.set(objectId, '')
      replies.push({ createShape: { objectId } })
    } else if ('insertText' in request) {
      const r = asObj(request.insertText)
      const objectId = asStr(r.objectId) ?? ''
      const page = pres.slides.find((s) => s.texts.has(objectId))
      if (page === undefined) {
        return googleError(400, 'Invalid insertText objectId.', 'INVALID_ARGUMENT')
      }
      page.texts.set(objectId, (page.texts.get(objectId) ?? '') + (asStr(r.text) ?? ''))
      replies.push({})
    } else if ('deleteText' in request) {
      const r = asObj(request.deleteText)
      const objectId = asStr(r.objectId) ?? ''
      const page = pres.slides.find((s) => s.texts.has(objectId))
      if (page === undefined) {
        return googleError(400, 'Invalid deleteText objectId.', 'INVALID_ARGUMENT')
      }
      const text = page.texts.get(objectId) ?? ''
      const textRange = asObj(r.textRange)
      const type = asStr(textRange.type) ?? 'ALL'
      if (type === 'ALL') {
        page.texts.set(objectId, '')
      } else if (type === 'FROM_START_INDEX') {
        page.texts.set(objectId, text.slice(0, asNum(textRange.startIndex) ?? 0))
      } else {
        const start = asNum(textRange.startIndex) ?? 0
        page.texts.set(
          objectId,
          text.slice(0, start) + text.slice(asNum(textRange.endIndex) ?? start),
        )
      }
      replies.push({})
    } else if ('replaceAllText' in request) {
      const r = asObj(request.replaceAllText)
      const contains = asObj(r.containsText)
      const pageObjectIds = asStrArr(r.pageObjectIds)
      // pageObjectIds scopes the replace to those slides; absent means the
      // whole presentation.
      const scope =
        pageObjectIds === undefined
          ? pres.slides
          : pres.slides.filter((s) => pageObjectIds.includes(s.objectId))
      let occurrences = 0
      for (const slide of scope) {
        for (const [objectId, text] of slide.texts) {
          const [next, changed] = replaceAllText(
            text,
            asStr(contains.text) ?? '',
            asStr(r.replaceText) ?? '',
            asBool(contains.matchCase) ?? false,
          )
          slide.texts.set(objectId, next)
          occurrences += changed
        }
      }
      replies.push({ replaceAllText: { occurrencesChanged: occurrences } })
    } else if ('duplicateObject' in request) {
      const r = asObj(request.duplicateObject)
      const source = pres.slides.find((s) => s.objectId === asStr(r.objectId))
      if (source === undefined) {
        return googleError(400, 'Invalid duplicateObject objectId.', 'INVALID_ARGUMENT')
      }
      const objectIds = asObj(r.objectIds)
      // Object ids are unique across a whole presentation, so every copied
      // element is re-keyed rather than carried over: two pages sharing an
      // element id would make insertText and deleteText hit whichever page
      // happens to come first. `objectIds` may pin the new names.
      const renamed: [string, string][] = [...source.texts].map(([objectId, text]) => [
        renamedId(objectIds, objectId) ?? st.nextId('shape'),
        text,
      ])
      const copy: SlidePage = {
        objectId: renamedId(objectIds, source.objectId) ?? st.nextId('slide'),
        texts: new Map(renamed),
      }
      pres.slides.splice(pres.slides.indexOf(source) + 1, 0, copy)
      replies.push({ duplicateObject: { objectId: copy.objectId } })
    } else if ('updateSlidesPosition' in request) {
      const r = asObj(request.updateSlidesPosition)
      const ids = new Set(asStrArr(r.slideObjectIds) ?? [])
      const moving = pres.slides.filter((s) => ids.has(s.objectId))
      if (moving.length !== ids.size) {
        return googleError(400, 'Invalid slideObjectIds.', 'INVALID_ARGUMENT')
      }
      const rest = pres.slides.filter((s) => !ids.has(s.objectId))
      const at = asNum(r.insertionIndex) ?? rest.length
      rest.splice(Math.min(at, rest.length), 0, ...moving)
      pres.slides = rest
      replies.push({})
    } else if ('deleteObject' in request) {
      const objectId = asStr(asObj(request.deleteObject).objectId) ?? ''
      pres.slides = pres.slides.filter((s) => s.objectId !== objectId)
      for (const slide of pres.slides) slide.texts.delete(objectId)
      replies.push({})
    } else {
      return googleError(
        400,
        `Unsupported request: ${Object.keys(request).join(',')}`,
        'INVALID_ARGUMENT',
      )
    }
  }
  touchNative(st, id)
  return ok({ presentationId: id, replies })
}
