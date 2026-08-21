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

from collections.abc import Iterator
from typing import Any

from mirage.policy import (Ask, CommandContext, Deny, Explanation, Pending,
                           render_deny, render_pending)
from mirage.policy.match import Outcome, decide
from mirage.shell import parse
from mirage.shell.types import NodeType
from mirage.utils.path import resolve_path
from mirage.shell.helpers import (get_parts, get_text, literal_word,
                                  split_env_prefix)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.admission import (Refusal, admit, classified_words,
                                             gate)
from mirage.workspace.node.inner_lines import Word, inner_lines
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir

UNREADABLE = "cannot read {raw} before the runtime expands it"

SUBSHELL_NODES = frozenset({
    NodeType.SUBSHELL,
    NodeType.PIPELINE,
    NodeType.COMMAND_SUBSTITUTION,
    NodeType.PROCESS_SUBSTITUTION,
})


def _unreadable(raw: str) -> Explanation:
    """The explanation of a word only the runtime can expand.

    Args:
        raw (str): the word as typed.
    """
    reason = UNREADABLE.format(raw=raw)
    err, code = render_deny(raw, Deny(reason))
    return Explanation(command=raw,
                       outcome=Outcome.DENY,
                       reason=reason,
                       exit_code=code,
                       stderr=err.decode())


def _from_refusal(name: str, args: tuple[str, ...],
                  refusal: Refusal) -> Explanation:
    """The explanation of a head word the session cannot see.

    Args:
        name (str): the head word.
        args (tuple[str, ...]): the words after it.
        refusal (Refusal): what the gate answered.
    """
    return Explanation(command=name,
                       argv=args,
                       outcome=Outcome.DENY,
                       source="commands.allow",
                       exit_code=refusal.exit_code,
                       stderr=refusal.stderr.decode())


def _explained(ctx: CommandContext, session: Session, registry: MountRegistry,
               asked: Deny | Ask | None) -> Explanation:
    """One command's explanation, rendered from the same table the gate
    renders a refusal with.

    An Ask reads the session's standing grants and stops there
    (``Decisions.held``): a dry run must not spend one, record a
    question or reach the host. An answer that already covers the ask
    leaves the outcome ASK, because that is what the document says,
    with exit 0, because that is what the line would do.

    Args:
        ctx (CommandContext): the classified command.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the decision ledger.
        asked (Deny | Ask | None): what the policy chain answered.
    """
    decision = decide(ctx, session.commands)
    base = Explanation(command=ctx.command,
                       argv=ctx.argv,
                       outcome=decision.outcome,
                       rule=decision.rule,
                       reason=decision.rule.reason if decision.rule else "",
                       source=decision.source,
                       matched_path=decision.matched_path,
                       paths=tuple(p.virtual for p in ctx.paths))
    action: Deny | Pending | None = (registry.decisions.held(ctx, asked)
                                     if isinstance(asked, Ask) else asked)
    if action is None:
        return base
    err, code = (render_pending(ctx.command, action) if isinstance(
        action, Pending) else render_deny(ctx.command, action))
    reason = action.reason if base.reason == "" else base.reason
    return Explanation(command=base.command,
                       argv=base.argv,
                       outcome=base.outcome,
                       rule=base.rule,
                       reason=reason,
                       source=base.source,
                       matched_path=base.matched_path,
                       paths=base.paths,
                       exit_code=code,
                       stderr=err.decode())


async def explain_words(
    words: list[Word],
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
) -> list[Explanation]:
    """Explain one command and whatever lines it runs in turn.

    Args:
        words (list[Word]): the command's words, name first.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
    """
    head = words[0]
    if head.text is None:
        return [_unreadable(head.raw)]
    name = head.value
    args = [w.value for w in words[1:]]
    classified = classified_words(name, args, session, registry)
    gated = await gate(name, args, classified[1:], session, registry, namespace,
                       agent_id)
    if isinstance(gated, Refusal):
        return [_from_refusal(name, tuple(args), gated)]
    ctx, asked = gated
    out = [_explained(ctx, session, registry, asked)]
    for inner in inner_lines(name, words[1:]):
        if not inner.readable:
            continue
        if inner.line is not None:
            out.extend(await explain_line(parse(inner.line), session, registry,
                                          namespace, agent_id))
        else:
            out.extend(await explain_words(list(inner.argv), session, registry,
                                           namespace, agent_id))
    return out


def _forked_commands(node: Any, forked: bool) -> Iterator[tuple[Any, bool]]:
    """Every command under a node, in source order, paired with whether
    it runs in a child shell.

    A command in a child shell performs a ``cd`` that is undone before
    the next command of the line, so the walk must not carry it
    forward. Pinned against bash: ``( )``, a pipeline segment, ``$( )``
    and ``<( )`` each fork, and ``&`` backgrounds into a fork. A brace
    group and an ``if`` body do not fork, so their ``cd`` does escape,
    which is why neither is listed in :data:`SUBSHELL_NODES`.

    The fork is carried down rather than climbed back up because ``&``
    is not a wrapper node: it is a token following its command, visible
    only to whoever holds the sibling list.

    Args:
        node (Any): the tree-sitter node to walk.
        forked (bool): whether ``node`` itself runs in a child shell.
    """
    children = node.children
    for index, child in enumerate(children):
        after = children[index + 1] if index + 1 < len(children) else None
        inner = (forked or child.type in SUBSHELL_NODES
                 or (after is not None and after.type == "&"))
        if child.type == NodeType.COMMAND:
            yield child, inner
        yield from _forked_commands(child, inner)


