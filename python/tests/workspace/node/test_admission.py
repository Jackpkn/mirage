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

import pytest

from mirage.resource.ram import RAMResource
from mirage.shell import parse
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.node.admission import admit, admit_line, policy_scopes
from mirage.workspace.session import WorkspacePermissions

DOC = WorkspacePermissions.model_validate({
    "commands": {
        "allow": ["cat", "rm", "ls", "ln", "echo", "head"],
        "deny": [{
            "reason": "sealed",
            "commands": ["cat"],
            "paths": ["/data/secret*"]
        }],
    }
})


def _ws() -> Workspace:
    return Workspace({"/data/": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE,
                     permissions=DOC)


def _virtuals(ws: Workspace, name: str, *args: str) -> list[str]:
    words = classify_parts([name, *args], ws._registry, "/")
    return [
        p.virtual
        for p in policy_scopes(name, list(args), words[1:], ws._namespace, "/")
    ]


@pytest.mark.asyncio
async def test_policy_scopes_follow_links_only_for_a_following_command():
    ws = _ws()
    try:
        await ws.execute("echo top > /data/secret && "
                         "ln -s /data/secret /data/link")
        # cat opens the target: the typed path first, then what it
        # resolves to; rm and `ls -l` act on the link itself.
        assert _virtuals(ws, "cat",
                         "/data/link") == ["/data/link", "/data/secret"]
        assert _virtuals(ws, "rm", "/data/link") == ["/data/link"]
        assert _virtuals(ws, "ls", "-l", "/data/link") == ["/data/link"]
        assert _virtuals(ws, "ls",
                         "/data/link") == ["/data/link", "/data/secret"]
        # A path that is not a link reads once; no namespace reads typed.
        assert _virtuals(ws, "cat", "/data/secret") == ["/data/secret"]
        words = classify_parts(["cat", "/data/link"], ws._registry, "/")
        assert [
            p.virtual
            for p in policy_scopes("cat", ["/data/link"], words[1:], None, "/")
        ] == ["/data/link"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_refuses_the_first_offending_command():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        assert await admit_line(parse("cat /data/a | head -n 1"), session,
                                registry, namespace) is None
        # An unlisted word anywhere in the line is 127 before any hook.
        refusal = await admit_line(parse("cat /data/a | sort"), session,
                                   registry, namespace)
        assert refusal is not None
        assert (refusal.exit_code,
                refusal.stderr) == (127, b"sort: command not found\n")
        # A rule reads the literal words, path-shaped ones as paths.
        refusal = await admit_line(parse("ls /data && cat /data/secret"),
                                   session, registry, namespace)
        assert refusal is not None
        assert (refusal.exit_code,
                refusal.stderr) == (1, b"cat: /data/secret: sealed\n")
        # The same gate, one command at a time.
        assert await admit("rm", ["/data/x"], [], session, registry,
                           namespace) is None
    finally:
        await ws.close()
