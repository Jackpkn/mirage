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

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FixtureError } from './errors.ts'
import type { JsonValue } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const INTEG_ROOT = resolve(HERE, '..', '..', '..')
export const FIXTURE_ROOT = join(INTEG_ROOT, 'fixtures')
export const SCHEMA_ROOT = join(INTEG_ROOT, 'prisma')
export const DEFAULT_FIXTURE = 'v1'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// A fixture is named, never pathed. notion's /reset took a `fixture` field and
// readFileSync'd it verbatim, so the body of an HTTP request chose which file
// on the host the fake read. The name is matched against one pattern, joined
// under fixtures/<service>/, and the result is re-checked to be inside that
// directory, so neither `..` nor an absolute path can escape.
export function fixturePath(service: string, name: string = DEFAULT_FIXTURE): string {
  if (!NAME_RE.test(name) || name.includes('..')) {
    throw new FixtureError(`invalid fixture name: ${JSON.stringify(name)}`)
  }
  const dir = join(FIXTURE_ROOT, service)
  const path = resolve(dir, `${name}.json`)
  if (!path.startsWith(`${dir}/`)) {
    throw new FixtureError(`fixture escapes ${dir}: ${JSON.stringify(name)}`)
  }
  return path
}

export function loadFixture(service: string, name: string = DEFAULT_FIXTURE): JsonValue {
  const path = fixturePath(service, name)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new FixtureError(`no fixture ${service}/${name}.json`)
  }
  try {
    return JSON.parse(raw) as JsonValue
  } catch (err: unknown) {
    throw new FixtureError(`fixture ${service}/${name}.json is not JSON: ${String(err)}`)
  }
}

// One artifact per service: integ/prisma/<service>.prisma. No checked-in .sql
// and no relations.json; `prisma db push` is what creates the tables.
export function schemaFor(service: string): string {
  return join(SCHEMA_ROOT, `${service}.prisma`)
}
