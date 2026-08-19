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

import type { Accessor } from '../../accessor/base.ts'
import type { ScopeMatch } from './scope.ts'

/**
 * One qualified grep/rg push-down request: the resolved pattern list as the
 * line typed it, plus the flags a searcher may honor itself (-i, -F, -w).
 */
export interface SearchQuery {
  readonly pattern: string
  readonly ignoreCase: boolean
  readonly fixedString: boolean
  readonly wholeWord: boolean
}

export type Searcher<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  query: SearchQuery,
) => Promise<string[]>
