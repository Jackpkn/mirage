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

from mirage.policy.match import (WILDCARD, RuleHit, head_visible,
                                 intersect_patterns, line_allowed, line_tokens,
                                 op_hit, pattern_matches, pattern_names,
                                 rule_hit, split_pattern)
from mirage.policy.types import (CommandContext, CommandRule, CommandsSpec,
                                 OpsContext)
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
         argv: tuple[str, ...] = (),
         paths: tuple[PathSpec, ...] = (),
         cwd: str = "/",
         tokens: tuple[str, ...] = (),
         program: tuple[str, ...] = (),
         tool: bool = True) -> CommandContext:
    return CommandContext(command=command,
                          paths=paths,
                          argv=argv,
                          cwd=cwd,
                          registry=_Registry(),
                          tokens=tokens,
                          program=program,
                          tool=tool)


def test_split_pattern_drops_trailing_wildcards_only():
    assert split_pattern("git push") == ("git", "push")
    assert split_pattern("git *") == ("git", )
    assert split_pattern("git * *") == ("git", )
    assert split_pattern("git * --hard") == ("git", WILDCARD, "--hard")
    assert split_pattern("  rm  ") == ("rm", )
    assert split_pattern("*") == ()


def test_pattern_matches_is_a_token_prefix():
    assert pattern_matches("rm", ("rm", "-rf", "/x"))
    assert pattern_matches("rm", ("rm", ))
    assert not pattern_matches("rm", ("rmdir", ))
    assert pattern_matches("git push", ("git", "push", "origin", "main"))
    assert not pattern_matches("git push", ("git", "pull"))
    assert not pattern_matches("git push", ("git", ))
    assert pattern_matches("git reset --hard",
                           ("git", "reset", "--hard", "HEAD"))
    assert not pattern_matches("git reset --hard",
                               ("git", "reset", "HEAD", "--hard"))
    # A wildcard token is any one token; trailing it is redundant.
    assert pattern_matches("git * --hard", ("git", "reset", "--hard"))
    assert not pattern_matches("git * --hard", ("git", "reset", "--soft"))
    assert pattern_matches("git *", ("git", ))
    assert pattern_matches("*", ("anything", "at", "all"))


def test_pattern_names_and_head_visible():
    assert pattern_names("git log", "git")
    assert not pattern_names("git log", "log")
    assert pattern_names("*", "rm")
    layers = (CommandsSpec(allow=("ls", "git")),
              CommandsSpec(allow=("ls", "cat", "git log")))
    # A name must start a pattern of every tier that has a list.
    assert head_visible("ls", layers)
    assert head_visible("git", layers)
    assert not head_visible("cat", layers)
    assert not head_visible("rm", layers)
    # A tier without a list hides nothing; no tiers hide nothing.
    assert head_visible("rm", (CommandsSpec(deny=(CommandRule("x"), )), ))
    assert head_visible("rm", ())


def test_line_allowed_intersects_the_tiers_and_skips_non_tools():
    layers = (CommandsSpec(allow=("ls", "git")),
              CommandsSpec(allow=("ls", "git log", "git status")))
    assert line_allowed(_ctx("ls", ("-la", ), tokens=("ls", "-la")), layers)
    assert line_allowed(_ctx("git", tokens=("git", "log", "-1")), layers)
    # The head is visible (some git line is allowed) but this line is
    # covered by no pattern of the second tier.
    assert not line_allowed(_ctx("git", tokens=("git", "push")), layers)
    # A word that is not a tool is never refused by an allow list.
    assert line_allowed(_ctx("cd", tokens=("cd", "/x"), tool=False), layers)
    # A context built without the door's tokens reads the raw argv.
    raw = _ctx("git", ("push", ))
    assert line_tokens(raw) == ("git", "push")
    assert not line_allowed(raw, layers)


def test_rule_hit_by_command_pattern_operand_and_mount():
    whole = CommandRule(reason="no", commands=("git push", ))
    assert rule_hit(whole, None,
                    _ctx("git", tokens=("git", "push",
                                        "origin"))) == RuleHit(operand=None)
    assert rule_hit(whole, None, _ctx("git", tokens=("git", "pull"))) is None
    scoped = CommandRule(reason="no", commands=("rm", ), paths=("/repo/*", ))
    scope = classify_paths(scoped.paths)
    hit = rule_hit(
        scoped, scope,
        _ctx("rm", paths=(_path("/repo/x", raw="x"), ), cwd="/repo"))
    assert hit == RuleHit(operand="x")
    assert rule_hit(scoped, scope, _ctx("rm",
                                        paths=(_path("/scratch/x"), ))) is None
    # A mount-tier rule applies to a line whose cwd or paths lie under
    # the mount, and to nothing else.
    mount = CommandRule(reason="ro", commands=("git push", ), mount="/repo")
    assert rule_hit(mount, None,
                    _ctx("git", tokens=("git", "push"),
                         cwd="/repo/sub")) is not None
    assert rule_hit(
        mount, None,
        _ctx("git",
             tokens=("git", "push"),
             cwd="/scratch",
             paths=(_path("/repo"), ))) is not None
    assert rule_hit(mount, None,
                    _ctx("git", tokens=("git", "push"),
                         cwd="/scratch")) is None
    assert rule_hit(mount, None,
                    _ctx("git", tokens=("git", "push"),
                         cwd="/repository")) is None
    # An every-command rule (no patterns) hits whatever line.
    assert rule_hit(CommandRule(reason="locked"), None, _ctx("ls")) is not None


def test_op_hit_only_for_pure_path_rules():
    rule = CommandRule(reason="frozen", paths=("/data/locked/*", ))
    scope = classify_paths(rule.paths)
    op = OpsContext(op="write",
                    path=_path("/data/locked/a"),
                    write=True,
                    prefix="/data/")
    assert op_hit(rule, scope, op)
    assert not op_hit(
        rule, scope,
        OpsContext(op="write",
                   path=_path("/data/open/a"),
                   write=True,
                   prefix="/data/"))
    named = CommandRule(reason="x", commands=("rm", ), paths=("/data/*", ))
    assert not op_hit(named, classify_paths(named.paths), op)
    assert not op_hit(CommandRule(reason="x", commands=("rm", )), None, op)


def test_intersect_patterns_unifies_token_by_token():
    assert intersect_patterns(
        ("git", ), ("git log", "git diff")) == ("git log", "git diff")
    assert intersect_patterns(("ls", "cat", "git"),
                              ("cat", "git log")) == ("cat", "git log")
    assert intersect_patterns(("*", ), ("ls", )) == ("ls", )
    assert intersect_patterns(("git * --hard", ),
                              ("git reset", )) == ("git reset --hard", )
    assert intersect_patterns(("rm", ), ("ls", )) == ()
    assert intersect_patterns(("*", ), ("*", )) == ("*", )
    # Duplicates collapse, order follows the first list.
    assert intersect_patterns(("git", "git log"),
                              ("git log", )) == ("git log", )
