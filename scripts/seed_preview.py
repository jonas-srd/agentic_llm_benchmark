"""Create the inactive technical pilot through the admin API. No participant recruitment."""
import json
from pathlib import Path
import httpx
from app.config import get_settings


if __name__ == "__main__":
    settings = get_settings()
    config = json.loads(Path("examples/study.preview.json").read_text(encoding="utf-8"))
    response = httpx.post(f"{settings.public_base_url.rstrip('/')}/v1/admin/studies", json=config,
                          headers={"X-Admin-Key": settings.admin_api_key.get_secret_value()}, timeout=30)
    response.raise_for_status()
    print("Created inactive preview:", response.json()["id"])
