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
        "allow": [
            "cat", "rm", "ls", "ln", "echo", "head", "grep", "rg", "cd",
            "xargs", "sh", "mkdir"
        ],
        "deny": [{
            "reason": "sealed",
            "commands": ["cat"],
            "paths": ["/data/secret*"]
        }, {
            "reason": "private",
            "commands": ["ls", "grep", "rg"],
            "paths": ["/data/private"]
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


@pytest.mark.asyncio
async def test_a_bare_listing_reads_the_working_directory():
    # `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the cwd,
    # an operand the executor injects after the gate; a rule on that
    # directory has to see it here, as the operand typed `.`.
    ws = _ws()
    try:
        await ws.execute("mkdir -p /data/private && echo x > /data/private/f")
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def run(name: str, *args: str, stdin: bytes | None = None):
            words = classify_parts([name, *args], registry, session.cwd)
            refusal = await admit(name,
                                  list(args),
                                  words[1:],
                                  session,
                                  registry,
                                  namespace,
                                  stdin=stdin)
            return None if refusal is None else (refusal.exit_code,
                                                 refusal.stderr.decode())

        assert await run("ls") is None
        await ws.execute("cd /data/private")
        assert await run("ls") == (1, "ls: .: private\n")
        # A named operand replaces the implied one.
        assert await run("ls", "/data") is None
        # grep reads the cwd only under -r; rg yields to a piped stdin.
        assert await run("grep", "x") is None
        assert await run("grep", "-r",
                         "x") == (1, "grep: /data/private: private\n")
        assert await run("rg", "x", stdin=b"x\n") is None
        assert await run("rg", "x") == (1, "rg: /data/private: private\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_reads_literal_words_and_refuses_the_unreadable():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def line(text: str):
            refusal = await admit_line(parse(text), session, registry,
                                       namespace)
            return None if refusal is None else (refusal.exit_code,
                                                 refusal.stderr.decode())

        # Quotes and escapes read as the text they name: a quoted path
        # is a path, a quoted head is the command.
        assert await line("'cat' \"/data/secret\"") == (
            1, "cat: /data/secret: sealed\n")
        assert await line("cat /data/sec\\ret") == (
            1, "cat: /data/secret: sealed\n")
        # A head only the runtime can expand is refused under any rule.
        assert await line("$cmd /data/x") == (
            126, "$cmd: policy denied: cannot read $cmd before the runtime "
            "expands it\n")
        assert await line('"$cmd" /data/x') == (
            126,
            '"$cmd": policy denied: cannot read "$cmd" before the runtime '
            "expands it\n")
        # An argument is refused only where a rule reads that command's
        # arguments: cat has a path rule, echo has none.
        assert await line('cat "$f"') == (
            126, 'cat: policy denied: cannot read "$f" before the runtime '
            "expands it\n")
        assert await line("cat /data/{a,secret}") == (
            126, "cat: policy denied: cannot read /data/{a,secret} before the "
            "runtime expands it\n")
        assert await line('echo "$HOME" $(ls /data)') is None
        # What a word runs is admitted in turn.
        assert await line("eval 'cat /data/secret'") == (
            1, "cat: /data/secret: sealed\n")
        assert await line('eval "$p"') == (
            126, '"$p": policy denied: cannot read "$p" before the runtime '
            "expands it\n")
        assert await line("echo $(cat /data/secret)") == (
            1, "cat: /data/secret: sealed\n")
        assert await line("ls | xargs cat") == (
            126, "cat: policy denied: runs on operands the gate cannot read\n")
        assert await line("ls | xargs echo") is None
        assert await line("source /data/env.sh") == (
            126, "source: policy denied: runs lines the gate cannot read\n")
        assert await line("/data/run.sh") == (
            126,
            "/data/run.sh: policy denied: runs lines the gate cannot read\n")
        assert await line("sh -c 'rm /data/x'; sh -c 'sort'") == (
            127, "sort: command not found\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_without_rules_admits_the_words_as_typed():
    # No command rule in force: nothing is refused for being unreadable,
    # which is what a coded policy always saw.
    ws = Workspace({"/data/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        for text in ("$cmd /data/x", 'eval "$p"', "source /data/env.sh",
                     "ls | xargs cat"):
            assert await admit_line(parse(text), session, ws._registry,
                                    ws._namespace) is None
    finally:
        await ws.close()
