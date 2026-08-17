from mirage.core.dify.path import resolve_path
from mirage.core.dify.stat import stat
from mirage.core.dify.walk import walk
from mirage.core.generic.find import make_search_backed_find

find = make_search_backed_find(resolve_path, stat, walk)
