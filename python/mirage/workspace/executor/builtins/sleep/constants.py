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

import re

# Finite non-negative decimals only ("0", "0.2", ".5", "1.", "+1", "1e-3").
# GNU sleep additionally accepts "inf" and sleeps forever; an agent shell
# must never hang, so non-finite intervals are rejected (deliberate
# divergence). The regex also keeps Python/TypeScript parsing identical:
# float() alone would accept "inf", "nan", "1_0", and surrounding whitespace
# that Number() rejects, and Number() accepts hex that float() rejects.
SLEEP_INTERVAL = re.compile(r"\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?")
