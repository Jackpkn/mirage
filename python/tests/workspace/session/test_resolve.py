import pytest

from mirage.policy.errors import PolicyError
from mirage.policy.types import CommandRule, CommandsSpec
from mirage.shell.variable import VarAttr
from mirage.types import HiddenPaths, HiddenVars, MountMode
from mirage.workspace.session.session import Session

from mirage.workspace.session.permissions import (  # isort: skip
    CommandsBlock, MountCommandsBlock, MountPermissions, PathsBlock,
    SessionProfile, VarsBlock, WorkspacePermissions)
from mirage.workspace.session.resolve import (  # isort: skip
    apply_profile, bound_commands, bound_hidden, compile_commands,
    compile_profile, inherit, narrow, rebase, resolve_profile, tighten)

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


def test_compile_profile_grants_infrastructure_beside_listed_mounts():
    # A ceiling must never lock an agent out of the scratch root, /dev
    # or the history view, so they ride along at EXEC when the profile
    # lists mounts, and are not invented when it lists none.
    infra = ("/", "/dev")
    listed = compile_profile(SessionProfile(mounts={"/a": "r"}), infra)
    assert listed.mount_modes == {
        "/a": MountMode.READ,
        "/": MountMode.EXEC,
        "/dev": MountMode.EXEC,
    }
    own = compile_profile(SessionProfile(mounts={"/": "r"}), infra)
    assert own.mount_modes is not None
    assert own.mount_modes["/"] == MountMode.READ
    assert compile_profile(SessionProfile(cwd="/a"), infra).mount_modes is None


def test_narrow_stamps_the_uneditable_fields_and_apply_seeds_the_rest():
    compiled = compile_profile(
        SessionProfile(cwd="/a",
                       env={"ROLE": "x"},
                       mounts={"/a": "rw"},
                       paths=PathsBlock(hide=("/a/secrets", )),
                       vars=VarsBlock(hide=("SLACK_TOKEN", ))))
    narrowed = Session(session_id="s1")
    narrow(narrowed, compiled)
    assert narrowed.mount_modes == {"/a": MountMode.WRITE}
    assert narrowed.mount_modes is not compiled.mount_modes
    assert narrowed.hidden_paths == HiddenPaths(paths=("/a/secrets", ))
    assert narrowed.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ))
    assert narrowed.cwd == "/" and "ROLE" not in narrowed.env
    applied = Session(session_id="s2")
    apply_profile(applied, compiled)
    assert applied.mount_modes == {"/a": MountMode.WRITE}
    assert applied.cwd == "/a"
    assert applied.env["ROLE"] == "x"
    assert VarAttr.EXPORT in applied.vars["ROLE"].attrs


def test_inherit_replaces_the_commands_block_whole():
    profiles = {
        "base":
        SessionProfile(
            commands=CommandsBlock(allow=("ls", "git"), deny=("rm", ))),
        "child":
        SessionProfile(extends="base", commands=CommandsBlock(allow=("ls", ))),
        "grand":
        SessionProfile(extends="child", cwd="/x"),
    }
    # A stated block replaces the parent's (field inheritance), an
    # absent one is inherited; safety comes from tightening, not here.
    assert inherit(profiles, "child").commands == CommandsBlock(allow=("ls", ))
    assert inherit(profiles, "grand").commands == CommandsBlock(allow=("ls", ))


def test_tighten_intersects_allow_and_unions_ask_and_deny():
    base = SessionProfile(commands=CommandsBlock(
        allow=("ls", "git", "cat"), ask=("git push", ), deny=("rm", )))
    inline = SessionProfile(commands=CommandsBlock(
        allow=("git log", "cat", "wc"),
        deny=(CommandRule(reason="no", commands=("mv", )), )))
    out = tighten(base, inline)
    assert out is not None and out.commands is not None
    assert out.commands.allow == ("git log", "cat")
    assert [r.commands for r in out.commands.ask] == [("git push", )]
    assert [r.commands for r in out.commands.deny] == [("rm", ), ("mv", )]
    # One side without a list leaves the other's alone; one side without
    # a block leaves the other's block.
    only = tighten(base, SessionProfile(commands=CommandsBlock(deny=("cp", ))))
    assert only is not None and only.commands is not None
    assert only.commands.allow == ("ls", "git", "cat")
    assert tighten(base, SessionProfile(cwd="/x")).commands == base.commands
    assert tighten(SessionProfile(cwd="/x"),
                   inline).commands == inline.commands


def test_compile_commands_scopes_a_mount_tier_and_rebases_its_paths():
    assert compile_commands(None) is None
    assert compile_commands(CommandsBlock()) is None
    # A workspace or profile tier compiles as written.
    spec = compile_commands(CommandsBlock(allow=("ls", ), deny=("rm", )))
    assert spec == CommandsSpec(allow=("ls", ),
                                deny=(CommandRule(reason="denied by policy",
                                                  commands=("rm", )), ))
    # A mount tier: every rule scoped to the mount root, its paths
    # rebased under it, no allow list.
    mount = compile_commands(MountCommandsBlock(
        ask=("git rebase", ),
        deny=(CommandRule(reason="ro",
                          commands=("rm", ),
                          paths=("*.lock", "/docs")), )),
                             mount="/repo/")
    assert mount == CommandsSpec(
        allow=None,
        ask=(CommandRule(reason="no standing approval",
                         commands=("git rebase", ),
                         mount="/repo"), ),
        deny=(CommandRule(reason="ro",
                          commands=("rm", ),
                          paths=("/repo/*.lock", "/repo/docs"),
                          mount="/repo"), ))
    # An empty mount block is nothing to evaluate.
    assert compile_commands(MountCommandsBlock(), mount="/repo") is None


def test_bound_commands_lists_mount_tiers_then_the_workspace():
    layers = bound_commands(
        WorkspacePermissions(commands=CommandsBlock(allow=("ls", ))), {
            "/repo/":
            MountPermissions(commands=MountCommandsBlock(deny=("git push", ))),
            "/scratch/":
            None,
            "/s3/":
            MountPermissions(paths=PathsBlock(hide=(".env", ))),
        })
    assert len(layers) == 2
    assert layers[0].deny[0].mount == "/repo"
    assert layers[1] == CommandsSpec(allow=("ls", ))
    assert bound_commands(None, {"/a/": None}) == ()
    assert bound_commands(WorkspacePermissions(), {}) == ()


def test_compile_profile_and_narrow_carry_the_command_tier():
    compiled = compile_profile(
        SessionProfile(commands=CommandsBlock(allow=("ls", ), ask=("git", ))))
    assert compiled.commands == CommandsSpec(allow=("ls", ),
                                             ask=(CommandRule(
                                                 reason="no standing approval",
                                                 commands=("git", )), ))
    assert compile_profile(SessionProfile(cwd="/x")).commands is None
    session = Session(session_id="s")
    narrow(session, compiled)
    assert session.commands == compiled.commands
    assert session.command_layers == (compiled.commands, )
    bound = CommandsSpec(deny=(CommandRule(reason="x"), ))
    session.bound_commands = (bound, )
    assert session.command_layers == (bound, compiled.commands)
