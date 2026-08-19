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

import { Codec } from '../hierarchy/codec.ts'

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
export const DOCS_API_BASE = 'https://docs.googleapis.com/v1'
export const SLIDES_API_BASE = 'https://slides.googleapis.com/v1'
export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4'
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
export const FORMS_API_BASE = 'https://forms.googleapis.com/v1'
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
export const TOKEN_BUFFER_SECONDS = 300

// The Drive-item backends (gdocs, gsheets, gslides) present the same
// synthetic owned/shared tree; the per-backend route tables differ only in
// the leaf suffix.
export const TOP_LEVEL_DIRS = ['owned', 'shared'] as const

/** Whether the segment names a Drive corpus directory. */
export function isCorpus(text: string): boolean {
  return (TOP_LEVEL_DIRS as readonly string[]).includes(text)
}

export const CORPUS = new Codec({ validate: isCorpus })
