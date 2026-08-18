import pytest

from mirage.policy.errors import PolicyError
from mirage.types import HiddenPaths, HiddenVars, MountMode
from mirage.workspace.session.profile import (MountPermissions, PathsBlock,
                                              SessionProfile, VarsBlock,
                                              WorkspacePermissions)
from mirage.workspace.session.resolve import (bound_hidden, compile_profile,
                                              inherit, rebase, resolve_profile,
                                              tighten)

PROFILES = {
    "default":
    SessionProfile(cwd="/scratch",
                   env={"PAGER": "cat"},
                   mounts={
                       "/repo": "r",
                       "/scratch": "rwx"
                   }),
    "reviewer":
    SessionProfile(extends="default",
                   paths=PathsBlock(hide=("/repo/.env", )),
                   env={"ROLE": "reviewer"}),
    "auditor":
    SessionProfile(extends="reviewer", cwd="/repo"),
}


def test_inherit_copies_absent_fields_and_replaces_stated_ones():
    reviewer = inherit(PROFILES, "reviewer")
    assert reviewer.extends is None
    assert reviewer.cwd == "/scratch"
    assert reviewer.mounts == {
        "/repo": MountMode.READ,
        "/scratch": MountMode.EXEC
    }
    assert reviewer.paths == PathsBlock(hide=("/repo/.env", ))
    # A stated field replaces the parent's, it does not merge into it.
    assert reviewer.env == {"ROLE": "reviewer"}


def test_inherit_walks_a_chain_root_first():
    auditor = inherit(PROFILES, "auditor")
    assert auditor.cwd == "/repo"
    assert auditor.paths == PathsBlock(hide=("/repo/.env", ))
    assert auditor.mounts is not None and "/repo" in auditor.mounts


def test_inherit_of_a_root_is_the_root_without_extends():
    assert inherit(PROFILES, "default") == PROFILES["default"]


def test_inherit_rejects_unknown_names_and_cycles():
    with pytest.raises(PolicyError, match="unknown profile 'nope'"):
        inherit(PROFILES, "nope")
    with pytest.raises(
            PolicyError,
            match="profile 'orphan' extends unknown profile 'gone'"):
        inherit({"orphan": SessionProfile(extends="gone")}, "orphan")
    loop = {
        "a": SessionProfile(extends="b"),
        "b": SessionProfile(extends="a"),
    }
    with pytest.raises(PolicyError, match="cycle: a -> b -> a"):
        inherit(loop, "a")


def test_resolve_profile_names_objects_and_the_default():
    assert resolve_profile(PROFILES,
                           "reviewer") == inherit(PROFILES, "reviewer")
    assert resolve_profile(PROFILES, None) == PROFILES["default"]
    assert resolve_profile({}, None) is None
    plain = SessionProfile(cwd="/x")
    assert resolve_profile(PROFILES, plain) is plain
    child = SessionProfile(extends="default", cwd="/x")
    resolved = resolve_profile(PROFILES, child)
    assert resolved is not None
    assert resolved.cwd == "/x" and resolved.env == {"PAGER": "cat"}
    with pytest.raises(PolicyError):
        resolve_profile(PROFILES, SessionProfile(extends="nope"))


def test_tighten_intersects_mount_grants_at_the_weaker_mode():
    base = SessionProfile(mounts={"/a": "rwx", "/b": "r"})
    inline = SessionProfile(mounts={"/a": "rw", "/c": "rwx"})
    out = tighten(base, inline)
    assert out is not None
    assert out.mounts == {"/a": MountMode.WRITE}


def test_tighten_mixes_the_list_and_mapping_forms():
    ceilings = SessionProfile(mounts={"/a": "rw", "/b": "r"})
    listed = SessionProfile(mounts=["/b", "/c"])
    assert tighten(ceilings, listed).mounts == {"/b": MountMode.READ}
    assert tighten(listed, ceilings).mounts == {"/b": MountMode.READ}
    assert tighten(listed,
                   SessionProfile(mounts=["/c", "/d"])).mounts == ("/c", )
    # One side unstated leaves the other's grant alone.
    assert tighten(ceilings, SessionProfile()).mounts == ceilings.mounts
    assert tighten(SessionProfile(), listed).mounts == ("/b", "/c")


