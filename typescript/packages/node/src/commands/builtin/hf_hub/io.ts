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

import { rangeOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { CommandIO } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { HfHubAccessor } from '../../../accessor/hf_hub.ts'
import { SCOPE_ERROR } from '../../../core/hf_hub/constants.ts'
import { create as hubCreate } from '../../../core/hf_hub/create.ts'
import { exists as hubExists } from '../../../core/hf_hub/exists.ts'
import { mkdir as hubMkdir } from '../../../core/hf_hub/mkdir.ts'
import { read as hubRead } from '../../../core/hf_hub/read.ts'
import { readdir as hubReaddir } from '../../../core/hf_hub/readdir.ts'
import { rmR as hubRmR } from '../../../core/hf_hub/rm.ts'
import { stat as hubStat } from '../../../core/hf_hub/stat.ts'
import { stream as hubStream } from '../../../core/hf_hub/stream.ts'
import { unlink as hubUnlink } from '../../../core/hf_hub/unlink.ts'
import { write as hubWrite } from '../../../core/hf_hub/write.ts'

// No native find or du op, and that is not an omission. Those exist to spare
// an API tree one request per directory, and this mount has no such cost: the
// Hub's listing is recursive, so one paged fetch is the whole tree and every
// readdir under the generic walk is a map lookup against it. A native walk
// here would buy a constant factor and cost a second implementation of the
// same traversal.
//
// cp and mv are absent because the Hub has no server-side copy or rename;
// both would be read-then-commit, which the generic already spells.
export const HF_HUB_IO: CommandIO<HfHubAccessor> = {
  readdir: hubReaddir,
  readBytes: hubRead,
  readRange: rangeOf(hubRead),
  readStream: hubStream,
  stat: hubStat,
  isMounted: () => true,
  local: false,
  maxGlobMatches: SCOPE_ERROR,
  write: hubWrite,
  exists: hubExists,
  mkdir: (accessor, path) => hubMkdir(accessor, path),
  unlink: hubUnlink,
  rmR: hubRmR,
  create: hubCreate,
}
