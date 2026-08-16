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

import pytest

from mirage.resource.ram import RAMResource
from mirage.workspace import Workspace

# Every expectation is pinned against GNU bash 5.2.37 on
# debian:stable-slim, except where a case says otherwise: mirage walks
# an associative array in sorted-key order (GNU iterates its hash
# table, whose order is unpredictable), and a bare `declare -A m`
# prints `declare -A m=()` where GNU omits the value, the same
# spelling the indexed kind already answers with.
CASES = [
    ("elements_and_count", 'declare -A m; m[alpha]=1; m[beta]=2; '
     'echo "${m[alpha]}|${m[beta]}|${#m[@]}"', "1|2|2\n", "", 0),
    ("declare_p_sorted_trailing_space",
     "declare -A m=([b]=2 [a]=1); declare -p m",
     'declare -A m=([a]="1" [b]="2" )\n', "", 0),
    ("empty_literal_renders_parens", "declare -A m=(); declare -p m",
     "declare -A m=()\n", "", 0),
    ("pairs_literal", "declare -A m=(k1 v1 k2 v2); declare -p m",
     'declare -A m=([k1]="v1" [k2]="v2" )\n', "", 0),
    ("pairs_odd_tail_empty", "declare -A m=(k1 v1 k2); declare -p m",
     'declare -A m=([k1]="v1" [k2]="" )\n', "", 0),
    ("keyed_literal_refuses_plain_words",
     "declare -A m=([a]=1 b 2); declare -p m", 'declare -A m=([a]="1" )\n',
     "bash: m: 'b': must use subscript when assigning associative array\n"
     "bash: m: '2': must use subscript when assigning associative array\n", 0),
    ("splat_and_keys_sorted",
     'declare -A m=([c]=3 [a]=1 [b]=2); echo "${m[@]}"; echo "${!m[@]}"',
     "1 2 3\na b c\n", "", 0),
    ("key_is_not_arithmetic",
     'declare -A m=([2]=two); a=(zero one TWO); echo "|${m[1+1]}|${a[1+1]}|"',
     "||TWO|\n", "", 0),
    ("dollar_key_expands",
     'k=alpha; declare -A m; m[$k]=v; echo "${m[alpha]}|${m[$k]}"', "v|v\n",
     "", 0),
    ("quoted_key_unquotes", 'declare -A m; m["qk"]=v; declare -p m',
     'declare -A m=([qk]="v" )\n', "", 0),
    ("key_with_space_kept_verbatim",
     'declare -A m; m[two words]=v; echo "${m[two words]}"; declare -p m',
     'v\ndeclare -A m=(["two words"]="v" )\n', "", 0),
    ("element_append", 'declare -A m; m[k]=ab; m[k]+=cd; echo "${m[k]}"',
     "abcd\n", "", 0),
    ("literal_append_merges_last_wins",
     "declare -A m=([a]=1); m+=([b]=2 [a]=9); declare -p m",
     'declare -A m=([a]="9" [b]="2" )\n', "", 0),
    ("whole_assign_replaces", "declare -A m=([a]=1); m=([b]=2); declare -p m",
     'declare -A m=([b]="2" )\n', "", 0),
    ("scalar_assign_is_key_zero", "declare -A m=([a]=1); m=x; declare -p m",
     'declare -A m=([0]="x" [a]="1" )\n', "", 0),
    ("indexed_scalar_assign_keeps_tail", "a=(1 2); a=x; declare -p a",
     'declare -a a=([0]="x" [1]="2")\n', "", 0),
    ("unset_element", 'declare -A m=([a]=1 [b]=2); unset "m[a]"; declare -p m',
     'declare -A m=([b]="2" )\n', "", 0),
    ("unset_missing_element_quiet",
     'declare -A m=([a]=1); unset "m[zz]"; echo $?; declare -p m',
     '0\ndeclare -A m=([a]="1" )\n', "", 0),
    ("unset_at_is_noop",
     'declare -A m=([a]=1 [b]=2); unset "m[@]"; declare -p m',
     'declare -A m=([a]="1" [b]="2" )\n', "", 0),
    ("emptied_renders_parens",
     'declare -A m=([a]=1); unset "m[a]"; declare -p m', "declare -A m=()\n",
     "", 0),
    ("defaults_by_key_presence",
     'declare -A m=([a]=1); echo "|${m[zz]}|${m[zz]-d}|${m[zz]:-e}|"',
     "||d|e|\n", "", 0),
    ("empty_value_is_set",
     'declare -A m; m[k]=; echo "|${m[k]}|${m[k]-d}|${m[k]:-e}|${#m[@]}|"',
     "|||e|1|\n", "", 0),
    ("element_length_and_counts",
     'declare -A m=([a]=hello); echo "${#m[a]}|${#m[@]}|${#m}"', "5|1|0\n", "",
     0),
    ("per_element_ops",
     'declare -A m=([a]=xx1 [b]=xx2); echo "${m[@]#xx}"; echo "${m[a]%1}"',
     "1 2\nxx\n", "", 0),
    ("case_op_per_element",
     'declare -A m=([a]=hello); echo "${m[a]^^}|${m[@]^^}"', "HELLO|HELLO\n",
     "", 0),
    ("slice_over_sorted_values",
     'declare -A m=([a]=1 [b]=2 [c]=3); echo "${m[@]:0:2}"; '
     'echo "${m[@]: -1}"', "1 2\n3\n", "", 0),
    ("bare_dollar_is_key_zero",
     'declare -A m=([a]=1); echo "|$m|"; m[0]=z; echo "|$m|"', "||\n|z|\n", "",
     0),
    ("for_iterates_sorted_keys",
     'declare -A m=([b]=2 [a]=1); for k in "${!m[@]}"; '
     'do echo "$k=${m[$k]}"; done', "a=1\nb=2\n", "", 0),
    ("arith_literal_key", 'declare -A m=([abc]=7); x=abc; '
     'echo "$((m[x])) $((m[$x])) $((m[abc]))"', "0 7 7\n", "", 0),
    ("arith_nested_key_text", "declare -A m=([k5]=9); i=5; echo $((m[k$i]))",
     "9\n", "", 0),
    ("arith_quoted_key", 'declare -A m=([x]=3); echo $((m["x"]))', "3\n", "",
     0),
    ("arith_incr_and_assign",
     'declare -A m=([k]=5); ((m[k]++)); echo "${m[k]}|$((m[k]=9))|${m[k]}"',
     "6|9|9\n", "", 0),
    ("arith_missing_reads_zero",
     'declare -A m; ((m[k]--)); echo "${m[k]}"; declare -p m',
     '-1\ndeclare -A m=([k]="-1" )\n', "", 0),
    ("arith_readonly_refused_nonfatal",
     'readonly -A r=([k]=1); ((r[k]++)); echo "after=$?"; declare -p r',
     'after=1\ndeclare -Ar r=([k]="1" )\n', "bash: r: readonly variable\n", 0),
    ("test_v_key_membership", 'declare -A m=([k]=v); [[ -v m[k] ]]; echo $?; '
     '[[ -v m[zz] ]]; echo $?; test -v "m[k]"; echo $?', "0\n1\n0\n", "", 0),
    ("test_v_bare_checks_key_zero",
     "declare -A m=([a]=1); [[ -v m ]]; echo $?; m[0]=z; [[ -v m ]]; echo $?",
     "1\n0\n", "", 0),
    ("scalar_converts_to_key_zero", "s=5; declare -A s; declare -p s",
     'declare -A s=([0]="5" )\n', "", 0),
    ("indexed_conversion_refused",
     "a=(1 2); declare -A a; echo rc=$?; declare -p a",
     'rc=1\ndeclare -a a=([0]="1" [1]="2")\n',
     "bash: declare: a: cannot convert indexed to associative array\n", 0),
    ("assoc_to_indexed_refused",
     "declare -A m=([a]=1); declare -a m; echo rc=$?; declare -p m",
     'rc=1\ndeclare -A m=([a]="1" )\n',
     "bash: declare: m: cannot convert associative to indexed array\n", 0),
    ("empty_subscript_fatal", "e=; declare -A m; m[$e]=v; echo unreached", "",
     "bash: m[$e]: bad array subscript\n", 1),
    ("local_A_shadows", 'f(){ local -A m=([k]=inner); echo "${m[k]}"; }; '
     'declare -A m=([k]=outer); f; echo "${m[k]}"', "inner\nouter\n", "", 0),
    ("readonly_A_renders_Ar", "readonly -A r2=([k]=v); declare -p r2",
     'declare -Ar r2=([k]="v" )\n', "", 0),
    ("export_A_renders_Ax_env_excluded",
     "declare -Ax m=([k]=v); declare -p m; env | grep -c '^m=' || true",
     'declare -Ax m=([k]="v" )\n0\n', "", 0),
    ("read_into_element", 'declare -A m; read "m[k]" <<< hello; declare -p m',
     'declare -A m=([k]="hello" )\n', "", 0),
    ("printf_v_element",
     'declare -A m; printf -v "m[k]" "%s" hi; declare -p m',
     'declare -A m=([k]="hi" )\n', "", 0),
    ("special_keys_quoted_in_declare_p",
     'declare -A m; k1=@; k2="*"; m[$k1]=at; m[$k2]=star; declare -p m',
     'declare -A m=(["*"]="star" ["@"]="at" )\n', "", 0),
    ("indexed_literal_subscripts", "a=([3]=x y [1]=z); declare -p a",
     'declare -a a=([1]="z" [3]="x" [4]="y")\n', "", 0),
    ("indexed_arith_lvalues",
     "a=(); ((a[2]=5)); echo $((a[0]=3)); declare -p a",
     '3\ndeclare -a a=([0]="3" [2]="5")\n', "", 0),
    ("indexed_subscript_dollar_read", 'k=1; a=(x y z); echo "${a[$k]}"', "y\n",
     "", 0),
]


@pytest.mark.parametrize("case_id,cmd,out,err,code",
                         CASES,
                         ids=[c[0] for c in CASES])
def test_assoc_case(case_id, cmd, out, err, code):

    async def run():
        ws = Workspace({"data": RAMResource()})
        try:
            io = await ws.execute(cmd)
            stdout = await io.stdout_str()
            stderr = io.stderr or b""
            if isinstance(stderr, bytes):
                stderr = stderr.decode()
            return io.exit_code, stdout, stderr
        finally:
            await ws.close()

    got_code, got_out, got_err = asyncio.run(run())
    assert (got_out, got_err, got_code) == (out, err, code)
