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

import pytest

from mirage.context import (assert_mount_allowed, effective_mount_mode,
                            get_current_session, get_current_session_for,
                            mount_allowed, reset_current_session,
                            set_current_session)
from mirage.types import MountMode, weaker_mode
from mirage.workspace.session import Session, SessionManager


@pytest.fixture
def bound_session():
    sess = Session(session_id="agent",
                   mount_modes={
                       "/ro": MountMode.READ,
                       "/rw": MountMode.WRITE,
                       "/ex": MountMode.EXEC,
                   })
    token = set_current_session(sess)
    yield sess
    reset_current_session(token)


def test_weaker_mode_lattice():
    assert weaker_mode(MountMode.READ, MountMode.WRITE) == MountMode.READ
    assert weaker_mode(MountMode.WRITE, MountMode.READ) == MountMode.READ
    assert weaker_mode(MountMode.EXEC, MountMode.WRITE) == MountMode.WRITE
    assert weaker_mode(MountMode.EXEC, MountMode.EXEC) == MountMode.EXEC


def test_no_session_is_unrestricted():
    assert get_current_session() is None
    assert_mount_allowed("/anything")
    assert effective_mount_mode("/anything", MountMode.WRITE) \
        == MountMode.WRITE


def test_unrestricted_session_keeps_mount_mode():
    token = set_current_session(Session(session_id="free"))
    try:
        assert_mount_allowed("/s3")
        assert effective_mount_mode("/s3", MountMode.EXEC) == MountMode.EXEC
    finally:
        reset_current_session(token)


def test_missing_grant_denies_visibility(bound_session):
    with pytest.raises(PermissionError, match="not allowed"):
        assert_mount_allowed("/other")


def test_root_mount_is_governed(bound_session):
    with pytest.raises(PermissionError, match="'/'"):
        assert_mount_allowed("/")


def test_grant_narrows_mount_mode(bound_session):
    assert effective_mount_mode("/ro", MountMode.WRITE) == MountMode.READ
    assert effective_mount_mode("/rw", MountMode.EXEC) == MountMode.WRITE


def test_grant_cannot_widen_mount_mode(bound_session):
    assert effective_mount_mode("/ex", MountMode.READ) == MountMode.READ
    assert effective_mount_mode("/rw", MountMode.READ) == MountMode.READ


def test_prefix_normalization(bound_session):
    assert_mount_allowed("/ro/")
    assert_mount_allowed("ro")
    assert effective_mount_mode("/ro/", MountMode.WRITE) == MountMode.READ


def test_missing_grant_defaults_effective_to_read(bound_session):
    assert effective_mount_mode("/other", MountMode.EXEC) == MountMode.READ


def test_mount_allowed_is_the_non_raising_twin(bound_session):
    assert mount_allowed("/ro") is True
    assert mount_allowed("/ro/") is True
    assert mount_allowed("/other") is False


def test_mount_allowed_without_session_permits_everything():
    assert mount_allowed("/anything") is True


def test_ownership_gates_the_binding():
    """A binding answers only the manager that published it."""
    mine = SessionManager("default")
    theirs = SessionManager("default")
    sess = Session(session_id="default")
    token = set_current_session(sess, owner=mine)
    try:
        assert get_current_session_for(mine) is sess
        assert get_current_session_for(theirs) is None
        assert get_current_session() is sess
    finally:
        reset_current_session(token)


def test_a_nested_binding_keeps_the_owner():
    """A background job's fork is still the workspace's own session."""
    mine = SessionManager("default")
    outer = Session(session_id="default")
    inner = Session(session_id="default")
    outer_token = set_current_session(outer, owner=mine)
    inner_token = set_current_session(inner)
    try:
        assert get_current_session_for(mine) is inner
    finally:
        reset_current_session(inner_token)
        reset_current_session(outer_token)


def test_an_unowned_binding_answers_nobody():
    """The op-dispatch binders name no owner, so no line adopts one."""
    token = set_current_session(Session(session_id="default"))
    try:
        assert get_current_session_for(SessionManager("default")) is None
    finally:
        reset_current_session(token)


def test_bound_hides_join_the_sessions_own_in_the_predicate():
    from mirage.context import hidden_paths_active, path_allowed
    from mirage.types import HiddenPaths
    own = HiddenPaths(paths=("/a/secrets", ))
    bound = HiddenPaths(paths=("/shared/finance", ),
                        patterns=("/repo/*.pem", ))
    sess = Session(session_id="agent", hidden_paths=own, bound_hidden=bound)
    token = set_current_session(sess)
    try:
        assert hidden_paths_active()
        assert not path_allowed("/a/secrets/x")
        assert not path_allowed("/shared/finance/q1.csv")
        assert not path_allowed("/repo/certs/k.pem")
        assert path_allowed("/repo/README")
        assert path_allowed("/shared/public")
    finally:
        reset_current_session(token)


def test_the_explicit_session_predicate_answers_without_a_binding():
    # A door that holds the session (the admission gate) asks it
    # directly; the contextvar form is the same answer for the bound
    # session, and no session bound means nothing is hidden.
    from mirage.context import path_allowed, session_path_allowed
    from mirage.types import HiddenPaths
    sess = Session(session_id="agent",
                   hidden_paths=HiddenPaths(paths=("/a/secrets", )),
                   bound_hidden=HiddenPaths(patterns=("*.pem", )))
    assert get_current_session() is None
    assert not session_path_allowed(sess, "/a/secrets/x")
    assert not session_path_allowed(sess, "/repo/k.pem")
    assert session_path_allowed(sess, "/a/public")
    assert path_allowed("/a/secrets/x")
    token = set_current_session(sess)
    try:
        assert not path_allowed("/a/secrets/x")
        assert path_allowed("/a/public")
    finally:
        reset_current_session(token)


def test_bound_hides_alone_activate_the_gate():
    from mirage.context import hidden_paths_active, path_allowed
    from mirage.types import HiddenPaths
    sess = Session(session_id="agent",
                   bound_hidden=HiddenPaths(paths=("/repo/.env", )))
    token = set_current_session(sess)
    try:
        assert sess.hidden_paths is None
        assert hidden_paths_active()
        assert not path_allowed("/repo/.env")
        assert path_allowed("/repo/.envrc")
    finally:
        reset_current_session(token)
    free = Session(session_id="free")
    token = set_current_session(free)
    try:
        assert not hidden_paths_active()
        assert path_allowed("/repo/.env")
    finally:
        reset_current_session(token)
