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
import { FsError } from '@deepseek-ai/dsh-fs'
import { assertNotAborted, mapMirageError } from './errors.ts'

function stamped(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code })
}

describe('assertNotAborted', () => {
  it('throws FS_ABORTED for a fired signal and passes otherwise', () => {
    const controller = new AbortController()
    expect(() => {
      assertNotAborted(controller.signal, 'read')
    }).not.toThrow()
    expect(() => {
      assertNotAborted(undefined, 'read')
    }).not.toThrow()
    controller.abort()
    try {
      assertNotAborted(controller.signal, 'read')
      throw new Error('expected rejection')
    } catch (err) {
      expect((err as FsError).code).toBe('FS_ABORTED')
    }
  })
})

describe('mapMirageError', () => {
  it('recognizes both abort shapes', () => {
    const asDom = new DOMException('stopped', 'AbortError')
    expect(mapMirageError(asDom, 'read', '/a').code).toBe('FS_ABORTED')
    const asError = Object.assign(new Error('stopped'), { name: 'AbortError' })
    expect(mapMirageError(asError, 'read', '/a').code).toBe('FS_ABORTED')
  })

  it('maps POSIX stamps to the dsh taxonomy', () => {
    expect(mapMirageError(stamped('EISDIR'), 'read', '/a').code).toBe('FS_NOT_REGULAR_FILE')
    expect(mapMirageError(stamped('ENOTDIR'), 'read', '/a').code).toBe('FS_NOT_DIRECTORY')
    expect(mapMirageError(stamped('EACCES'), 'write', '/a').code).toBe('FS_PERMISSION_DENIED')
    expect(mapMirageError(stamped('EPERM'), 'write', '/a').code).toBe('FS_PERMISSION_DENIED')
    expect(mapMirageError(stamped('ENOENT'), 'read', '/a').code).toBe('FS_NOT_FOUND')
    expect(mapMirageError(stamped('EXDEV'), 'write', '/a').code).toBe('FS_IO_ERROR')
  })

  it('passes an FsError through untouched', () => {
    const original = new FsError('already typed', 'FS_NOT_TEXT')
    expect(mapMirageError(original, 'read', '/a')).toBe(original)
  })

  it('names the operation and path, and keeps the cause', () => {
    const cause = stamped('EIO', 'disk died')
    const mapped = mapMirageError(cause, 'read', '/data/a.txt')
    expect(mapped.message).toBe('cannot read "/data/a.txt": disk died')
    expect(mapped.cause).toBe(cause)
  })
})
