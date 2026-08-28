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

// Split text into lines, dropping the terminator's trailing empty entry.
// Mirrors Python's mirage.commands.builtin.utils.lines.split_lines.
export function splitLines(text: string): string[] {
  if (text === '') return []
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped.split('\n')
}
