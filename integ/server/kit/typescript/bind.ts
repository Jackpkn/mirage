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

// Loopback is right on a developer's machine and wrong inside a container: a
// server on the container's own 127.0.0.1 is invisible to the published port,
// so a client on the host has its connection accepted and then closed with no
// response, while a healthcheck running inside the container sees a healthy
// server. Set MIRAGE_BIND_HOST=0.0.0.0 wherever the client is outside the
// container.
export const DEFAULT_BIND_HOST = '127.0.0.1'
export const DEFAULT_ADVERTISE_HOST = '127.0.0.1'
const WILDCARDS = new Set(['0.0.0.0', '::', '[::]'])

export function bindHost(): string {
  const v = process.env.MIRAGE_BIND_HOST
  return v === undefined || v === '' ? DEFAULT_BIND_HOST : v
}

// Where to LISTEN and what to ADVERTISE are two different facts, so they are
// two knobs. The announced URL and discord's attachment CDN links are read by
// a client that has to connect, so a wildcard bind cannot be echoed into them:
// 0.0.0.0 is an interface to listen on, not an address anything can dial. A
// bind host that IS dialable is the right thing to advertise, though, so it is
// used as-is, and MIRAGE_ADVERTISE_HOST overrides both for the case the bind
// address cannot express -- a container reached by its service name or a
// published port on another machine.
export function advertiseHost(): string {
  const explicit = process.env.MIRAGE_ADVERTISE_HOST
  if (explicit !== undefined && explicit !== '') return explicit
  const bound = bindHost()
  return WILDCARDS.has(bound) ? DEFAULT_ADVERTISE_HOST : bound
}

// A host goes into a URL through here, never by bare interpolation. An IPv6
// literal has to be bracketed inside an authority or the colons run into the
// port: `http://::1:8080` is not a URL and `new URL()` rejects it, so an
// announce line the runners parse, and discord's attachment links, both became
// unusable the moment anyone bound to ::1. `::` needs no case of its own (it
// is a wildcard and never advertised), but `::1` is an ordinary loopback bind
// and does. node's listen() wants the BARE form, so this is for URLs only.
export function authorityHost(host: string): string {
  if (host.startsWith('[')) return host
  return host.includes(':') ? `[${host}]` : host
}
