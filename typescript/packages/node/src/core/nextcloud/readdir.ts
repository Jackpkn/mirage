import {
  enotdir,
  enoent,
  IndexEntry,
  mountPrefixOf,
  ResourceType,
  rstripSlash,
  stripSlash,
  type IndexCacheStore,
  type PathSpec,
  compareCodePoints,
  readdirError,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { SCOPE_ERROR } from './constants.ts'
import { isNotFound } from './util.ts'

async function isFile(accessor: NextcloudAccessor, key: string): Promise<boolean> {
  const op = await accessor.operator()
  try {
    return !(await op.stat(stripSlash(key))).isDirectory()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function isDir(accessor: NextcloudAccessor, key: string): Promise<boolean> {
  const op = await accessor.operator()
  try {
    return (await op.stat(`${stripSlash(key)}/`)).isDirectory()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

// The errno for a path PROPFIND reported nothing at all for. Mirrors
// Python's mirage/core/nextcloud/readdir.py `listingError`.
async function listingError(
  accessor: NextcloudAccessor,
  path: PathSpec,
  target: string,
): Promise<Error> {
  const file = (p: string): Promise<boolean> => isFile(accessor, p)
  if (await file(target)) return enotdir(path)
  return readdirError(path, target, file, (p) => isDir(accessor, p))
}

export async function readdir(
  accessor: NextcloudAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let target = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && target.startsWith(prefix)) {
    const rest = target.slice(prefix.length)
    if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) target = rest || '/'
  }
  const virtualKey = rstripSlash(prefix !== '' ? `${prefix}${target}` : target) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const stripped = stripSlash(target)
  const listPath = stripped !== '' ? `${stripped}/` : '/'
  const op = await accessor.operator()
  let entries
  try {
    entries = await op.list(listPath)
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  if (entries.length === 0 && stripped !== '') {
    // PROPFIND on a collection lists the collection itself, so an empty
    // directory still yields one entry and only a path the server does not
    // have yields none. The lister reports that as an empty result rather
    // than raising, so without this `ls /nextcloud/never` rendered an empty
    // directory and exited 0. The mount root is exempt: it exists because
    // it is mounted.
    throw await listingError(accessor, path, target)
  }
  const names: string[] = []
  const directories = new Set<string>()
  const metadata = new Map<string, { size: number | null; modified: string }>()
  for (const entry of entries) {
    const relative = entry.path()
    if (relative === '' || relative === listPath) continue
    const info = entry.metadata()
    const isDirectory = relative.endsWith('/') || info.isDirectory()
    const key = `/${rstripSlash(relative)}`
    names.push(key)
    if (isDirectory) directories.add(key)
    metadata.set(key, {
      size: info.contentLength !== null ? Number(info.contentLength) : null,
      modified: info.lastModified ?? '',
    })
  }
  // PROPFIND normally carries getcontentlength for every file; when the
  // lister omits the metadata, one stat per affected file fills the gap so
  // the index never caches an unknown size.
  for (const [key, info] of metadata) {
    if (directories.has(key) || info.size !== null) continue
    const md = await op.stat(stripSlash(key))
    info.size = md.contentLength !== null ? Number(md.contentLength) : null
    if (info.modified === '' && md.lastModified !== null) info.modified = md.lastModified
  }
  const targetKey = `/${stripSlash(target)}`
  if (names.length === 1 && names[0] === targetKey && !directories.has(targetKey)) {
    throw enotdir(path)
  }
  names.sort(compareCodePoints)
  if (names.length > SCOPE_ERROR) {
    console.warn(
      `nextcloud readdir: ${virtualKey} returned ${String(names.length)} entries (limit ${String(SCOPE_ERROR)})`,
    )
  }
  if (index !== undefined) {
    await index.setDir(
      virtualKey,
      names.map((key) => {
        const name = key.split('/').pop() ?? key
        const info = metadata.get(key)
        return [
          name,
          new IndexEntry({
            id: key,
            name,
            resourceType: directories.has(key) ? ResourceType.FOLDER : ResourceType.FILE,
            size: directories.has(key) ? null : (info?.size ?? null),
            remoteTime: info?.modified ?? '',
          }),
        ]
      }),
    )
  }
  return names.map((key) => (prefix !== '' ? `${prefix}${key}` : key)).sort(compareCodePoints)
}
