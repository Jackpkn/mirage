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

import { describe, expect, it } from 'vitest'

import { FileType } from '../types.ts'
import { guessType, mimeTypeFor } from './filetype.ts'

describe('guessType', () => {
  it('maps extensions to their own types (jpg is JPEG, not PNG)', () => {
    expect(guessType('photo.jpg')).toBe(FileType.IMAGE_JPEG)
    expect(guessType('photo.jpeg')).toBe(FileType.IMAGE_JPEG)
    expect(guessType('image.png')).toBe(FileType.IMAGE_PNG)
    expect(guessType('data.jsonl')).toBe(FileType.JSON)
    expect(guessType('unknown.blob')).toBe(FileType.BINARY)
  })
})

describe('mimeTypeFor', () => {
  it('uses the fixed table shared verbatim with python', () => {
    // himalaya attachments pin the serialized bytes, so the two
    // implementations must guess identically.
    expect(mimeTypeFor('report.PDF')).toBe('application/pdf')
    expect(mimeTypeFor('notes.txt')).toBe('text/plain')
    expect(mimeTypeFor('archive.weird')).toBe('application/octet-stream')
    expect(mimeTypeFor('no_extension')).toBe('application/octet-stream')
  })
})
