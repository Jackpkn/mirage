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

import dataclasses
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Any

import tree_sitter

from mirage.shell.call_stack import CallStack
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.types import PathSpec
from mirage.utils.glob_walk import has_glob, has_unescaped_glob
from mirage.utils.path import expand_tilde
from mirage.workspace.expand.brace import (expand_template, make_inert,
                                           substitute, template_globbable)
from mirage.workspace.expand.classify import classify_word
from mirage.workspace.expand.constants import (BRACE_LITERAL_TYPES,
                                               BRACE_WORD_TYPES,
                                               QUOTED_WORD_TYPES, SPLIT_TYPES)
from mirage.workspace.expand.node import (_folded_whitespace,
                                          _unescape_unquoted,
                                          expand_concat_children, expand_node)
from mirage.workspace.expand.variable import expand_array_at, is_multiword_at
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir


@dataclass(frozen=True, slots=True)
class ExpandedWord:
    """One expanded word plus whether pathname expansion may fire on it.

    Bash applies pathname expansion only to glob characters that were
    typed unquoted: `'/data/*.txt'`, `"/data/*.txt"` and `/data/\\*.txt`
    are all the literal name, while `/data/*.txt` and the value of an
    unquoted `$p` are patterns. Expansion is where quoting is still
    visible, so the flag is computed here and carried to
    classification, which otherwise sees only the bare text.

    Args:
        text (str): the expanded word.
        globbable (bool): whether the word carries a glob character
            from an unquoted region.
    """

    text: str
    globbable: bool


def _node_globbable(node: tree_sitter.Node, text: str) -> bool:
    """Whether one word node may contribute live glob characters.

    A quoted node never does; a plain word is read from its raw source
    text so a backslash-quoted glob stays dead; anything else is an
    unquoted expansion, whose produced characters are live the way bash
    treats them.

    Args:
        node (tree_sitter.Node): the word node (or concatenation child).
        text (str): the node's expanded text.
    """
    if node.type in QUOTED_WORD_TYPES:
        return False
    if node.type == NT.WORD:
        return has_unescaped_glob(get_text(node))
    return has_glob(text)


def _string_has_array_at(node: tree_sitter.Node) -> bool:
    return any(is_multiword_at(c) for c in node.children)


