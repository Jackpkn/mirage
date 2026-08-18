import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.size_suffix import size_suffixes
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandName, FlagValue, FlagView
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, format_fs_error

_UNITS = size_suffixes("bkKMGTPEZY")
_TRY_HELP = "\nTry 'cmp --help' for more information."
_COUNT = re.compile(r"^([0-9]+)([A-Za-z]*)$")


def parse_count(raw: str, option: str) -> int:
    """One GNU ``cmp`` byte count: digits and an optional size suffix.

    GNU reads ``-n``/``-i`` operands through xstrtoumax, so ``1K`` and
    ``1kB`` are accepted and anything else is a usage error naming the
    long option, not a crash.

    Args:
        raw (str): the operand as typed.
        option (str): the long option name for the diagnostic, e.g.
            ``--bytes``.

    Raises:
        UsageError: the operand is not digits plus a known suffix.
    """
    match = _COUNT.match(raw)
    suffix = match.group(2) if match is not None else ""
    if match is None or (suffix and suffix not in _UNITS):
        raise UsageError(f"cmp: invalid {option} value '{raw}'{_TRY_HELP}")
    return int(match.group(1)) * (_UNITS[suffix] if suffix else 1)


def parse_skip(raw: str) -> tuple[int, int]:
    """The ``-i`` operand as one skip per file.

    GNU takes ``SKIP`` for both files or ``SKIP1:SKIP2`` for one each,
    so ``-i 0:3`` compares all of the first file against the fourth
    byte onward of the second.

    Args:
        raw (str): the ``-i`` operand as typed.
    """
    first, sep, second = raw.partition(":")
    head = parse_count(first, "--ignore-initial")
    if not sep:
        return head, head
    return head, parse_count(second, "--ignore-initial")


def visible(byte: int) -> str:
    """One byte rendered the way GNU ``cmp -b`` renders it.

    The cat -v alphabet: a control byte becomes ``^X`` (so tab is
    ``^I``, unlike ``cat -v`` itself), DEL becomes ``^?``, and a high
    byte becomes ``M-`` followed by the same rules on its low seven
    bits.

    Args:
        byte (int): the byte value.
    """
    if byte >= 128:
        return "M-" + visible(byte - 128)
    if byte == 127:
        return "^?"
    if byte < 32:
        return f"^{chr(byte + 64)}"
    return chr(byte)


async def cmp_cmd(
        paths: list[PathSpec],
        *,
        read_bytes: Callable[..., Awaitable[bytes]],
        silent: bool = False,
        verbose: bool = False,
        limit: int | None = None,
        print_bytes: bool = False,
        skip: tuple[int, int] = (0, 0),
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.CMP, paths[2].raw_path
                                  or paths[2].virtual)
    if len(paths) < 2:
        raise UsageError("cmp: requires two paths")
    p0, p1 = paths[0], paths[1]
    try:
        data1 = await read_bytes(p0)
        data2 = await read_bytes(p1)
    except FS_ERRORS as exc:
        # GNU cmp reserves exit 1 for "files differ"; trouble (a missing
        # or unreadable operand) is exit 2.
        return None, IOResult(exit_code=2,
                              stderr=format_fs_error("cmp", exc, paths))
    data1 = data1[skip[0]:]
    data2 = data2[skip[1]:]
    if limit is not None:
        data1 = data1[:limit]
        data2 = data2[:limit]
    if data1 == data2:
        return None, IOResult()
    if silent:
        return None, IOResult(exit_code=1)
    common = min(len(data1), len(data2))
    if verbose:
        out_lines: list[str] = []
        for idx in range(common):
            if data1[idx] != data2[idx]:
                row = f"{idx + 1} {data1[idx]:>3o}"
                if print_bytes:
                    row += f" {visible(data1[idx]):<4}"
                row += f" {data2[idx]:>3o}"
                if print_bytes:
                    row += f" {visible(data2[idx])}"
                out_lines.append(row)
        io = IOResult(exit_code=1)
        if len(data1) != len(data2):
            io.stderr = _eof_error(paths, data1, data2, verbose)
        return format_records(out_lines), io
    for idx in range(common):
        if data1[idx] != data2[idx]:
            line = 1 + data1[:idx].count(ord(b"\n"))
            # GNU counts in `byte` under -b and in `char` otherwise, on
            # the same offset -- the word tracks the flag, not a unit.
            unit = "byte" if print_bytes else "char"
            msg = (f"{p0.virtual} {p1.virtual}"
                   f" differ: {unit} {idx + 1}, line {line}")
            if print_bytes:
                msg += (f" is {data1[idx]:>3o} {visible(data1[idx])}"
                        f" {data2[idx]:>3o} {visible(data2[idx])}")
            return format_records([msg]), IOResult(exit_code=1)
    return None, IOResult(exit_code=1,
                          stderr=_eof_error(paths, data1, data2, verbose))


def _eof_error(
    paths: list[PathSpec],
    data1: bytes,
    data2: bytes,
    verbose: bool,
) -> bytes:
    """GNU's ``EOF on FILE`` diagnostic for a common-prefix difference.

    It is a diagnostic, not output: GNU writes it to stderr and still
    exits 1. ``-l`` reports the byte only, every other mode adds the
    line the count lands in.

    Args:
        paths (list[PathSpec]): the two operands, in order.
        data1 (bytes): the first file's compared bytes.
        data2 (bytes): the second file's compared bytes.
        verbose (bool): whether ``-l`` is in effect.
    """
    shorter = paths[0] if len(data1) < len(data2) else paths[1]
    held = data1 if len(data1) < len(data2) else data2
    msg = f"cmp: EOF on {shorter.virtual} after byte {len(held)}"
    if not verbose:
        msg += f", in line {1 + held.count(ord(b'\n'))}"
    return (msg + "\n").encode()


__all__ = ["cmp_cmd"]


@dataclass(frozen=True, slots=True)
class CmpFlags:
    silent: bool = False
    verbose: bool = False
    limit: int | None = None
    print_bytes: bool = False
    skip: tuple[int, int] = (0, 0)


def parse_flags(flags: Mapping[str, FlagValue]) -> CmpFlags:
    fl = FlagView(flags, spec=SPECS["cmp"])
    n_raw = fl.as_str("n")
    i_raw = fl.as_str("i")
    return CmpFlags(
        silent=fl.as_bool("s"),
        verbose=fl.as_bool("args_l"),
        limit=parse_count(n_raw, "--bytes") if n_raw is not None else None,
        print_bytes=fl.as_bool("b"),
        skip=parse_skip(i_raw) if i_raw is not None else (0, 0),
    )


async def cmp_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await cmp_cmd(paths,
                         read_bytes=read_bytes,
                         silent=parsed.silent,
                         verbose=parsed.verbose,
                         limit=parsed.limit,
                         print_bytes=parsed.print_bytes,
                         skip=parsed.skip)
