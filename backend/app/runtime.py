from contextvars import ContextVar

_env: ContextVar[object | None] = ContextVar("worker_env", default=None)


def set_env(env):
    return _env.set(env)


def reset_env(token):
    _env.reset(token)


def get_env():
    return _env.get()
