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

// The attribute is required: unbundled, this stays a real import at
// runtime and Node refuses a JSON module without it. The bundler used to
// inline the file, which is why it could be omitted before -- and why the
// package now declares `engines.node: ">=20.10.0"`. That is the release
// that learned to parse `with`, and every import of Workspace reaches
// this module, so an older Node fails at load rather than losing a
// version string. Reading the shipped metadata is deliberate and mirrored:
// `mirage/version.py` takes the same route through importlib.metadata.
//
// `../package.json` resolves from both trees on purpose — `src/version.ts`
// and `dist/version.js` are each one level below the package root, and
// `files: ["dist"]` ships package.json at that root for consumers too.
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version
