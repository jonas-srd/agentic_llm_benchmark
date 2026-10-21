import json
import os
import uuid
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema
from app.config import Settings
from app.db import Base, make_engine
from app.main import create_app
from app import models  # noqa: F401


@pytest.fixture
def env(tmp_path):
    settings = Settings(_env_file=None, admin_api_key="a" * 40, session_secret="b" * 40,
                        openrouter_api_key="test-key",
                        database_url=os.getenv("TEST_DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}"))
    base_engine = make_engine(settings.database_url)
    schema = None
    engine = base_engine
    if settings.database_url.startswith("postgres"):
        schema = "test_" + uuid.uuid4().hex
        with base_engine.begin() as connection:
            connection.execute(CreateSchema(schema))
        engine = base_engine.execution_options(schema_translate_map={None: schema})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with TestClient(create_app(settings, factory)) as client:
        yield client, factory, settings
    if schema:
        with base_engine.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
    base_engine.dispose()


@pytest.fixture
def study():
    return json.loads(Path("examples/study.preview.json").read_text(encoding="utf-8"))


def enroll(client, study, pid="a" * 24):
    headers = {"X-Admin-Key": "a" * 40}
    created = client.post("/v1/admin/studies", json=study, headers=headers)
    assert created.status_code in (201, 409), created.text
    response = client.post(f"/v1/studies/{study['id']}/sessions", json={
        "PROLIFIC_PID": pid, "STUDY_ID": "b" * 24, "SESSION_ID": "c" * 24,
        "consent": True, "consent_version": study["consent_version"],
    }, headers=headers)
    assert response.status_code == 201, response.text
    state = response.json()
    return state, {"Authorization": f"Bearer {state['session_token']}"}
