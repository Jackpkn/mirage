from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TS_SRC = [
    REPO / "typescript/packages/core/src",
    REPO / "typescript/packages/node/src",
    REPO / "typescript/packages/browser/src",
]
# `normalizeFields(input, {rename: {...}})` and the shared `const RENAME`
# maps the S3-alias families feed it.
RENAME_PROP_RE = re.compile(r"rename:\s*\{([^{}]*)\}", re.S)
RENAME_CONST_RE = re.compile(r"^const \w*RENAME\w*[^=\n]*=\s*\{([^{}]*)\}",
                             re.M | re.S)
PAIR_RE = re.compile(r"([A-Za-z0-9_]+)\s*:\s*'([A-Za-z0-9_]+)'")
SNAKE_RE = re.compile(r"_([a-z0-9])")


def snake_to_camel(snake: str) -> str:
    """Reimplement `snakeToCamel` from utils/normalize.ts.

    Args:
        snake: The python-side field name.

    Returns:
        The camelCase spelling `normalizeFields` produces by default.
    """
    return SNAKE_RE.sub(lambda m: m.group(1).upper(), snake)


def redundant_pairs(text: str) -> list[tuple[str, str]]:
    """Find rename entries that only restate the default mapping.

    Args:
        text: One TypeScript source file.

    Returns:
        The `(source, target)` pairs whose target is exactly what
        `snakeToCamel` would have produced anyway.
    """
    found: list[tuple[str, str]] = []
    for match in RENAME_PROP_RE.finditer(text):
        found.extend(PAIR_RE.findall(match.group(1)))
    for match in RENAME_CONST_RE.finditer(text):
        found.extend(PAIR_RE.findall(match.group(1)))
    return [(k, v) for k, v in found if snake_to_camel(k) == v]


def source_files() -> list[Path]:
    """Every TypeScript source file that could hold a rename map.

    Returns:
        The files to scan, build output and node_modules excluded.
    """
    out: list[Path] = []
    for root in TS_SRC:
        if not root.is_dir():
            continue
        out.extend(p for p in root.rglob("*.ts")
                   if "node_modules" not in p.parts and "dist" not in p.parts)
    return sorted(out)


def main() -> int:
    """Fail when a rename map restates what `snakeToCamel` already does.

    `normalizeFields` falls back to `snakeToCamel(key)` for every key no
    rename names, so `api_key: 'apiKey'` is not configuration, it is a
    second place for the same fact to be wrong -- and it hides the entries
    that *are* load-bearing (`endpoint_url: 'endpoint'`, `timeout:
    'timeoutMs'`, `aws_profile: 'profile'`) in a wall of noise.

    Returns:
        0 when every surviving rename entry is a real override.
    """
    offenders: list[tuple[Path, list[tuple[str, str]]]] = []
    for path in source_files():
        if path.name == "normalize.test.ts":
            continue
        pairs = redundant_pairs(path.read_text())
        if pairs:
            offenders.append((path, pairs))
    if not offenders:
        return 0
    total = sum(len(p) for _, p in offenders)
    print(f"{total} rename entries only restate snakeToCamel:\n")
    for path, pairs in offenders:
        print(f"  {path.relative_to(REPO)}")
        for key, value in pairs:
            print(f"      {key}: '{value}'")
    print("\nDelete them: normalizeFields already maps these by default.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
