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

import asyncio


def _seed(env) -> None:
    env.create_file("notes.tex", b"score 9\n")
    env.create_file("notes.txt", b"score 8\n")
    env.create_file("sub/inner.tex", b"score 7\n")


def test_include_filters_the_recursive_walk(env):
    _seed(env)
    out = env.mirage("grep -RInE --include='*.tex' score /data")
    assert out == ("/data/notes.tex:1:score 9\n"
                   "/data/sub/inner.tex:1:score 7\n")


def test_exclude_wins_over_include(env):
    _seed(env)
    result = asyncio.run(
        env.ws.execute(
            "grep -r --include='*.tex' --exclude='notes.*' score /data"))
    assert result.exit_code == 0
    assert result.stdout == b"/data/sub/inner.tex:score 7\n"


def test_exclude_dir_prunes_the_walk(env):
    _seed(env)
    out = env.mirage("grep -r --include='*.tex' --exclude-dir=sub score /data")
    assert out == "/data/notes.tex:score 9\n"


def test_include_with_a_slash_matches_nothing(env):
    _seed(env)
    result = asyncio.run(
        env.ws.execute("grep -r --include='sub/*.tex' score /data"))
    assert result.exit_code == 1
    assert result.stdout in (None, b"", b"\n") or not result.stdout


def test_include_filters_an_explicit_operand_in_silence(env):
    _seed(env)
    result = asyncio.run(
        env.ws.execute("grep --include='*.tex' -n score /data/notes.txt"))
    assert result.exit_code == 1
    assert not result.stderr


def test_dash_a_reads_binary_extensions_in_the_walk(env):
    _seed(env)
    env.create_file("data.parquet", b"score binary\n")
    without = env.mirage("grep -r score /data")
    assert "data.parquet" not in without
    with_a = env.mirage("grep -ra score /data")
    assert "/data/data.parquet:score binary" in with_a


def test_dash_a_is_accepted_on_an_explicit_operand(env):
    _seed(env)
    out = env.mirage("grep -aoiE 'SCORE' /data/notes.tex")
    assert out == "score\n"
