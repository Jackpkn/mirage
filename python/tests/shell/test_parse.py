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
import tree_sitter

from mirage.shell import parse
from mirage.shell.helpers import (get_command_name, get_for_parts,
                                  get_if_branches, get_list_parts, get_parts,
                                  get_pipeline_commands, get_redirects,
                                  get_text, get_while_parts)
from mirage.shell.parse import (command_invocations, command_words, env_reads,
                                find_syntax_error, find_unterminated_backtick,
                                opaque_reads, referenced_names,
                                strip_line_continuation)
from mirage.shell.types import NodeType as NT


def test_parse_returns_node():
    root = parse("echo hello")
    assert isinstance(root, tree_sitter.Node)


def test_parse_root_is_program():
    root = parse("echo hello")
    assert root.type == "program"


def test_simple_command():
    root = parse("echo hello")
    cmd = root.named_children[0]
    assert cmd.type == NT.COMMAND
    assert get_command_name(cmd) == "echo"


def test_command_with_flags():
    cmd = parse("grep -n pattern /s3/file").named_children[0]
    parts = get_parts(cmd)
    texts = [get_text(p) for p in parts]
    assert texts == ["grep", "-n", "pattern", "/s3/file"]


def test_pipeline():
    node = parse("grep p file | sort").named_children[0]
    assert node.type == NT.PIPELINE
    cmds, stderr = get_pipeline_commands(node)
    assert len(cmds) == 2
    assert stderr == [False]


def test_multi_pipe():
    node = parse("cat f | grep p | sort | uniq").named_children[0]
    cmds, stderr = get_pipeline_commands(node)
    assert len(cmds) == 4
    assert stderr == [False, False, False]


def test_pipe_stderr():
    node = parse("cmd1 |& cmd2").named_children[0]
    cmds, stderr = get_pipeline_commands(node)
    assert stderr == [True]


def test_list_and():
    node = parse("cmd1 && cmd2").named_children[0]
    assert node.type == NT.LIST
    left, op, right = get_list_parts(node)
    assert op == NT.AND


def test_list_or():
    node = parse("cmd1 || cmd2").named_children[0]
    left, op, right = get_list_parts(node)
    assert op == NT.OR


def test_semicolon_multiple():
    root = parse("cmd1; cmd2; cmd3")
    assert len(root.named_children) == 3


def test_redirect_on_list_detected():
    """tree-sitter parses 'a || echo x > file' with > on the list.

    The executor re-associates this shape to the last command
    (execute_node NodeKind.REDIRECT), so the parse must keep exposing
    the list body.
    """
    node = parse("a || echo x > /out.txt").named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT
    body, redirects = get_redirects(node)
    assert body.type == NT.LIST
    assert len(redirects) == 1


def test_redirect_on_and_chain_detected():
    """tree-sitter hoists > from 'a && echo x > file'."""
    node = parse("a && echo x > /out.txt").named_children[0]
    body, redirects = get_redirects(node)
    assert body.type == NT.LIST
    assert len(redirects) == 1


def test_redirect_on_simple_command_not_list():
    """Normal redirect on a command is not a list redirect."""
    node = parse("echo hello > /out.txt").named_children[0]
    body, redirects = get_redirects(node)
    assert body.type == NT.COMMAND
    assert len(redirects) == 1


def test_subshell():
    node = parse("(grep p file | sort)").named_children[0]
    assert node.type == NT.SUBSHELL


def test_if_simple():
    node = parse("if true; then echo yes; fi").named_children[0]
    assert node.type == NT.IF_STATEMENT
    branches, else_body = get_if_branches(node)
    assert len(branches) == 1
    assert else_body is None


def test_if_else():
    node = parse("if true; then echo yes; else echo no; fi").named_children[0]
    branches, else_body = get_if_branches(node)
    assert else_body is not None


def test_if_elif_else():
    node = parse("if true; then echo a; elif false; then echo b; "
                 "else echo c; fi").named_children[0]
    branches, else_body = get_if_branches(node)
    assert len(branches) == 2
    assert else_body is not None


def test_for_loop():
    node = parse("for x in a b c; do echo; done").named_children[0]
    assert node.type == NT.FOR_STATEMENT
    var, values, body = get_for_parts(node)
    assert var == "x"
    assert [get_text(v) for v in values] == ["a", "b", "c"]


