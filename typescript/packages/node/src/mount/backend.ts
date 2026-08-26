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
import { KERNEL_BACKENDS, MountBackend } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { sizesAlwaysKnown } from '@struktoai/mirage-core/resource/base'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'

/**
 * Coerce a user-supplied backend name into a MountBackend.
 *
 * Missing means vfs, everywhere: an absent `backend` in YAML, `undefined`
 * here, and the `MountSpecOptions` default all resolve to the same thing.
 * Callers that need a kernel mount say so explicitly rather than relying on
 * this function to reinterpret an absent value.
 */
export function resolveBackend(value?: string | null): MountBackend {
  if (value === undefined || value === null || value === '') return MountBackend.VFS
  const lowered = value.toLowerCase() as MountBackend
  if (!Object.values(MountBackend).includes(lowered)) {
    throw new Error(
      `unknown mount backend ${JSON.stringify(value)}; expected one of: ${Object.values(
        MountBackend,
      ).join(', ')}`,
    )
  }
  return lowered
}

/** Reject a backend that registers nothing with the kernel. */
export function requireKernelBackend(backend: MountBackend): void {
  if (!KERNEL_BACKENDS.includes(backend)) {
    throw new Error(
      `backend ${JSON.stringify(backend)} does not register a mountpoint; it is served inside ` +
        "mirage's own filesystem, so there is nothing to mount",
    )
  }
}

/**
 * Mounts under `rootPrefix` whose files cannot be sized without reading
 * them. Mirrors Python's `Ops.unsized_mounts`.
 */
export function unsizedMounts(ws: Workspace, rootPrefix = ''): [string, string][] {
  const root = rstripSlash(rootPrefix)
  const found: [string, string][] = []
  for (const m of ws.mounts()) {
    const bare = rstripSlash(m.prefix)
    if (root !== '' && bare !== root && !m.prefix.startsWith(root + '/')) continue
    if (!sizesAlwaysKnown(m.resource)) found.push([m.prefix, m.resource.kind])
  }
  return found
}
