from pydantic_settings import BaseSettings, SettingsConfigDict
from .connectors.cloudflare.bindings import get_worker_env


class Settings(BaseSettings):
    app_name: str = "dakshmusic3"
    environment: str = "development"
    api_prefix: str = "/api/v1"
    cors_origins: str = "http://localhost:5173"
    cloudflare_account_id: str = ""
    cloudflare_d1_database_id: str = "3f384751-424c-4628-ac18-384c068afd8b"
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
    worker_public_url: str = ""
    worker_callback_secret: str = ""
    spotiflac_api_url: str = ""
    model_config = SettingsConfigDict(env_file=".env", env_prefix="DAKSH_", extra="ignore")


def get_settings() -> Settings:
    values={}
    env=get_worker_env()
    if env is not None:
        mapping={
            "DAKSH_ADMIN_PASSWORD":"admin_password","DAKSH_GITHUB_TOKEN":"github_token",
            "DAKSH_WORKER_PUBLIC_URL":"worker_public_url","DAKSH_WORKER_CALLBACK_SECRET":"worker_callback_secret",
            "DAKSH_SPOTIFLAC_API_URL":"spotiflac_api_url","DAKSH_CORS_ORIGINS":"cors_origins",
            "DAKSH_ENVIRONMENT":"environment","DAKSH_SESSION_SECRET":"session_secret",
        }
        for name,field in mapping.items():
            value=getattr(env,name,None)
            if value is not None: values[field]=str(value)
    return Settings(**values)
