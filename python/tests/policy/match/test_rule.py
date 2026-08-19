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