def test_while_loop():
    node = parse("while true; do echo loop; done").named_children[0]
    assert node.type == NT.WHILE_STATEMENT
    cond, body = get_while_parts(node)
    assert get_text(cond) == "true"


def test_until_loop():
    node = parse("until false; do echo loop; done").named_children[0]
    assert node.type == NT.WHILE_STATEMENT
    assert node.children[0].type == NT.UNTIL


def test_select():
    node = parse("select opt in a b c; do echo; done").named_children[0]
    assert node.type == NT.FOR_STATEMENT
    assert node.children[0].type == NT.SELECT
    var, values, body = get_for_parts(node)
    assert var == "opt"
    assert [get_text(v) for v in values] == ["a", "b", "c"]


def test_case():
    node = parse("case $x in a) echo A;; b) echo B;; esac").named_children[0]
    assert node.type == NT.CASE_STATEMENT


def test_function():
    node = parse("foo() { echo hello; }").named_children[0]
    assert node.type == NT.FUNCTION_DEFINITION


def test_export():
    node = parse("export FOO=bar").named_children[0]
    assert node.type == NT.DECLARATION_COMMAND


def test_unset():
    node = parse("unset FOO").named_children[0]
    assert node.type == NT.UNSET_COMMAND


def test_test_bracket():
    node = parse("[ -f /file ]").named_children[0]
    assert node.type == NT.TEST_COMMAND


def test_test_double_bracket():
    node = parse("[[ -f /file ]]").named_children[0]
    assert node.type == NT.TEST_COMMAND


def test_background():
    root = parse("cmd &")
    has_bg = any(c.type == NT.BACKGROUND for c in root.children)
    assert has_bg


def test_empty():
    root = parse("")
    assert len(root.named_children) == 0


def test_partial_quoted_heredoc_end_is_not_syntax_error():
    root = parse("cat <<EN'D'\n$v\nEND")
    assert find_syntax_error(root) is None


def test_preserves_expansions():
    cmd = parse("echo $VAR $(cmd) $((1+2))").named_children[0]
    types = {c.type for c in cmd.named_children}
    assert NT.SIMPLE_EXPANSION in types
    assert NT.COMMAND_SUBSTITUTION in types
    assert NT.ARITHMETIC_EXPANSION in types


def test_preserves_quotes():
    cmd = parse('echo "hello" \'world\'').named_children[0]
    types = [c.type for c in cmd.named_children if c.type != NT.COMMAND_NAME]
    assert NT.STRING in types
    assert NT.RAW_STRING in types


def test_complex_command():
    root = parse("for f in $(ls /data/); do "
                 "cat $f | grep error > /out/$f; done")
    assert root.named_children[0].type == NT.FOR_STATEMENT


def test_chained_and_or():
    node = parse("cmd1 && cmd2 || cmd3").named_children[0]
    assert node.type == NT.LIST


def test_heredoc():
    node = parse("cat <<EOF\nhello\nEOF").named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT


def test_process_substitution():
    cmd = parse("diff <(sort a) <(sort b)").named_children[0]
    parts = get_parts(cmd)
    ps = [p for p in parts if p.type == NT.PROCESS_SUBSTITUTION]
    assert len(ps) == 2


def test_negated_command():
    node = parse("! echo hello").named_children[0]
    assert node.type == NT.NEGATED_COMMAND


# ── `((` reparse: subshell that immediately opens a subshell ────────


def test_double_open_paren_parses_as_nested_subshells():
    """``((`` lexes as the arithmetic opener; bash reparses, so do we."""
    node = parse("((echo a); echo b)").named_children[0]
    assert node.type == NT.SUBSHELL


def test_double_open_paren_backgrounded():
    assert not parse("((echo s1; echo s2) & wait)").has_error


def test_genuine_arithmetic_command_is_untouched():
    assert not parse("i=1; ((i++)); echo $i").has_error


def test_line_mixing_arithmetic_and_nested_subshell():
    """Each opener is judged on its own span, not on the error region.

    tree-sitter's ERROR swallows the valid ``((i++))`` next to the bad
    opener, so scope alone would split both and silently turn the
    arithmetic into a subshell running ``i++``.
    """
    assert not parse("i=1; ((i++)); ((echo x); echo $i)").has_error


