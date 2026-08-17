from contextvars import ContextVar
from typing import Any


_worker_env: ContextVar[Any | None] = ContextVar("worker_env", default=None)


def set_worker_env(env: Any):
    return _worker_env.set(env)


def reset_worker_env(token) -> None:
    _worker_env.reset(token)


def get_worker_env() -> Any | None:
    return _worker_env.get()
