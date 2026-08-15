# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from typing import Any

from mirage.accessor.s3 import S3Accessor
from mirage.cache.context import invalidate_after_unlink
from mirage.core.s3._client import _client_kwargs, _key, _prefix, async_session
from mirage.core.s3.exists import exists
from mirage.core.s3.stat import _is_not_found
from mirage.types import PathSpec
from mirage.utils.errors import enoent

DELETE_BATCH = 1000


async def _is_object(client: Any, bucket: str, key: str) -> bool:
    """Whether one key names an object, as opposed to a directory prefix.

    The source is classified before anything is copied rather than by
    letting ``copy_object`` fail: stores disagree about a missing source
    (S3 and MinIO even spell the code differently, and a lenient
    S3-compatible store accepts the copy and writes nothing), and on that
    last one an error-driven fallback would delete a source whose copy
    never landed. Only a classified not-found answers False; every other
    failure propagates rather than reading as a directory.

    Args:
        client (Any): open S3 client.
        bucket (str): bucket name.
        key (str): object key.

    Returns:
        bool: whether the key exists as an object.
    """
    try:
        await client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        if not _is_not_found(exc):
            raise
        return False
    return True


async def _move_prefix(client: Any, accessor: S3Accessor, src: str,
                       dst: str) -> bool:
    """Relocate every key under ``src`` to the matching key under ``dst``.

    A directory is a key prefix plus the empty marker object mkdir writes,
    and listing on the prefix returns both, so one walk moves the marker
    and the whole subtree together.

    Args:
        client (Any): open S3 client.
        accessor (S3Accessor): S3 accessor.
        src (str): source mount path.
        dst (str): destination mount path.

    Returns:
        bool: whether any key was found under the source prefix.
    """
    config = accessor.config
    src_pfx = _prefix(src, config)
    dst_pfx = _prefix(dst, config)
    paginator = client.get_paginator("list_objects_v2")
    moved: list[dict[str, str]] = []
    async for page in paginator.paginate(Bucket=config.bucket, Prefix=src_pfx):
        for obj in page.get("Contents") or []:
            key = obj["Key"]
            await client.copy_object(
                Bucket=config.bucket,
                CopySource={
                    "Bucket": config.bucket,
                    "Key": key
                },
                Key=f"{dst_pfx}{key[len(src_pfx):]}",
            )
            moved.append({"Key": key})
    if not moved:
        return False
    # Deleted only after every copy landed: a partial move that dropped the
    # source would lose the entries that had not been copied yet.
    failed: list[str] = []
    for start in range(0, len(moved), DELETE_BATCH):
        resp = await client.delete_objects(
            Bucket=config.bucket,
            Delete={"Objects": moved[start:start + DELETE_BATCH]},
        )
        # DeleteObjects reports a refused key in the body of a 200, so a
        # response that raises nothing can still have deleted nothing.
        # Ignoring it would leave the source tree in place beside the copy
        # and call the move a success.
        for err in (resp or {}).get("Errors") or []:
            failed.append(str(err.get("Key", "")))
    if failed:
        # Both trees survive, which is what GNU mv leaves behind when the
        # unlink half fails after the copy half succeeded. PermissionError
        # because a refused delete is a lock or a policy in practice, and
        # because it is in FS_ERRORS: mv reports the operand and keeps
        # going instead of aborting the whole command line.
        raise PermissionError(
            f"S3 refused to delete {len(failed)} source object(s) after "
            f"copying, starting at {failed[0]!r}")
    return True


async def rename(accessor: S3Accessor, src_spec: PathSpec,
                 dst_spec: PathSpec) -> None:
    """Relocate a file or a whole directory prefix.

    A single object moves with one server-side copy. A directory owns no
    object of its own, so it moves as a prefix walk; a source that is
    neither is ENOENT rather than the raw botocore text.

    Args:
        accessor (S3Accessor): S3 accessor.
        src_spec (PathSpec): source path.
        dst_spec (PathSpec): destination path.
    """
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    config = accessor.config
    src_key = _key(src, config)
    if src_key == _key(dst, config):
        # POSIX rename(2): the same existing file succeeds and performs no
        # other action. Reaching the copy+delete pair below would instead
        # delete the object on any store that accepts the self-copy, and
        # error on the ones that reject it (#150).
        if not await exists(accessor, src_spec):
            raise enoent(src_spec)
        return
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        if await _is_object(client, config.bucket, src_key):
            await client.copy_object(
                Bucket=config.bucket,
                CopySource={
                    "Bucket": config.bucket,
                    "Key": src_key
                },
                Key=_key(dst, config),
            )
            await client.delete_object(Bucket=config.bucket, Key=src_key)
        elif not await _move_prefix(client, accessor, src, dst):
            raise enoent(src_spec.virtual)
    await invalidate_after_unlink(dst_spec)
    await invalidate_after_unlink(src_spec)