def test_paren_inside_quotes_does_not_confuse_the_scan():
    assert not parse('((echo ")"); echo b)').has_error


def test_two_nested_subshells_on_one_line():
    assert not parse("((echo a); echo b); ((echo c); echo d)").has_error


def test_multibyte_text_before_the_opener_does_not_shift_offsets():
    """tree-sitter reports byte offsets; ``é`` is two bytes in UTF-8."""
    assert not parse("echo é; ((echo a); echo b)").has_error


def test_unrelated_syntax_error_still_reports():
    assert parse("if then").has_error


@pytest.mark.parametrize(
    "command,expected",
    [
        # An odd-length trailing run ends in a live continuation.
        ("echo a\\", "echo a"),
        ("echo a\\\\\\", "echo a\\\\"),
        ("echo \\", "echo "),
        # An even-length run is all escaped backslashes, so nothing goes.
        ("echo a\\\\", "echo a\\\\"),
        ("echo a\\\\\\\\", "echo a\\\\\\\\"),
        ("echo a", "echo a"),
        ("echo a\\ b", "echo a\\ b"),
    ])
def test_strip_line_continuation(command, expected):
    assert strip_line_continuation(command) == expected


@pytest.mark.parametrize("command", [
    "echo `echo a",
    "echo \"`echo '`'`\"",
    "echo a`",
    "`",
])
def test_find_unterminated_backtick_flags_open_region(command):
    assert find_unterminated_backtick(command) is not None


@pytest.mark.parametrize(
    "command",
    [
        "echo `echo a`",
        "echo `echo a` `echo b`",
        # Single quotes protect a backtick, double quotes do not.
        "echo '`'",
        'echo "`echo a`"',
        'echo "\\`"',
        # Only a backslash escapes inside the region.
        "echo `echo \\`nested\\``",
        "echo a",
        "cat <<EOF\nplain\nEOF",
    ])
def test_find_unterminated_backtick_accepts_balanced(command):
    assert find_unterminated_backtick(command) is None


# tree-sitter-bash 0.25.1 drops a later unbraced `$var` out of its word
# when the name is cut short by a name-terminating character: the `$`
# stays behind as a literal token and the rest splits into a sibling
# word (`/api/$c/$id.json` -> `/api/$c/$` + `id.json`). parse() rebraces
# the orphaned expansion and reparses, so consumers see one whole word.
@pytest.mark.parametrize(("command", "target"), [
    ("echo hi > /api/$c/$id.json", "/api/$c/${id}.json"),
    ("echo hi > /api/$c/$id-x", "/api/$c/${id}-x"),
    ("echo hi > /w/$a/$b/$c", "/w/$a/${b}/$c"),
    ("echo hi > ${a}.$b.json", "${a}.${b}.json"),
    ("echo hi > /w/$c/$1.json", "/w/$c/${1}.json"),
])
def test_redirect_target_later_unbraced_var_stays_one_word(command, target):
    node = parse(command).named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT
    _, redirects = get_redirects(node)
    assert len(redirects) == 1
    assert redirects[0].target == target


def test_word_later_unbraced_var_stays_one_argument():
    cmd = parse("echo /api/$c/$id.json").named_children[0]
    parts = get_parts(cmd)
    assert [get_text(p) for p in parts] == ["echo", "/api/$c/${id}.json"]


def test_assignment_later_unbraced_var_stays_one_assignment():
    # The broken parse split this into an assignment holding
    # `p=/api/$c/$` plus a command named `id.json`.
    node = parse("p=/api/$c/$id.json").named_children[0]
    assert node.type == NT.VARIABLE_ASSIGNMENT
    assert get_text(node) == "p=/api/$c/${id}.json"


@pytest.mark.parametrize(
    ("command", "words"),
    [
        # A `$` bash keeps literal is left alone: no name character follows.
        ("echo a$ b", ["echo", "a$", "b"]),
        ("echo $", ["echo", "$"]),
    ])
def test_literal_dollar_words_stay_untouched(command, words):
    cmd = parse(command).named_children[0]
    assert [get_text(p) for p in get_parts(cmd)] == words


