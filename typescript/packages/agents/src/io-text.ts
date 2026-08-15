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

import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace'

export function decode(value: Uint8Array | null | undefined): string {
  if (value === null || value === undefined) return ''
  return new TextDecoder('utf-8').decode(value)
}

export function ioToStr(io: ExecuteResult): string {
  const stdout = io.stdoutText
  const stderr = io.stderrText
  if (stderr) return stdout ? `${stdout}\n${stderr}` : stderr
  return stdout
}
