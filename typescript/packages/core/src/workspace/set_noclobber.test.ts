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
import { makeWorkspace, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'

// Every case pinned against GNU bash 5.2.37 on debian:stable-slim.
const CASES: [string, string, string][] = [
  // `>` onto an existing target is refused and the target is intact.
  [
    'echo a > /ram/f; set -C; echo b > /ram/f; echo rc=$?; cat /ram/f',
    'rc=1\na\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // Existence is the test, not size: an empty file still refuses.
  [
    ': > /ram/f; set -C; echo b > /ram/f; echo rc=$?',
    'rc=1\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // `>|` overrides for one redirect, and does not clear the option.
  ['echo a > /ram/f; set -C; echo b >| /ram/f; echo rc=$?; cat /ram/f', 'rc=0\nb\n', ''],
  [
    'echo a > /ram/f; set -C; echo b >| /ram/f; echo c > /ram/f; echo rc=$?',
    'rc=1\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // A new target and `>>` are both allowed.
  ['set -C; echo b > /ram/new; echo rc=$?; cat /ram/new', 'rc=0\nb\n', ''],
  ['echo a > /ram/f; set -C; echo b >> /ram/f; echo rc=$?; cat /ram/f', 'rc=0\na\nb\n', ''],
  // `2>` and `&>` are refused the same way.
  [
    'echo a > /ram/f; set -C; ls /nope 2> /ram/f; echo rc=$?; cat /ram/f',
    'rc=1\na\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  [
    'echo a > /ram/f; set -C; echo b &> /ram/f; echo rc=$?; cat /ram/f',
    'rc=1\na\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  // bash stops at the first refused open: one message, neither written.
  [
    'echo a > /ram/x; echo a > /ram/y; set -C; echo b > /ram/x > /ram/y; echo rc=$?; cat /ram/x /ram/y',
    'rc=1\na\na\n',
    '/ram/x: cannot overwrite existing file\n',
  ],
  // A directory under the option answers in GNU's wording for that case.
  ['mkdir -p /ram/d; set -C; echo b > /ram/d; echo rc=$?', 'rc=1\n', '/ram/d: Is a directory\n'],
  // The letter and the long name are the same option, and `+C` clears it.
  [
    'echo a > /ram/f; set -o noclobber; echo b > /ram/f; echo rc=$?',
    'rc=1\n',
    '/ram/f: cannot overwrite existing file\n',
  ],
  ['echo a > /ram/f; set -C; set +C; echo b > /ram/f; echo rc=$?; cat /ram/f', 'rc=0\nb\n', ''],
  // Off by default: the ordinary overwrite is untouched.
  ['echo a > /ram/f; echo b > /ram/f; echo rc=$?; cat /ram/f', 'rc=0\nb\n', ''],
]

describe('set -C noclobber', () => {
  it.each(CASES)('%s', async (cmd, out, err) => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(cmd)
    expect(stdoutStr(io)).toBe(out)
    expect(stderrStr(io)).toBe(err)
    await ws.close()
  })

  it('shows in the option listing', async () => {
    const { ws } = await makeWorkspace()
    // The session is reused across calls, so the default is asserted
    // before anything sets the option.
    expect(stdoutStr(await ws.execute('set -o'))).toContain('noclobber      \toff\n')
    expect(stdoutStr(await ws.execute('set -C; set -o'))).toContain('noclobber      \ton\n')
    expect(stdoutStr(await ws.execute('set +o'))).toContain('set -o noclobber\n')
    await ws.close()
  })
})
