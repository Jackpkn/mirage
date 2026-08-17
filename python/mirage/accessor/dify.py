import aiohttp

from mirage.accessor.base import Accessor
from mirage.concurrency import ConcurrencyLimiter
from mirage.resource.dify.config import DifyConfig


class DifyAccessor(Accessor):

    def __init__(self, config: DifyConfig) -> None:
        self.config = config
        self._session: aiohttp.ClientSession | None = None
        self._request_limiter = ConcurrencyLimiter(config.max_concurrency)

    def get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(
                    total=self.config.request_timeout))
        return self._session

    async def close(self) -> None:
        if self._session is None:
            return
        await self._session.close()
        self._session = None
