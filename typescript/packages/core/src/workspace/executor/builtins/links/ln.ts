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

import { PathSpec, wordText } from '../../../../types.ts'
import { CycleError, gnuDirname } from '../../../../utils/path.ts'
import { PolicyDenied } from '../../../../policy/index.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { Session } from '../../../session/session.ts'
import { absPath, fail, ok, splitFlags, type Result } from '../shared.ts'
import { posixRelative } from './links.ts'

// ln -s TARGET LINK: create a namespace symbolic link. Flags: -f overwrite
// an existing link, -v report the link, -r store the target relative to the
// link's directory (GNU --relative). -n (--no-dereference) and -T
// (--no-target-directory) are accepted no-ops: a namespace link name is
// never dereferenced nor treated as a directory to descend into.
export async function handleLn(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: Session,
  args: (string | PathSpec)[],
): Promise<Result> {
  const [flags, operands] = splitFlags(args, 'sfnvrT')
  const targetArg = operands[0]
  const linkArg = operands[1]
  if (targetArg === undefined || linkArg === undefined) {
    return fail('ln', 'ln: missing file operand\n')
  }
  // GNU: with more than two operands the last must be a directory;
  // namespace links never name directories, so this is always an error
  // (an expanded multi-match glob source lands here).
  if (operands.length > 2) {
    const last = operands[operands.length - 1]
    return fail('ln', `ln: target '${wordText(last ?? '')}': Not a directory\n`)
  }
  const linkAbs = absPath(linkArg, session.cwd)
  let targetTyped = wordText(targetArg)
  if (flags.has('r')) {
    // --relative: rewrite the target relative to the link's own directory
    // so the link stays valid addressed from anywhere. GNU canonicalizes
    // existing symlink components of both ends first, so an aliased
    // directory resolves to its real path (the link survives the alias
    // being moved/removed); fall back to lexical on a loop.
    let linkDir = gnuDirname(linkAbs)
    let targetAbs = absPath(targetArg, session.cwd)
    try {
      targetAbs = namespace.follow(targetAbs)
      linkDir = namespace.follow(linkDir)
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
    }
    targetTyped = posixRelative(targetAbs, linkDir)
  }
  const exists = namespace.isLink(linkAbs) && !flags.has('f')
  if (namespace.isMountRoot(linkAbs) || exists) {
    return fail('ln', `ln: failed to create symbolic link '${wordText(linkArg)}': File exists\n`)
  }
  // The write itself is a dispatch op, so session grants and admission
  // policies fire at the door; a refusal renders in ln's own words.
  try {
    await dispatch('symlink', PathSpec.fromStrPath(linkAbs), [], { target: targetTyped })
  } catch (err) {
    if (err instanceof PolicyDenied) {
      return fail(
        'ln',
        `ln: failed to create symbolic link '${wordText(linkArg)}': Permission denied\n`,
      )
    }
    throw err
  }
  let out: Uint8Array | null = null
  if (flags.has('v')) {
    out = new TextEncoder().encode(`'${wordText(linkArg)}' -> '${targetTyped}'\n`)
  }
  return ok('ln', out)
}
