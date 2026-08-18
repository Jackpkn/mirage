from mirage.shell.types import (GRAMMAR_BUILTINS, TOOL_BUILTINS, BuiltinTier,
                                ShellBuiltin)


def test_tiers_partition_the_builtins():
    assert GRAMMAR_BUILTINS.isdisjoint(TOOL_BUILTINS)
    assert GRAMMAR_BUILTINS | TOOL_BUILTINS == frozenset(ShellBuiltin)


def test_tier_members_are_builtins():
    assert all(isinstance(b, ShellBuiltin) for b in GRAMMAR_BUILTINS)
    assert all(isinstance(b, ShellBuiltin) for b in TOOL_BUILTINS)


def test_tier_values():
    assert BuiltinTier.GRAMMAR == "grammar"
    assert BuiltinTier.TOOL == "tool"
    assert ShellBuiltin.CD in GRAMMAR_BUILTINS
    assert ShellBuiltin.PYTHON3 in TOOL_BUILTINS
