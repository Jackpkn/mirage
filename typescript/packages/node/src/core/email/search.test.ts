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

import { NAME_MAX_BYTES, byteLength } from '@struktoai/mirage-core/utils/sanitize'
import { describe, expect, it } from 'vitest'
import { msgFilename } from './readdir.ts'
import { buildVfsPath } from './search.ts'

const CJK_SUBJECT = '会議の記録'.repeat(40)
const MSG = { subject: CJK_SUBJECT, uid: '7', date: 'Mon, 5 Jan 2026 10:00:00 +0000' }

describe('email search paths', () => {
  it('names the file readdir created', () => {
    // Composed here from a bare `sanitize`, a hit pointed at a path that does
    // not exist as soon as the subject was long enough to be trimmed: readdir
    // budgets the subject against the uid and the suffix, and this did not,
    // so the two names differed.
    const path = buildVfsPath('/mail', 'INBOX', MSG as never)
    expect(path.endsWith(`/${msgFilename(CJK_SUBJECT, '7')}`)).toBe(true)
  })

  it('fits NAME_MAX', () => {
    const name =
      buildVfsPath('/mail', 'INBOX', MSG as never)
        .split('/')
        .pop() ?? ''
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).not.toContain('\uFFFD')
  })
})
