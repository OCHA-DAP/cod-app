"""One httpx2 client for the scripts, with retries on transient failures and streamed downloads."""

import logging
from datetime import UTC, datetime
from email.utils import format_datetime
from pathlib import Path

from httpx2 import Client, HTTPStatusError, Response, Timeout, TransportError
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

logging.getLogger("httpx2").setLevel(logging.WARNING)


def transient(e: BaseException) -> bool:
    """Network failures, rate limits and server errors; not other 4xx."""
    if isinstance(e, HTTPStatusError):
        return e.response.status_code == 429 or e.response.status_code >= 500
    return isinstance(e, TransportError)


retrying = retry(
    retry=retry_if_exception(transient),
    stop=stop_after_attempt(5),
    wait=wait_exponential(min=2, max=60),
    reraise=True,
)

client = Client(
    timeout=Timeout(60, connect=30),
    follow_redirects=True,
)


@retrying
def get(url: str, **kwargs) -> Response:
    res = client.get(url, **kwargs)
    res.raise_for_status()
    return res


@retrying
def post(url: str, **kwargs) -> Response:
    res = client.post(url, **kwargs)
    res.raise_for_status()
    return res


@retrying
def download(url: str, dest: Path, *, refresh: bool = False, **kwargs) -> bool:
    """Stream url to dest through a .part file; with refresh, keep dest if the server reports it current."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    headers = kwargs.pop("headers", {})
    if refresh and dest.exists():
        mtime = datetime.fromtimestamp(dest.stat().st_mtime, UTC)
        headers["If-Modified-Since"] = format_datetime(mtime, usegmt=True)
    part = dest.with_name(f"{dest.name}.part")
    with client.stream("GET", url, headers=headers, **kwargs) as res:
        if res.status_code == 304:
            return False
        res.raise_for_status()
        with part.open("wb") as f:
            for block in res.iter_bytes(1 << 20):
                f.write(block)
    part.replace(dest)
    return True
