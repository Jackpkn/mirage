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

import type { GwsState } from '../store/state.ts'
import type { FormDoc, FormItem } from '../store/types.ts'
import { asNum, asObj, asStr } from '../wire/json.ts'
import type { JsonObj } from '../wire/json.ts'

export function fmtForm(form: FormDoc): JsonObj {
  return {
    formId: form.formId,
    info: {
      title: form.title,
      documentTitle: form.documentTitle,
      ...(form.description === undefined ? {} : { description: form.description }),
    },
    items: form.items,
    revisionId: String(form.revision),
    responderUri: `https://docs.google.com/forms/d/e/${form.formId}/viewform`,
  }
}

export function newFormItem(st: GwsState, raw: JsonObj): FormItem {
  return { itemId: st.nextId('item'), ...raw }
}

export function applyFormRequest(st: GwsState, form: FormDoc, req: JsonObj): void {
  const createItem = asObj(req.createItem)
  if (createItem.item !== undefined) {
    const item = newFormItem(st, asObj(createItem.item))
    const at = asNum(asObj(createItem.location).index) ?? form.items.length
    form.items.splice(at, 0, item)
    return
  }
  const info = asObj(req.updateFormInfo).info
  if (info !== undefined) {
    const title = asStr(asObj(info).title)
    const description = asStr(asObj(info).description)
    if (title !== undefined) form.title = title
    if (description !== undefined) form.description = description
  }
}
