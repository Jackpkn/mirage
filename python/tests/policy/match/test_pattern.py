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

from mirage.policy.constants import WILDCARD
from mirage.policy.match.pattern import (intersect_patterns, pattern_matches,
                                         pattern_names, split_pattern)


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


def test_pattern_names_starts_a_line_of_the_command():
    assert pattern_names("git log", "git")
    assert not pattern_names("git log", "log")
    assert pattern_names("*", "rm")


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
