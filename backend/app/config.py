from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "dakshmusic3"
    environment: str = "development"
    api_prefix: str = "/api/v1"
    cors_origins: str = "http://localhost:5173"
    cloudflare_account_id: str = ""
    cloudflare_d1_database_id: str = ""
    cloudflare_api_token: str = ""
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = "dakshmusic3-audio"
    r2_endpoint: str = ""
    session_secret: str = "change-me"
    admin_password: str = ""
    github_token: str = ""
    github_repo: str = "dloiya/dakshmusic3"
    github_ref: str = "main"
    acquire_workflow: str = "acquire-audio.yml"
    model_config = SettingsConfigDict(env_file=".env", env_prefix="DAKSH_", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
