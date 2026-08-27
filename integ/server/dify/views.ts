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

import type { JsonValue } from '../kit/typescript/index.ts'

export interface DocumentRow {
  id: string
  name: string
  slug: string | null
  size: number
  createdAt: number
  seq: number
}

export interface HitRow {
  documentId: string
  content: string
  score: number
  seq: number
}

// The vendor states a document's metadata as a list of name/value pairs, so a
// document with no slug carries an empty list rather than a null entry.
function metadataOf(doc: DocumentRow): JsonValue {
  return doc.slug === null ? [] : [{ name: 'slug', value: doc.slug }]
}

export function documentSummary(doc: DocumentRow): JsonValue {
  return {
    id: doc.id,
    name: doc.name,
    doc_metadata: metadataOf(doc),
    enabled: true,
    indexing_status: 'completed',
    archived: false,
    tokens: 8,
    data_source_type: 'upload_file',
    data_source_detail_dict: { upload_file: { size: doc.size } },
    created_at: doc.createdAt,
  }
}

export function documentDetail(doc: DocumentRow): JsonValue {
  return { ...(documentSummary(doc) as Record<string, JsonValue>), updated_at: doc.createdAt }
}

// The segment id is the document id and the score to two places, which is what
// the python fake built and what a golden already renders.
export function recordJson(hit: HitRow, doc: DocumentRow): JsonValue {
  return {
    segment: {
      id: `${hit.documentId}:${hit.score.toFixed(2)}`,
      document_id: hit.documentId,
      content: hit.content,
      document: {
        id: doc.id,
        data_source_type: 'upload_file',
        name: doc.name,
        doc_type: null,
        doc_metadata: metadataOf(doc),
      },
    },
    child_chunks: [],
    score: hit.score,
    tsne_position: null,
    files: [],
    summary: null,
  }
}