@pytest.mark.parametrize(
    ("command", "names"),
    [
        ("echo $X", {"X"}),
        ("echo ${X:-d}", {"X"}),
        ('echo "$X"', {"X"}),
        # Single quotes tokenize as raw_string with no children, so the
        # name inside is never a reference.
        ("echo '$X'", set()),
        ("echo $((X+1))", {"X"}),
        # The assignment's own name is a write, not a read; the
        # substitution body is walked.
        ("x=$(echo $Y)", {"Y"}),
        ("cat <$F", {"F"}),
        # The loop variable is a write; the word list is a read.
        ("for i in $L; do echo hi; done", {"L"}),
        # Over-approximation on purpose: the walk is textual over the
        # whole tree, so a name an eval would read is fetched too.
        ('x=$(eval "$Z")', {"Z"}),
        ("echo ${a[i]}", {"a"}),
        ("(( X=Y+1 ))", {"X", "Y"}),
        ("export V=$W", {"W"}),
        # Bare names under a declaring builtin declare or delete.
        ("readonly R", set()),
        ("unset X", set()),
        ("TOKEN=1 printenv", set()),
        ("cat <<EOF\nhello $H\nEOF", {"H"}),
        ("echo hi", set()),
        # A definition's body runs at invocation, not here; the fill
        # layer joins invoked bodies back in through line_nodes.
        ('f() { echo "$T"; }', set()),
        ('f() { echo "$T"; }; echo $U', {"U"}),
    ])
def test_referenced_names(command, names):
    assert referenced_names(parse(command)) == frozenset(names)


@pytest.mark.parametrize(
    ("command", "words"),
    [
        ("echo hi", {"echo"}),
        ("env | grep A", {"env", "grep"}),
        ("x=$(printenv)", {"printenv"}),
        ("if env; then ls; fi", {"env", "ls"}),
        # The declaring builtins parse as their own node types; their
        # head word is still a command word.
        ("export X=1", {"export"}),
        ("declare -p", {"declare"}),
        ("unset X", {"unset"}),
        ("set", {"set"}),
        ("x=1", set()),
        # A definition's body runs at invocation; only the call is a
        # command word here.
        ("f() { python3 x.py; }; f", {"f"}),
    ])
def test_command_words(command, words):
    assert command_words(parse(command)) == frozenset(words)


