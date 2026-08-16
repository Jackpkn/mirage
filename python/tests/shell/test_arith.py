import pytest

from mirage.shell.arith import evaluate_arith
from mirage.shell.errors import ArithError


def test_basic_precedence():
    assert evaluate_arith("1 + 2 * 3", {}).value == 7
    assert evaluate_arith("(1 + 2) * 3", {}).value == 9
    assert evaluate_arith("2 ** 3 ** 2", {}).value == 512


def test_trunc_division_and_mod_match_c():
    assert evaluate_arith("-7 / 2", {}).value == -3
    assert evaluate_arith("7 / -2", {}).value == -3
    assert evaluate_arith("-7 % 2", {}).value == -1
    assert evaluate_arith("7 % -2", {}).value == 1


def test_literals():
    assert evaluate_arith("0x10", {}).value == 16
    assert evaluate_arith("010", {}).value == 8
    with pytest.raises(ArithError):
        evaluate_arith("08", {})


def test_assignment_and_updates():
    result = evaluate_arith("y = 3, y + 2", {})
    value, updates = result.value, result.updates
    assert value == 5
    assert updates == {"y": "3"}
    result = evaluate_arith("v += 9", {"v": "1"})
    value, updates = result.value, result.updates
    assert (value, updates) == (10, {"v": "10"})


def test_increment_decrement():
    result = evaluate_arith("i++", {})
    value, updates = result.value, result.updates
    assert (value, updates) == (0, {"i": "1"})
    result = evaluate_arith("++i", {"i": "1"})
    value, updates = result.value, result.updates
    assert (value, updates) == (2, {"i": "2"})
    result = evaluate_arith("i--", {"i": "5"})
    value, updates = result.value, result.updates
    assert (value, updates) == (5, {"i": "4"})


def test_short_circuit_skips_side_effects():
    result = evaluate_arith("0 && (q = 7)", {})
    value, updates = result.value, result.updates
    assert (value, updates) == (0, {})
    result = evaluate_arith("1 || (q = 7)", {})
    value, updates = result.value, result.updates
    assert (value, updates) == (1, {})


def test_ternary_evaluates_taken_arm_only():
    result = evaluate_arith("1 ? (w = 4) : (w = 9)", {})
    value, updates = result.value, result.updates
    assert (value, updates) == (4, {"w": "4"})
    assert evaluate_arith("5 > 3 ? 10 : 20", {}).value == 10


def test_variables_resolve_recursively():
    assert evaluate_arith("x + 1", {}).value == 1
    assert evaluate_arith("s * 2", {"s": "1+2"}).value == 6
    assert evaluate_arith("z + 1", {"z": ""}).value == 1


def test_logical_and_comparison_results_are_zero_or_one():
    assert evaluate_arith("3 && 4", {}).value == 1
    assert evaluate_arith("!5", {}).value == 0
    assert evaluate_arith("2 == 2", {}).value == 1
    assert evaluate_arith("2 != 2", {}).value == 0


def test_bitwise_and_shifts():
    assert evaluate_arith("6 & 3", {}).value == 2
    assert evaluate_arith("6 | 3", {}).value == 7
    assert evaluate_arith("6 ^ 3", {}).value == 5
    assert evaluate_arith("~0", {}).value == -1
    assert evaluate_arith("1 << 4", {}).value == 16
    assert evaluate_arith("-16 >> 2", {}).value == -4


def test_sixty_four_bit_wrap():
    assert evaluate_arith("(1 << 63) - 1 + 1", {}).value == -(1 << 63)


def test_errors():
    with pytest.raises(ArithError):
        evaluate_arith("1 / 0", {})
    with pytest.raises(ArithError):
        evaluate_arith("2 ** -1", {})
    with pytest.raises(ArithError):
        evaluate_arith("1 +", {})
    with pytest.raises(ArithError):
        evaluate_arith("@", {})
    with pytest.raises(ArithError):
        evaluate_arith("r + 1", {"r": "r + 1"})


def test_empty_expression_is_zero():
    result = evaluate_arith("", {})
    assert (result.value, result.updates) == (0, {})


def test_base_literals():
    assert evaluate_arith("16#ff", {}).value == 255
    assert evaluate_arith("2#101", {}).value == 5
    assert evaluate_arith("8#17", {}).value == 15
    assert evaluate_arith("36#z", {}).value == 35
    assert evaluate_arith("64#_", {}).value == 63
    assert evaluate_arith("16#a + 2#10", {}).value == 12


def test_base_literal_errors():
    with pytest.raises(ArithError):
        evaluate_arith("2#9", {})
    with pytest.raises(ArithError):
        evaluate_arith("65#1", {})


def _fake_elements():
    store = {("m", "a"): "7", ("arr", "1"): "20"}
    cell = []

    def resolve(name, subscript, env):
        if name == "m":
            return subscript.strip("\"'")
        result = evaluate_arith(subscript, env, elements=cell[0])
        return str(result.value)

    def read(name, key):
        return store.get((name, key))

    from mirage.shell.types import ElementOps
    ops = ElementOps(resolve=resolve, read=read)
    cell.append(ops)
    return ops


def test_element_reads_and_writes():
    ops = _fake_elements()
    result = evaluate_arith("m[a] + arr[0+1]", {}, elements=ops)
    assert result.value == 27
    result = evaluate_arith("m[k] = 5, m[k] + 1", {}, elements=ops)
    assert result.value == 6
    assert [(w.name, w.key, w.value) for w in result.element_updates] \
        == [("m", "k", "5")]


def test_element_incr_decr_and_quoted_key():
    ops = _fake_elements()
    result = evaluate_arith("m[a]++", {}, elements=ops)
    assert result.value == 7
    assert result.element_updates[0].value == "8"
    result = evaluate_arith('m["a"] - 1', {}, elements=ops)
    assert result.value == 6


def test_element_without_ops_is_syntax_error():
    with pytest.raises(ArithError):
        evaluate_arith("a[0]", {})


def test_element_nested_brackets_tokenize():
    ops = _fake_elements()
    result = evaluate_arith("arr[arr[1] - 19]", {}, elements=ops)
    assert result.value == 20