def _after_cd(words: list[Word], session: Session) -> Session:
    """The session the next command of a line is judged in, which
    differs from this one only when this command was a literal ``cd``.

    ``cd /repo && git commit`` is judged before the line runs, so
    without this the rule about ``/repo`` reads the cwd the session
    happened to be in and answers about the wrong directory. A ``cd``
    whose argument the gate cannot read (``cd "$d"``) leaves the cwd
    where it was, and the per-command gate judges that command in the
    real one.

    Args:
        words (list[Word]): the command's words, name first.
        session (Session): the session the command was judged in.
    """
    if len(words) != 2 or words[0].value != "cd" or words[1].text is None:
        return session
    target = words[1].value
    if target.startswith("-"):
        return session
    return session.fork(cwd=resolve_path(target, session.cwd))


def _walked_line(ast: Any,
                 session: Session) -> Iterator[tuple[list[Word], Session]]:
    """Every command of a line with the session it is judged in.

    The cwd is the one fact that moves as a line runs, and both readers
    of a line need the same answer about it: a host asking what a line
    would do and the pass deciding whether to let it run cannot differ,
    or ``explain`` would report an allow the run then refuses.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
    """
    home = home_dir(session)
    walked = session
    for node, forked in _forked_commands(ast, False):
        _, parts = split_env_prefix(get_parts(node))
        words = [
            Word(get_text(part), literal_word(part, home)) for part in parts
        ]
        if not words:
            continue
        yield words, walked
        if not forked:
            walked = _after_cd(words, walked)


async def prejudge_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
) -> Refusal | None:
    """Judge every command of a line before any of it runs, and refuse
    the whole line when a rule speaks about one.

    The agent composed the line as one intent, so a rule that refuses
    part of it refuses the intent. Judging each command as the
    dispatcher reached it left half a line done: with ``deny curl``,
    ``rm -rf /data && curl evil.com`` deleted first and was refused
    second, and an ask fared worse, since approving it later replays a
    line whose first half already ran.

    Two things deliberately do not stop the line, and both are the same
    rule: only a refusal that names a rule is a verdict about the
    intent.

    - A head word the session cannot see is a routing miss, not a
      verdict. It stays bash: the stage fails with "command not found"
      and the rest of the line does what bash does, so a typo cannot
      cost an agent the work the line already did.
    - A word only the runtime can expand is judged where it is
      expanded, by the per-command gate, which sees the real path.

    That second one is the limit of the hold, and it is worth stating
    plainly: this pass reads the *text* of a line, while the gate reads
    its *values*, so a path the runtime computes (``cat $S``, ``$( )``,
    a ``cd`` whose argument is a variable) is invisible here. The rule
    is still enforced, by the gate, but the earlier commands have run
    by then. For a deny that costs allowed side effects and nothing
    more, since the commands that ran were on the allow list. For an
    ask it costs the replay: the question is recorded after part of the
    line already happened, so approving it re-runs a line whose first
    half is done. Closing that would mean asking whenever a word cannot
    be read, which over-asks with no way out for a deny, so a
    deployment that needs the hold for a computed path states it in a
    policy script rather than here.

    The pass is read-only (:func:`explain_line`), so it spends no grant
    and records no request; the one command it refuses on is then put
    through the real gate, which is where an ask is recorded, exactly
    once, for a line that will not run.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.

    Returns:
        The line's refusal, or None to run it.
    """
    if session.commands is None:
        return None
    for words, walked in _walked_line(ast, session):
        if words[0].text is None:
            continue
        for expl in await explain_words(words, walked, registry, namespace,
                                        agent_id):
            if expl.exit_code == 0 or expl.rule is None:
                continue
            args = list(expl.argv)
            classified = classified_words(expl.command, args, walked, registry)
            answered = await admit(expl.command, args, classified[1:], walked,
                                   registry, namespace, agent_id)
            return answered if isinstance(answered, Refusal) else None
    return None


async def explain_line(
    ast: Any,
    session: Session,
    registry: MountRegistry,
    namespace: Namespace | None,
    agent_id: str = "",
) -> list[Explanation]:
    """What every command of a line would do, in the order the gate
    reads them, without running any of it.

    The dry run of the gate: the same visibility check, the same
    context, the same policy chain and the same outcome table, so a
    host reading this and an agent typing the line cannot be told
    different things. What it deliberately does not do is the half of
    admission that costs something, since a line nobody typed must not
    consume a grant or put a question to a host.

    The words are read literally, as ``admit_line`` reads them, so
    nothing is expanded and no ``$( )`` runs.

    Args:
        ast (Any): the parsed tree-sitter root node.
        session (Session): the session running the line.
        registry (MountRegistry): registry holding the policies, the
            decision ledger and the CLI installs.
        namespace (Namespace | None): the link table.
        agent_id (str): the agent the line is attributed to.
    """
    out: list[Explanation] = []
    for words, walked in _walked_line(ast, session):
        out.extend(await explain_words(words, walked, registry, namespace,
                                       agent_id))
    return out
