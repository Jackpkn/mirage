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

from mirage.policy.match.rule import RuleMatch, match_op, match_rule
from mirage.policy.types import CommandContext, CommandRule, OpsContext
from mirage.types import PathSpec
from mirage.utils.hidden import classify_paths


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


def _path(virtual: str, raw: str = "") -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual,
                    resolved=True,
                    raw_path=raw)


def _ctx(command: str,
         paths: tuple[PathSpec, ...] = (),
         cwd: str = "/",
         tokens: tuple[str, ...] = ()) -> CommandContext:
    return CommandContext(command=command,
                          paths=paths,
                          argv=(),
                          cwd=cwd,
                          registry=_Registry(),
                          tokens=tokens)


def test_match_rule_by_command_pattern_operand_and_mount():
    whole = CommandRule(reason="no", commands=("git push", ))
    assert match_rule(whole, None,
                      _ctx("git",
                           tokens=("git", "push",
                                   "origin"))) == RuleMatch(operand=None)
    assert match_rule(whole, None, _ctx("git", tokens=("git", "pull"))) is None
    scoped = CommandRule(reason="no", commands=("rm", ), paths=("/repo/*", ))
    scope = classify_paths(scoped.paths)
    hit = match_rule(
        scoped, scope,
        _ctx("rm", paths=(_path("/repo/x", raw="x"), ), cwd="/repo"))
    assert hit == RuleMatch(operand="x")
    assert match_rule(scoped, scope,
                      _ctx("rm", paths=(_path("/scratch/x"), ))) is None
    # A mount-tier rule applies to a line whose cwd or paths lie under
    # the mount, and to nothing else.
    mount = CommandRule(reason="ro", commands=("git push", ), mount="/repo")
    assert match_rule(mount, None,
                      _ctx("git", tokens=("git", "push"),
                           cwd="/repo/sub")) is not None
    assert match_rule(
        mount, None,
        _ctx("git",
             tokens=("git", "push"),
             cwd="/scratch",
             paths=(_path("/repo"), ))) is not None
    assert match_rule(mount, None,
                      _ctx("git", tokens=("git", "push"),
                           cwd="/scratch")) is None
    assert match_rule(mount, None,
                      _ctx("git", tokens=("git", "push"),
                           cwd="/repository")) is None
    # An every-command rule (no patterns) matches whatever line.
    assert match_rule(CommandRule(reason="locked"), None,
                      _ctx("ls")) is not None


def test_match_op_only_for_pure_path_rules():
    rule = CommandRule(reason="frozen", paths=("/data/locked/*", ))
    scope = classify_paths(rule.paths)
    op = OpsContext(op="write",
                    path=_path("/data/locked/a"),
                    write=True,
                    prefix="/data/")
    assert match_op(rule, scope, op)
    assert not match_op(
        rule, scope,
        OpsContext(op="write",
                   path=_path("/data/open/a"),
                   write=True,
                   prefix="/data/"))
    named = CommandRule(reason="x", commands=("rm", ), paths=("/data/*", ))
    assert not match_op(named, classify_paths(named.paths), op)
    assert not match_op(CommandRule(reason="x", commands=("rm", )), None, op)


def _subtree_ctx(command: str, *operands: str) -> CommandContext:
    paths = tuple(_path(o, raw=o) for o in operands)
    return CommandContext(command=command,
                          paths=paths,
                          operands=paths,
                          argv=operands,
                          cwd="/",
                          registry=_Registry(),
                          tokens=(command, *operands))


def test_a_subtree_command_on_the_directory_holding_the_scope_matches():
    # `/x/locked/*` protects the children; `rm -r /x/locked`, `rm -r /x`
    # and `mv /x/locked elsewhere` take them along, so for rm, rmdir and
    # mv the operand at or above the holding directory matches.
    rule = CommandRule(reason="frozen", paths=("/x/locked/*", ))
    scope = classify_paths(rule.paths)
    for command in ("rm", "rmdir"):
        for operand in ("/x/locked", "/x", "/"):
            assert match_rule(rule, scope, _subtree_ctx(
                command, operand)) == RuleMatch(operand=operand)
        assert match_rule(rule, scope, _subtree_ctx(command,
                                                    "/x/other")) is None
    assert match_rule(rule, scope,
                      _subtree_ctx("mv", "/x/locked",
                                   "/y")) == RuleMatch(operand="/x/locked")
    assert match_rule(rule, scope,
                      _subtree_ctx("mv", "/x",
                                   "/y")) == RuleMatch(operand="/x")
    # mv's destination matches only as the holding directory itself:
    # moving into it lands in the scope, moving into an ancestor does not.
    assert match_rule(rule, scope, _subtree_ctx(
        "mv", "/z", "/x/locked")) == RuleMatch(operand="/x/locked")
    assert match_rule(rule, scope, _subtree_ctx("mv", "/z", "/x")) is None
    # A reader given the same operand is not a whole-line refusal: its
    # I/O under the scope is the command tier's to refuse, file by file.
    assert match_rule(rule, scope, _subtree_ctx("cat", "/x/locked")) is None
    assert match_rule(rule, scope, _subtree_ctx("cp", "/x", "/y")) is None
    # A command-scoped rule judges its own command the same way.
    named = CommandRule(reason="locked",
                        commands=("rm", ),
                        paths=("/x/locked/*", ))
    assert match_rule(named, classify_paths(named.paths),
                      _subtree_ctx("rm", "/x")) == RuleMatch(operand="/x")
    assert match_rule(named, classify_paths(named.paths),
                      _subtree_ctx("mv", "/x", "/y")) is None


def test_match_op_refuses_a_subtree_op_on_the_directory_holding_the_scope():
    rule = CommandRule(reason="frozen", paths=("/data/locked/*", ))
    scope = classify_paths(rule.paths)
    for op, virtual in (("rename", "/data/locked"), ("rename", "/data"),
                        ("rmdir", "/data/locked"), ("rm_r", "/data")):
        assert match_op(
            rule, scope,
            OpsContext(op=op, path=_path(virtual), write=True,
                       prefix="/data/"))
    # A read or write of the directory itself is not in the scope, and a
    # subtree op beside the scope is not either.
    assert not match_op(
        rule, scope,
        OpsContext(op="readdir",
                   path=_path("/data/locked"),
                   write=False,
                   prefix="/data/"))
    assert not match_op(
        rule, scope,
        OpsContext(op="rename",
                   path=_path("/data/other"),
                   write=True,
                   prefix="/data/"))
