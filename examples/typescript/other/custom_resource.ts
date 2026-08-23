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

import {
  Accessor,
  type CommandIO,
  CommandSpec,
  command,
  FileStat,
  FileType,
  GenericResource,
  IOResult,
  MountMode,
  type PathSpec,
  registerResourceFactory,
  streamFromBytes,
  Workspace,
} from '@struktoai/mirage-node'

// A whole custom backend in one script: three core functions over your
// data source, one CommandIO table, one GenericResource. Every generic
// command (ls, cat, grep, find, head, wc, ...) works for free.

const ENC = new TextEncoder()

type Tree = { [name: string]: Tree | string }

const PAGES: Tree = {
  guides: {
    'quickstart.md': '# Quickstart\nMount anything as a filesystem.\n',
    'deploy.md': '# Deploy\nShip the gateway behind HTTP.\n',
  },
  'notes.md': 'Remember: agents just speak bash.\n',
}

class WikiAccessor extends Accessor {
  constructor(readonly pages: Tree) {
    super()
  }
}

function node(pages: Tree, key: string): Tree | string {
  let current: Tree | string = pages
  for (const part of key.split('/').filter((p) => p !== '')) {
    if (typeof current === 'string') throw new Error(`ENOENT: ${key}`)
    const child: Tree | string | undefined = current[part]
    if (child === undefined) throw new Error(`ENOENT: ${key}`)
    current = child
  }
  return current
}

function readdir(accessor: WikiAccessor, path: PathSpec): Promise<string[]> {
  const found = node(accessor.pages, path.resourcePath)
  if (typeof found === 'string') throw new Error(`ENOTDIR: ${path.virtual}`)
  const parent = path.virtual.replace(/\/+$/, '')
  return Promise.resolve(
    Object.entries(found).map(
      ([name, child]) => `${parent}/${name}${typeof child === 'string' ? '' : '/'}`,
    ),
  )
}

function readBytes(accessor: WikiAccessor, path: PathSpec): Promise<Uint8Array> {
  const found = node(accessor.pages, path.resourcePath)
  if (typeof found !== 'string') throw new Error(`EISDIR: ${path.virtual}`)
  return Promise.resolve(ENC.encode(found))
}

function stat(accessor: WikiAccessor, path: PathSpec): Promise<FileStat> {
  const found = node(accessor.pages, path.resourcePath)
  const trimmed = path.virtual.replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
  if (typeof found !== 'string')
    return Promise.resolve(new FileStat({ name, size: null, type: FileType.DIRECTORY }))
  return Promise.resolve(new FileStat({ name, size: ENC.encode(found).length, type: FileType.TEXT }))
}

// Optional: a bespoke domain verb, registered alongside the generics.
const wikiTitles = command({
  name: 'wiki_titles',
  resource: 'wiki',
  spec: new CommandSpec(),
  fn: (accessor) => {
    const pages = (accessor as WikiAccessor).pages
    const titles = ['guides/quickstart.md', 'guides/deploy.md'].flatMap((page) =>
      String(node(pages, page))
        .split('\n')
        .filter((line) => line.startsWith('# '))
        .map((line) => line.slice(2)),
    )
    return [ENC.encode(`${titles.join('\n')}\n`), new IOResult()]
  },
})

function makeIO(): CommandIO<WikiAccessor> {
  return {
    readdir,
    readBytes,
    readStream: (a, p, i) => streamFromBytes(readBytes, a, p, i),
    stat,
    isMounted: () => true,
    local: false,
  }
}

class WikiResource extends GenericResource<WikiAccessor> {
  constructor(pages: Tree = PAGES) {
    super({
      name: 'wiki',
      accessor: new WikiAccessor(pages),
      io: makeIO(),
      prompt: 'A team wiki rendered as markdown files.',
      commands: wikiTitles,
    })
  }
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/wiki/': new WikiResource() }, { mode: MountMode.READ })

  for (const line of [
    'ls /wiki/guides',
    'cat /wiki/notes.md',
    'grep -r Quickstart /wiki/',
    "find /wiki -name '*.md'",
    'wc -l /wiki/guides/quickstart.md',
    'wiki_titles',
  ]) {
    const io = await ws.execute(line)
    console.log(`$ ${line}\n${io.stdoutText}`)
  }

  // Registered names work everywhere builtin names do (YAML, snapshots):
  registerResourceFactory('wiki', () => Promise.resolve(new WikiResource()))
  console.log("registered 'wiki' for registry-name construction")

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