async def _expand_string_with_array(
    node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> list[str]:
    """Expand a string containing one or more "${a[@]...}" into words.

    Bash semantics: "prefix${a[@]}suffix" with a=(1 2 3) produces three
    words: "prefix1", "2", "3suffix". Slices ("${a[@]:o:l}"), per-element
    ops ("${a[@]/x/y}"), and indices ("${!a[@]}") word-split the same
    way. A single-element result merges prefix and suffix into one word;
    an empty result still yields prefix+suffix.
    """
    expand_child = partial(expand_node,
                           session=session,
                           execute_fn=execute_fn,
                           call_stack=call_stack)
    fragments: list[str] = [""]
    splat_yielded = False
    for child in node.children:
        if child.type == NT.DQUOTE:
            continue
        if is_multiword_at(child):
            words = await expand_array_at(child, session, call_stack,
                                          expand_child)
            # The separating whitespace is folded into this node, and
            # survives even when the array is empty: bash renders
            # "$x ${empty[@]}" as the single word "a ".
            fragments[-1] = fragments[-1] + _folded_whitespace(child)
            if not words:
                continue
            splat_yielded = True
            if len(words) == 1:
                fragments[-1] = fragments[-1] + words[0]
            else:
                fragments[-1] = fragments[-1] + words[0]
                fragments.extend(words[1:-1])
                fragments.append(words[-1])
            continue
        text = await expand_node(child, session, execute_fn, call_stack)
        fragments[-1] = fragments[-1] + text
    if fragments == [""] and not splat_yielded:
        # A splat that yielded nothing, with no text around it, is no word
        # at all. One empty ELEMENT is a word though (set -- "" passes one
        # empty argument), so the rendered text cannot decide this; only
        # the element count can. An empty expansion beside it does not
        # rescue the word either: with no parameters, "$u$@" is nothing.
        return []
    return fragments


async def _expand_brace_word(
    node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
) -> list[ExpandedWord] | None:
    """Brace-expand a concatenation or brace_expression into words.

    Literal word tokens form the brace template; every other child
    (expansions, strings, substitutions) expands first and joins as an
    inert atom, so `{a,$v}` alternates on the expanded value while
    `{1..$n}` stays literal, matching bash's brace-before-parameter
    ordering. Deliberate divergence: bash rewrites `$v{a,b}` to
    `$va $vb` before parameter expansion; here the prefix keeps its
    own expansion (`prea preb`), which is the useful reading.

    Each produced word reports whether it may glob: template text is
    scanned before its escapes are stripped, and an atom counts only
    when its child was an unquoted expansion holding glob characters,
    so `{'*',x}` stays literal while `{$p,x}` keeps the value live.

    Args:
        node (tree_sitter.Node): concatenation or brace_expression.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    pieces: list[str] = []
    values: list[str] = []
    live_atoms: set[int] = set()
    for child in node.children:
        if not child.is_named or child.type in BRACE_LITERAL_TYPES:
            pieces.append(get_text(child))
        else:
            value = await expand_node(child, session, execute_fn, call_stack)
            if _node_globbable(child, value):
                live_atoms.add(len(values))
            values.append(value)
            pieces.append(make_inert(len(values) - 1))
    words = expand_template("".join(pieces))
    if words is None:
        return None
    home = home_dir(session)
    return [
        ExpandedWord(
            text=substitute(expand_tilde(_unescape_unquoted(w), home), values),
            globbable=template_globbable(w, live_atoms),
        ) for w in words
    ]


async def expand_words(
    parts: list[Any],
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> list[ExpandedWord]:
    """Expand tree-sitter child nodes to words that know their quoting.

    The texts are exactly expand_parts'; each word additionally reports
    whether pathname expansion may fire on it (see ExpandedWord). An
    unquoted expansion's words are live the way bash treats them; a
    quoted word never is; a concatenation is live when any child is, so
    `"/data/"*.txt` globs while `'/data/*'.txt` stays literal.
    """
    result: list[ExpandedWord] = []
    for p in parts:
        if p.type == NT.STRING and _string_has_array_at(p):
            words = await _expand_string_with_array(p, session, execute_fn,
                                                    call_stack)
            result.extend(ExpandedWord(w, globbable=False) for w in words)
            continue
        if p.type in BRACE_WORD_TYPES:
            brace_words = await _expand_brace_word(p, session, execute_fn,
                                                   call_stack)
            if brace_words is not None:
                # Empty unquoted words vanish, like bash: {,x} -> x.
                result.extend(w for w in brace_words if w.text)
                continue
        if p.type == NT.CONCATENATION:
            pairs = await expand_concat_children(p, session, execute_fn,
                                                 call_stack)
            text = "".join(t for _, t in pairs)
            if text:
                result.append(
                    ExpandedWord(text,
                                 globbable=any(
                                     _node_globbable(child, t)
                                     for child, t in pairs)))
            continue
        expanded = await expand_node(p, session, execute_fn, call_stack)
        if p.type == NT.COMMAND_SUBSTITUTION:
            for word in expanded.split():
                if word:
                    result.append(ExpandedWord(word, globbable=has_glob(word)))
            continue
        elif p.type in SPLIT_TYPES:
            for word in expanded.split():
                if word:
                    result.append(ExpandedWord(word, globbable=has_glob(word)))
        elif p.type == NT.STRING:
            # A quoted word stays a word even when it expands to "" (echo
            # "" or "$EMPTY"). The splats that yield zero words instead
            # ("$@", "${a[@]}") never reach here; they took the branch
            # above.
            result.append(ExpandedWord(expanded, globbable=False))
        elif p.type in (NT.RAW_STRING, NT.ANSI_C_STRING, NT.TRANSLATED_STRING):
            result.append(ExpandedWord(expanded, globbable=False))
        else:
            if expanded:
                result.append(
                    ExpandedWord(expanded,
                                 globbable=_node_globbable(p, expanded)))
    return result


async def expand_parts(
    parts: list[Any],
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> list[str]:
    """Expand a list of tree-sitter child nodes to strings."""
    words = await expand_words(parts, session, execute_fn, call_stack)
    return [w.text for w in words]


async def expand_and_classify(
    words: list[Any],
    session: Session,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    cwd: str,
    call_stack: CallStack | None = None,
) -> list[str | PathSpec]:
    """Expand words, classify as PathSpec or text.

    Used by for/select where concrete values are needed
    before iteration. A word whose glob characters were all quoted
    keeps its literal spelling: `for f in '/data/*.txt'` iterates once
    over the name as typed, like bash.
    """
    expanded = await expand_words(words, session, execute_fn, call_stack)
    result: list[str | PathSpec] = []
    for w in expanded:
        item = classify_word(w.text, registry, cwd)
        if (isinstance(item, PathSpec) and item.pattern is not None
                and not w.globbable):
            item = dataclasses.replace(item, pattern=None)
        result.append(item)
    return result