@pytest.mark.parametrize(
    ("command", "whole", "names", "excluded"),
    [
        # env renders on any invocation: bare it prints, with a command
        # it hands the snapshot to a child.
        ("env", True, set(), set()),
        # An override or removal excludes exactly its name from the
        # whole read: the child cannot observe the standing value.
        ("env FOO=1 mycmd", True, set(), {"FOO"}),
        ("env -u TOKEN mycmd", True, set(), {"TOKEN"}),
        ("env --unset=TOKEN mycmd", True, set(), {"TOKEN"}),
        ("env --unset TOKEN mycmd", True, set(), {"TOKEN"}),
        ("env -uTOKEN mycmd", True, set(), {"TOKEN"}),
        ("env -u A B=2 mycmd", True, set(), {"A", "B"}),
        # A literal ignore-environment form proves the start is empty,
        # so nothing existing is read.
        ("env -i", False, set(), set()),
        ("env -i mycmd", False, set(), set()),
        ("env --ignore-environment mycmd", False, set(), set()),
        ("env - mycmd", False, set(), set()),
        ("env -0i", False, set(), set()),
        ("env -iu X mycmd", False, set(), set()),
        # -u consumes a value, so `-ui` unsets a variable named i and
        # `-u -i` one named -i; both still read the whole environment.
        ("env -ui mycmd", True, set(), {"i"}),
        ("env -u -i mycmd", True, set(), {"-i"}),
        ("env -u X mycmd", True, set(), {"X"}),
        # The first operand ends the options, and -- ends them too.
        ("env X=1 -i mycmd", True, set(), {"X"}),
        ("env -- -i mycmd", True, set(), set()),
        # A word no static read can spell ends the claim: it may be the
        # command, demoting later words to arguments. What was consumed
        # before it keeps its effect; after a proven -i it changes
        # nothing.
        ("env $x mycmd", True, set(), set()),
        ("env -u A $x -u B mycmd", True, set(), {"A"}),
        ("env A=1 $x B=2 mycmd", True, set(), {"A"}),
        ("env -i $x", False, set(), set()),
        # An option the builtin refuses stops it from running at all,
        # so nothing is read.
        ("env --bogus mycmd", False, set(), set()),
        ("env --unset", False, set(), set()),
        # An assignment prefix overrides its name for the invocation's
        # environment, whoever renders it; += proves nothing.
        ("TOKEN=local env", True, set(), {"TOKEN"}),
        ("TOKEN=local set", True, set(), {"TOKEN"}),
        ("TOKEN=local printenv", True, set(), {"TOKEN"}),
        ("TOKEN=local printenv TOKEN", False, set(), set()),
        ("TOKEN=local printenv TOKEN OTHER", False, {"OTHER"}, set()),
        ("TOKEN+=x printenv TOKEN", False, {"TOKEN"}, set()),
        ("TOKEN=local env -u OTHER mycmd", True, set(), {"TOKEN", "OTHER"}),
        # Exclusions fold by intersection: a name is skippable only
        # when every whole read skips it.
        ("env -u A mycmd; env -u B mycmd", True, set(), set()),
        ("env -u A mycmd; env -u A other", True, set(), {"A"}),
        ("env -u A mycmd; export", True, set(), set()),
        ("set", True, set(), set()),
        ("set -u", False, set(), set()),
        ("set -- a b", False, set(), set()),
        ("printenv", True, set(), set()),
        ("printenv -0", True, set(), set()),
        ("printenv PATH TOKEN", False, {"PATH", "TOKEN"}, set()),
        # A print target only the runtime can spell selects everything.
        ("printenv $x", True, set(), set()),
        ("export", True, set(), set()),
        ("export -p", True, set(), set()),
        ("export -p TOKEN", False, {"TOKEN"}, set()),
        # Mutating forms read nothing: the write must not depend on a
        # source being alive.
        ("export TOKEN=local", False, set(), set()),
        ("export TOKEN", False, set(), set()),
        ("declare", True, set(), set()),
        ("declare -p A B", False, {"A", "B"}, set()),
        ("declare -x OTHER=1", False, set(), set()),
        # readonly and local print sets a managed entry can never be in.
        ("readonly", False, set(), set()),
        ("echo hi", False, set(), set()),
        # Inside a substitution counts; inside a definition does not.
        ("x=$(env)", True, set(), set()),
        ("f() { env; }", False, set(), set()),
    ])
def test_env_reads(command, whole, names, excluded):
    got = env_reads(parse(command))
    assert got == (whole, frozenset(names), frozenset(excluded))


@pytest.mark.parametrize(
    ("command", "opaque"),
    [
        ("echo ${!name}", True),
        ("echo ${!prefix@}", True),
        ("echo ${#name}", False),
        ("echo ${name:-d}", False),
        ("declare -n r=TOKEN", True),
        ("local -n r=TOKEN", True),
        ("typeset -n r=TOKEN", True),
        # -n means unexport / unset-the-ref there, not a nameref.
        ("export -n X", False),
        ("unset -n r", False),
        ("echo $T", False),
        # A definition's body is not read at definition time.
        ("f() { echo ${!name}; }", False),
    ])
def test_opaque_reads(command, opaque):
    assert opaque_reads(parse(command)) == opaque


@pytest.mark.parametrize(
    ("command", "invocations"),
    [
        ("ntn api get PAGE", (("ntn", ("api", "get", "PAGE")), )),
        # A dynamic word arrives as None, distinguishable from absent.
        ("slack msg send --to $u", (("slack",
                                     ("msg", "send", "--to", None)), )),
        # A dynamic head is None too: the program itself is
        # undecidable before expansion.
        ("$tool api get", ((None, ("api", "get")), )),
        ('"$t"x run', ((None, ("run", )), )),
        ("A=1 mycli run", (("mycli", ("run", )), )),
        ("mycli 'lit arg' \"plain\"", (("mycli", ("lit arg", "plain")), )),
        ("mycli run > out.txt", (("mycli", ("run", )), )),
        ("export X=1", ()),
        ("f() { inner verb; }", ()),
    ])
def test_command_invocations(command, invocations):
    assert command_invocations(parse(command)) == invocations
