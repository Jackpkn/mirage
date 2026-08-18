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

import type { RegisteredCommand } from '../../../../commands/config.ts'
import type { MountEntry } from '../../../mount/mount.ts'

// One place a command name resolves to, for the manual renderer: the
// mount that registers it, the registration, and whether it is the
// general (every-mount) set.
export interface ManHit {
  mount: MountEntry
  cmd: RegisteredCommand
  isGeneral: boolean
}
