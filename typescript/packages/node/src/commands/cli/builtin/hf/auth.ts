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

import type { CLIInvocation } from '@struktoai/mirage-core/commands/cli/types'
import type { CommandFnResult } from '@struktoai/mirage-core/commands/config'
import { whoami } from '../../../../core/hf_hub/account.ts'
import type { HfConfig } from '../../../../core/hf_hub/config.ts'
import { requireToken, textOut } from './accessor.ts'

/** Print the account the configured token belongs to. */
export async function whoamiCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  requireToken(inv, 'auth whoami')
  const account = await whoami(inv.config as HfConfig)
  const lines = [typeof account.name === 'string' ? account.name : '']
  const orgs = account.orgs
  for (const org of Array.isArray(orgs) ? orgs : []) {
    if (typeof org === 'object' && org !== null) {
      const name = (org as { name?: unknown }).name
      if (typeof name === 'string') lines.push(name)
    }
  }
  return textOut(`${lines.join('\n')}\n`)
}

/**
 * List the stored access tokens.
 *
 * A workspace has no token store: an install carries exactly one credential,
 * given to it by the embedding program. So this reports that one under
 * upstream's own two-column shape rather than pretending to a set it cannot
 * hold, and reports nothing when there is none.
 */
export async function listCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const config = inv.config as HfConfig
  const rows = ['NAME'.padEnd(20) + ' ' + 'TOKEN']
  if (config.token !== undefined && config.token !== '') {
    const account = await whoami(config)
    const name = typeof account.name === 'string' ? account.name : 'install'
    rows.push(name.padEnd(20) + ' ' + '*'.repeat(8))
  }
  return textOut(`${rows.join('\n')}\n`)
}
