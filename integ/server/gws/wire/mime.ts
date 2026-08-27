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

import type { JsonObj } from './json.ts'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DOC_MIME = 'application/vnd.google-apps.document'
export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
export const SLIDE_MIME = 'application/vnd.google-apps.presentation'
export const FORM_MIME = 'application/vnd.google-apps.form'

export const OWNER: JsonObj = {
  displayName: 'Integ User',
  emailAddress: 'integ@example.com',
  me: true,
}

export function isNativeMime(mime: string): boolean {
  return mime === DOC_MIME || mime === SHEET_MIME || mime === SLIDE_MIME
}
