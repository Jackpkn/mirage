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

import { z } from 'zod'

/**
 * One entry of the env map: a literal value or a managed pointer.
 *
 * The env block is one map, name -> entry. A bare string in the map is
 * the literal short form and never reaches this schema; a mapping is
 * validated through it. `value` and `from` are mutually exclusive and
 * one is required: `readonly`/`export` belong to a literal entry,
 * `ref`/`key`/`fetch` to a managed one. The wire key is `from:` in both
 * languages; Python exposes it as `provider` in code only because
 * `from` is a keyword there.
 */
export const EnvVarSchema = z
  .strictObject({
    value: z.string().optional(),
    readonly: z.boolean().default(false),
    export: z.boolean().default(true),
    from: z.string().optional(),
    ref: z.string().default(''),
    key: z.string().optional(),
    fetch: z.enum(['lazy', 'eager']).default('lazy'),
  })
  .superRefine((entry, ctx) => {
    if (entry.value !== undefined && entry.from !== undefined) {
      ctx.addIssue({ code: 'custom', message: "an env entry takes 'value' or 'from', not both" })
      return
    }
    if (entry.value === undefined && entry.from === undefined) {
      ctx.addIssue({ code: 'custom', message: "an env entry needs 'value' or 'from'" })
      return
    }
    if (entry.from !== undefined) {
      if (entry.readonly) {
        ctx.addIssue({
          code: 'custom',
          message:
            "'readonly' is for literal entries; a readonly managed variable " +
            'would change under refresh',
        })
      }
      if (!entry.export) {
        ctx.addIssue({
          code: 'custom',
          message: "'export' is for literal entries; a managed variable is always exported",
        })
      }
    } else if (entry.ref !== '' || entry.key !== undefined || entry.fetch !== 'lazy') {
      ctx.addIssue({
        code: 'custom',
        message: "'ref', 'key' and 'fetch' are for managed entries ('from')",
      })
    }
  })

export type EnvVar = z.infer<typeof EnvVarSchema>

/** The env block as an embedder or the config door writes it. */
export type EnvEntries = Record<string, string | z.input<typeof EnvVarSchema>>
