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

from mirage.shell.variable import VarAttr
from mirage.workspace.session.session import Session
from mirage.workspace.session.state import env_snapshot

# Every case pinned against GNU bash 5.2.37 on debian:stable-slim.
# The environment is the *exported* set, not every string-valued
# variable, which is the whole subject of this file.
ENV_CASES = [
    # A plain assignment is a shell variable and never reaches `env`.
    ('X=hello; export Y=world; env | grep -E "^(X|Y)="', "Y=world\n"),
    # A name marked but never assigned is not in the environment either:
    # `export Z` declares, it does not give Z a value.
    ('export Z; env | grep -c "^Z="', "0\n"),
    # `export -n` keeps the value and drops the name from the env.
    ('export Y=world; export -n Y; env | grep -c "^Y="', "0\n"),
    # `set -a` marks what is assigned *while it is on*, and nothing else.
    ("B=1; set -a; C=2; set +a; D=3;"
     ' env | grep -cE "^(B|C|D)="', "1\n"),
    ("set -a; A=auto; env | grep '^A='", "A=auto\n"),
]

DECLARE_CASES = [
    # `--` for a plain scalar, `-x` once exported.
    ("X=hello; export Y=world; declare -p X Y",
     'declare -- X="hello"\ndeclare -x Y="world"\n'),
    # The declared-but-unset third state prints bare, with no `=`.
    ("export Z; declare -p Z", "declare -x Z\n"),
    # `declare -x` on an existing name keeps the value and adds the mark.
    ("E=val; declare -x E; declare -p E", 'declare -x E="val"\n'),
    # `export -n` is the off direction and leaves an ordinary variable.
    ("export Y=world; export -n Y; declare -p Y", 'declare -- Y="world"\n'),
    # Never exported, so `-n` is a no-op rather than an error.
    ("P=plain; export -n P; echo rc=$?; declare -p P",
     'rc=0\ndeclare -- P="plain"\n'),
    # Two attributes print in bash's own order (`r` before `x`), which
    # is `attr_letters`' order and not the order they were set in.
    ("export RO=v; readonly RO; declare -p RO", 'declare -rx RO="v"\n'),
    # `set -a` again, read through declare rather than env.
    ("B=1; set -a; C=2; set +a; D=3; declare -p B C D",
     'declare -- B="1"\ndeclare -x C="2"\ndeclare -- D="3"\n'),
]

EXPORT_P_CASES = [
    # Only exported names, and the unset one prints without a value.
    # Grepped to the three names under test because a real shell (and a
    # mirage session, which exports PWD) carries plenty of others.
    ("X=hello; export Y=world; export Z;"
     ' export -p | grep -E "^declare -x (X|Y|Z)"',
     'declare -x Y="world"\ndeclare -x Z\n'),
    # `export -n` removes it from the listing entirely.
    ('export Q; export -n Q; export -p | grep -c "declare -x Q"', "0\n"),
]


@pytest.mark.parametrize("cmd,out", ENV_CASES)
def test_env_carries_only_exported_names(shell, cmd, out):
    assert shell.mirage(cmd) == out


@pytest.mark.parametrize("cmd,out", DECLARE_CASES)
def test_declare_p_renders_the_attributes(shell, cmd, out):
    assert shell.mirage(cmd) == out


@pytest.mark.parametrize("cmd,out", EXPORT_P_CASES)
def test_export_p_lists_the_exported_set(shell, cmd, out):
    assert shell.mirage(cmd) == out


def test_printenv_is_a_process_view(shell):
    # printenv is a separate binary in GNU, so the only names it can
    # possibly see are exported ones; a plain variable exits 1.
    assert shell.mirage_result("X=plain; printenv X") == (1, "", "")
    assert shell.mirage("export X=e; printenv X") == "e\n"


def test_declare_p_reports_an_unknown_name(shell):
    # GNU prints the names it knows, refuses only the ones it does not,
    # and exits 1. Deliberate divergence: mirage's diagnostic carries no
    # `line N:` (GNU says `bash: line 1: declare: NOPE: not found`),
    # matching how every other mirage builtin words its errors.
    rc, out, err = shell.mirage_result("G=good; declare -p G NOPE")
    assert rc == 1
    assert out == 'declare -- G="good"\n'
    assert err == "bash: declare: NOPE: not found\n"


def test_pwd_is_exported_from_startup(shell):
    # bash exports $PWD, so a session that has never run `cd` still
    # hands one to a child.
    assert "PWD=" in shell.mirage("env")


def test_cd_exports_pwd_and_oldpwd(shell):
    # GNU prints `declare -x OLDPWD` too, and carries both into a child.
    # $OLDPWD is created by the first `cd`, so it is marked there; $PWD
    # keeps the mark it was seeded with because `seed_var` replaces the
    # value rather than the record.
    out = shell.mirage("mkdir -p /data/d; cd /data/d; cd /data;"
                       " declare -p PWD OLDPWD")
    assert out == ('declare -x PWD="/data"\n'
                   'declare -x OLDPWD="/data/d"\n')
    env = shell.mirage('env | grep -E "^(PWD|OLDPWD)=" | sort')
    assert env == "OLDPWD=/data/d\nPWD=/data\n"


def test_fork_keeps_pwd_exported():
    # `fork(cwd=...)` rebuilds $PWD to name where the fork is, and has to
    # rebuild the attribute with it: a fresh record would drop the mark
    # and the forked session's env would lose PWD entirely.
    session = Session(session_id="s1", cwd="/")
    forked = session.fork(cwd="/data")
    assert VarAttr.EXPORT in forked.vars["PWD"].attrs
    assert env_snapshot(forked)["PWD"] == "/data"


def test_a_plain_variable_still_expands_and_lists(shell):
    # The narrowing is the *process* view only: `$X` and the bare `set`
    # listing are the shell's own view and see every variable.
    assert shell.mirage("X=hello; echo $X") == "hello\n"
    assert "X=hello\n" in shell.mirage("X=hello; set")
