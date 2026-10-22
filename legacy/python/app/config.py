from functools import lru_cache
from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    app_env: str = "development"
    database_url: str = "sqlite:///./benchmark.db"
    admin_api_key: SecretStr = SecretStr("")
    session_secret: SecretStr = SecretStr("")
    openrouter_api_key: SecretStr = SecretStr("")
    cors_origins: list[str] = ["http://localhost:3000"]
    public_base_url: str = "http://localhost:8000"
    llm_timeout_seconds: int = 90
    llm_max_tokens: int = 1800
    worker_poll_seconds: float = 2

    @model_validator(mode="after")
    def check_secrets(self):
        for name in ("admin_api_key", "session_secret"):
            if len(getattr(self, name).get_secret_value()) < 32:
                raise ValueError(f"{name.upper()} must contain at least 32 characters")
        if self.app_env == "production" and not self.database_url.startswith("postgres"):
            raise ValueError("Production requires PostgreSQL")
        if not 10 <= self.llm_timeout_seconds <= 120:
            raise ValueError("LLM timeout must be between 10 and 120 seconds")
        return self


@lru_cache
def get_settings():
    return Settings()
