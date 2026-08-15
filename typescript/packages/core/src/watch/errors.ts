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

export class QueueOverflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueOverflowError'
  }
}

// A snapshot diff reads every path the walk did not report as a
// DELETE, so a partial listing does not degrade into fewer events, it
// invents wrong ones. A hook that knows its listing was truncated
// raises this instead, leaving the caller's checkpoint untouched so the
// next pull can still succeed.
export class IncompleteWalkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IncompleteWalkError'
  }
}

export class QueueClosed extends Error {
  constructor(label: string) {
    super(label)
    this.name = 'QueueClosed'
  }
}
