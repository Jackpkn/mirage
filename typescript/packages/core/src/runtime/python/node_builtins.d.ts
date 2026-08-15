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

// The three Node builtins core reaches for, declared with only the members
// it uses, rather than depending on `@types/node`.
//
// Core has to work in both runtimes, and pulling the whole Node surface in
// would let any module here use `node:fs` and still typecheck — the rule
// would survive only in review. Whatever is used has to be written down
// here first, which is a small price for a compiler-enforced boundary.
//
// Every call site is guarded twice over: a `process.versions.node` probe
// before the import, and a try/catch that degrades around it. Nothing here
// runs in a browser; these types only have to describe the Node path well
// enough to check it. `packages/node` depends on `@types/node` proper and
// is where unrestricted Node code belongs.

declare module 'node:module' {
  export function createRequire(url: string): {
    resolve(id: string): string
  }
}

declare module 'node:path' {
  export function dirname(p: string): string
}

declare module 'node:worker_threads' {
  export class Worker {
    constructor(source: string, options?: { eval?: boolean })
    postMessage(value: unknown): void
    terminate(): Promise<number>
    unref(): void
  }
}