def test_tighten_unions_hides_and_lets_inline_presets_win():
    base = SessionProfile(cwd="/scratch",
                          env={
                              "PAGER": "cat",
                              "A": "1"
                          },
                          paths=PathsBlock(hide=("/repo/.env", "*.pem")),
                          vars=VarsBlock(hide=("AWS_*", )))
    inline = SessionProfile(cwd="/repo",
                            env={"A": "2"},
                            paths=PathsBlock(hide=("*.pem", "/repo/secrets")),
                            vars=VarsBlock(hide=("SLACK_TOKEN", )))
    out = tighten(base, inline)
    assert out is not None
    assert out.cwd == "/repo"
    assert out.env == {"PAGER": "cat", "A": "2"}
    assert out.paths == PathsBlock(hide=("/repo/.env", "*.pem",
                                         "/repo/secrets"))
    assert out.vars == VarsBlock(hide=("AWS_*", "SLACK_TOKEN"))


def test_tighten_with_one_side_missing_is_the_other():
    p = SessionProfile(cwd="/x")
    assert tighten(None, p) is p
    assert tighten(p, None) is p
    assert tighten(None, None) is None


def test_rebase_joins_every_entry_under_the_mount_root():
    perms = MountPermissions(paths=PathsBlock(hide=(".env", "*.pem", "/abs/x",
                                                    "docs/*")))
    assert rebase("/repo/", perms) == ("/repo/.env", "/repo/*.pem",
                                       "/repo/abs/x", "/repo/docs/*")
    assert rebase("repo", None) == ()
    root = MountPermissions(paths=PathsBlock(hide=("a", "/b", "")))
    assert rebase("/", root) == ("/a", "/b", "/")


def test_bound_hidden_combines_workspace_and_rebased_mount_hides():
    ws = WorkspacePermissions(paths=PathsBlock(hide=("/shared/finance", )))
    mounts = {
        "/repo/": MountPermissions(paths=PathsBlock(hide=(".env", "*.pem"))),
        "/scratch/": None,
    }
    assert bound_hidden(ws, mounts) == HiddenPaths(paths=("/shared/finance",
                                                          "/repo/.env"),
                                                   patterns=("/repo/*.pem", ))
    assert bound_hidden(None, {"/a/": None}) is None
    assert bound_hidden(WorkspacePermissions(), {}) is None


def test_compile_profile_turns_the_document_into_session_fields():
    out = compile_profile(
        SessionProfile(cwd="/scratch",
                       env={"ROLE": "x"},
                       mounts={
                           "/a": "rw",
                           "/b": "r"
                       },
                       paths=PathsBlock(hide=("/a/secrets", "*.key")),
                       vars=VarsBlock(hide=("SLACK_TOKEN", "AWS_*"))))
    assert out.mount_modes == {"/a": MountMode.WRITE, "/b": MountMode.READ}
    assert out.hidden_paths == HiddenPaths(paths=("/a/secrets", ),
                                           patterns=("*.key", ))
    assert out.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ),
                                         patterns=("AWS_*", ))
    assert out.env == {"ROLE": "x"}
    assert out.cwd == "/scratch"


def test_compile_profile_list_mounts_and_empty_profile():
    listed = compile_profile(SessionProfile(mounts=["/a", "/b"]))
    assert listed.mount_modes == {"/a": MountMode.EXEC, "/b": MountMode.EXEC}
    empty = compile_profile(None)
    assert (empty.mount_modes, empty.hidden_paths, empty.hidden_vars,
            empty.env, empty.cwd) == (None, None, None, None, None)
    bare = compile_profile(SessionProfile())
    assert bare == empty
