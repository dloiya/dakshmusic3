from pydantic_settings import BaseSettings, SettingsConfigDict
from .connectors.cloudflare.bindings import get_worker_env


class Settings(BaseSettings):
    app_name: str = "dakshmusic3"
    environment: str = "development"
    api_prefix: str = "/api/v1"
    cors_origins: str = ""
    cloudflare_account_id: str = ""
    cloudflare_d1_database_id: str = "3f384751-424c-4628-ac18-384c068afd8b"
    cloudflare_api_token: str = ""
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = "dakshmusic3-audio"
    r2_endpoint: str = ""
    session_secret: str = ""
    password_hash: str = ""
    password_salt: str = ""
    github_token: str = ""
    github_repo: str = "dloiya/dakshmusic3"
    github_ref: str = "main"
    acquire_workflow: str = "acquire-audio.yml"
    populate_cache_workflow: str = "populate-top-cache.yml"
    worker_public_url: str = ""
    worker_callback_secret: str = ""
    spotiflac_api_url: str = ""
    deezer_api_url: str = "https://api.deezer.com"
    top_cache_limit: int = 100
    model_config = SettingsConfigDict(env_file=".env", env_prefix="DAKSH_", extra="ignore")


def get_settings() -> Settings:
    values = {}
    env = get_worker_env()
    if env is not None:
        mapping = {
            "APP_SECRET": "session_secret",
            "CALLBACK_SECRET": "worker_callback_secret",
            "GITHUB_TOKEN": "github_token",
            "PASSWORD_HASH": "password_hash",
            "PASSWORD_SALT": "password_salt",
            "ENVIRONMENT": "environment",
            "CORS_ORIGINS": "cors_origins",
            "DAKSH_WORKER_PUBLIC_URL": "worker_public_url",
            "DEEZER_API": "deezer_api_url",
            "SPOTIFLAC_API_URL": "spotiflac_api_url",
            "TOP_CACHE_LIMIT": "top_cache_limit",
        }
        for name, field in mapping.items():
            value = getattr(env, name, None)
            if value is not None:
                values[field] = str(value)
    settings = Settings(**values)
    if settings.environment.lower() == "production":
        if not settings.password_hash or not settings.password_salt:
            raise RuntimeError("PASSWORD_HASH and PASSWORD_SALT are required in production")
        if not settings.session_secret or len(settings.session_secret) < 32:
            raise RuntimeError("APP_SECRET must be a unique 32+ character secret in production")
        if not settings.worker_callback_secret or len(settings.worker_callback_secret) < 32:
            raise RuntimeError("CALLBACK_SECRET must be a unique 32+ character secret in production")
        if not settings.github_token:
            raise RuntimeError("GITHUB_TOKEN is required in production")
    return settings
