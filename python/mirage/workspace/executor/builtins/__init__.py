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

from mirage.workspace.executor.builtins.alias import (handle_alias,
                                                      handle_unalias)
from mirage.workspace.executor.builtins.capacity import handle_df
from mirage.workspace.executor.builtins.command import handle_command_builtin
from mirage.workspace.executor.builtins.condition import handle_test
from mirage.workspace.executor.builtins.dirs import handle_cd
from mirage.workspace.executor.builtins.exec_cmd import handle_exec_command
from mirage.workspace.executor.builtins.history import handle_history
from mirage.workspace.executor.builtins.links import (accepts_line,
                                                      follow_paths, handle_ln,
                                                      handle_readlink,
                                                      link_flags, prepare_mv,
                                                      strip_link_operands)
from mirage.workspace.executor.builtins.lookup import handle_type, handle_which
from mirage.workspace.executor.builtins.man import (_collect_man_hits,
                                                    _render_man_entry,
                                                    _render_man_index,
                                                    handle_man)
from mirage.workspace.executor.builtins.mapfile import handle_mapfile
from mirage.workspace.executor.builtins.metadata import (handle_chgrp,
                                                         handle_chmod,
                                                         handle_chown,
                                                         handle_touch)
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.executor.builtins.script import (handle_bash,
                                                       handle_eval,
                                                       handle_exec_path,
                                                       handle_sleep,
                                                       handle_source)
from mirage.workspace.executor.builtins.shopt import handle_shopt
from mirage.workspace.executor.builtins.text import (_interpret_escapes,
                                                     handle_echo,
                                                     handle_printf)
from mirage.workspace.executor.builtins.timeout import handle_timeout
from mirage.workspace.executor.builtins.umask import handle_umask
from mirage.workspace.executor.builtins.xargs import handle_xargs

from mirage.workspace.executor.builtins.vars import (  # isort: skip
    handle_declare_functions, handle_declare_print, handle_env, handle_exit,
    handle_export, handle_getopts, handle_let, handle_local, handle_printenv,
    handle_read, handle_readonly, handle_return, handle_set, handle_shift,
    handle_trap, handle_unset, handle_whoami, note_local_array)

__all__ = [
    '_collect_man_hits',
    'handle_alias',
    'handle_unalias',
    '_interpret_escapes',
    '_render_man_entry',
    '_render_man_index',
    '_scope_path',
    '_to_scope',
    'handle_bash',
    'handle_cd',
    'handle_command_builtin',
    'handle_echo',
    'handle_env',
    'handle_eval',
    'handle_exit',
    'handle_exec_command',
    'handle_declare_functions',
    'handle_declare_print',
    'handle_export',
    'handle_history',
    'handle_let',
    'handle_ln',
    'handle_local',
    'handle_readlink',
    'link_flags',
    'accepts_line',
    'follow_paths',
    'handle_df',
    'handle_chgrp',
    'handle_chmod',
    'handle_chown',
    'handle_touch',
    'prepare_mv',
    'strip_link_operands',
    'handle_man',
    'handle_mapfile',
    'handle_printenv',
    'handle_printf',
    'handle_read',
    'handle_readonly',
    'handle_return',
    'handle_getopts',
    'handle_set',
    'handle_shift',
    'handle_shopt',
    'handle_sleep',
    'handle_exec_path',
    'handle_source',
    'handle_test',
    'handle_timeout',
    'handle_trap',
    'handle_unset',
    'handle_type',
    'handle_umask',
    'handle_which',
    'handle_whoami',
    'note_local_array',
    'handle_xargs',
]
