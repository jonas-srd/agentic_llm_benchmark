import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
import httpx
import pytest
from sqlalchemy import select
from app.models import AgentMessage, AgentRun, ParticipantSession, Study
from app.openrouter import OpenRouter, ProviderError
from app.schemas import MODEL_IDS, StudyConfig
from app.worker import claim_run, process_run
from tests.conftest import enroll


class FakeProvider:
    def __init__(self):
        self.calls = []
        self.doctor_calls = 0

    def complete(self, model, messages, json_output=False):
        self.calls.append((model, messages))
        if json_output:
            options = [
                {"action": "ask_patient", "message": "How long have you felt tired?"},
                {"action": "order_lab", "message": "Order tests", "tests": ["cbc", "ferritin"]},
                {"action": "diagnosis", "message": "Evidence reviewed", "diagnosis": "Iron deficiency anemia",
                 "confidence": 0.9},
            ]
            content = json.dumps(options[self.doctor_calls])
            self.doctor_calls += 1
        else:
            content = "The provided facts were reviewed."
        return {"content": content, "requested_model": model, "returned_model": model,
                "provider": "test", "generation_id": "test-id", "usage": {"total_tokens": 10}, "latency_ms": 1}


def submit(client, state, headers, answers=None, include=None, request_id=None):
    return client.post(f"/v1/sessions/{state['id']}/steps/{state['step']['id']}", headers=headers, json={
        "request_id": request_id or str(uuid.uuid4()), "revision": state["revision"],
        "answers": answers or {}, "include_in_analysis": include,
    })


def reach_run(client, study):
    state, headers = enroll(client, study)
    state = submit(client, state, headers).json()
    state = submit(client, state, headers, {"ai_familiarity": 3}).json()
    response = client.post(f"/v1/sessions/{state['id']}/runs", headers=headers)
    assert response.status_code == 202, response.text
    return state, headers, response.json()["id"]


def test_end_to_end_and_no_payment_penalty_for_exclusion(env, study):
    client, factory, _ = env
    study["completion_code"] = "TESTCODE"
    state, headers, run_id = reach_run(client, study)
    assert submit(client, state, headers).status_code == 409
    provider = FakeProvider()
    assert claim_run(factory, "worker") == run_id
    process_run(factory, provider, run_id, "worker")
    run = client.get(f"/v1/sessions/{state['id']}/runs/{run_id}", headers=headers).json()
    assert run["status"] == "succeeded"
    assert [m["role"] for m in run["messages"]] == ["doctor", "patient", "doctor", "lab", "doctor"]
    assert len({model for model, _ in provider.calls}) == 1
    assert "reference_diagnosis" not in json.dumps(provider.calls)
    assert "patient_facts" not in json.dumps(provider.calls[0])
    assert "Hemoglobin" not in json.dumps(provider.calls[1])
    assert "completion_url" not in state
    state = submit(client, state, headers).json()
    state = submit(client, state, headers, {"trust": 5}).json()
    assert submit(client, state, headers).status_code == 422
    state = submit(client, state, headers, include=False).json()
    assert state["status"] == "completed" and state["include_in_analysis"] is False
    assert state["completion_url"].endswith("cc=TESTCODE")
    exported = client.get(f"/v1/admin/studies/{study['id']}/export", headers={"X-Admin-Key": "a" * 40}).json()
    assert exported["sessions"][0]["runs"][0]["messages"][0]["requested_model"] in MODEL_IDS
    assert "token_hash" not in json.dumps(exported)


def test_private_study_requires_admin_and_consent(env, study):
    client, _, _ = env
    client.post("/v1/admin/studies", json=study, headers={"X-Admin-Key": "a" * 40})
    data = {"PROLIFIC_PID": "a" * 24, "STUDY_ID": "b" * 24, "SESSION_ID": "c" * 24,
            "consent": True, "consent_version": "pilot-1"}
    assert client.post(f"/v1/studies/{study['id']}/sessions", json=data).status_code == 401
    assert client.get(f"/v1/studies/{study['id']}?debug=1").status_code == 401
    data["consent"] = False
    assert client.post(f"/v1/studies/{study['id']}/sessions", json=data,
                       headers={"X-Admin-Key": "a" * 40}).status_code == 422


def test_no_model_or_condition_override(env, study):
    client, _, _ = env
    state, headers = enroll(client, study)
    assert "model_id" not in state and "snapshot" not in state
    assert client.get("/v1/admin/models").status_code == 401
    assert client.get(f"/v1/sessions/{state['id']}").status_code == 401
    assert client.get(f"/v1/sessions/{state['id']}", headers=headers).status_code == 200


def test_resume_and_idempotent_step_submission(env, study):
    client, _, _ = env
    state, headers = enroll(client, study)
    request_id = str(uuid.uuid4())
    first = submit(client, state, headers, request_id=request_id)
    second = submit(client, state, headers, request_id=request_id)
    assert first.json() == second.json()
    assert submit(client, state, headers).status_code == 409
    resumed = client.get(f"/v1/sessions/{state['id']}", headers=headers).json()
    assert resumed["step_index"] == 1
    resumed["revision"] = 0
    assert submit(client, resumed, headers, {"ai_familiarity": 3}).status_code == 409


def test_duplicate_enrollment_does_not_use_capacity(env, study):
    client, factory, _ = env
    enroll(client, study)
    response = client.post(f"/v1/studies/{study['id']}/sessions", json={
        "PROLIFIC_PID": "a" * 24, "STUDY_ID": "b" * 24, "SESSION_ID": "c" * 24,
        "consent": True, "consent_version": "pilot-1",
    }, headers={"X-Admin-Key": "a" * 40})
    assert response.status_code == 409
    with factory() as db:
        assert db.get(Study, study["id"]).enrolled == 1


def test_run_idempotency_and_cross_session_isolation(env, study):
    client, _, _ = env
    state, headers, run_id = reach_run(client, study)
    again = client.post(f"/v1/sessions/{state['id']}/runs", headers=headers)
    assert again.json()["id"] == run_id
    other, other_headers = enroll(client, study, pid="d" * 24)
    assert client.get(f"/v1/sessions/{state['id']}", headers=other_headers).status_code == 401
    assert client.get(f"/v1/sessions/{other['id']}/runs/{run_id}", headers=other_headers).status_code == 404


def test_concurrent_workers_claim_once(env, study):
    client, factory, _ = env
    _, _, run_id = reach_run(client, study)
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda i: claim_run(factory, str(i)), range(4)))
    assert claims.count(run_id) == 1


def test_abandoned_runs_are_not_silently_replayed(env, study):
    client, factory, _ = env
    _, _, run_id = reach_run(client, study)
    claim_run(factory, "old-worker")
    with factory() as db:
        run = db.get(AgentRun, run_id)
        run.lease_until = time.time() - 1
        db.commit()
    assert claim_run(factory, "new-worker") is None
    with factory() as db:
        assert db.get(AgentRun, run_id).status == "interrupted"


def test_provider_failure_is_saved_safely(env, study):
    client, factory, _ = env
    state, headers, run_id = reach_run(client, study)
    class Broken:
        def complete(self, *_args, **_kwargs):
            raise ProviderError("openrouter_http_401")
    claim_run(factory, "worker")
    process_run(factory, Broken(), run_id, "worker")
    result = client.get(f"/v1/sessions/{state['id']}/runs/{run_id}", headers=headers).json()
    assert result["status"] == "failed" and result["error_code"] == "openrouter_http_401"


def test_answer_validation_and_skip_protection(env, study):
    client, _, _ = env
    state, headers = enroll(client, study)
    assert submit(client, state, headers, {"unexpected": "x"}).status_code == 422
    state = submit(client, state, headers).json()
    for invalid in (True, 0, 8, "3", {}):
        assert submit(client, state, headers, {"ai_familiarity": invalid}).status_code == 422
    state["step"]["id"] = "test-probe"
    assert submit(client, state, headers, include=True).status_code == 409


def test_capacity_and_immutable_snapshot(env, study):
    client, factory, _ = env
    study["max_participants"] = 1
    state, _ = enroll(client, study)
    with factory() as db:
        session = db.get(ParticipantSession, state["id"])
        assert session.snapshot["max_participants"] == 1
    response = client.post(f"/v1/studies/{study['id']}/sessions", json={
        "PROLIFIC_PID": "d" * 24, "STUDY_ID": "b" * 24, "SESSION_ID": "e" * 24,
        "consent": True, "consent_version": "pilot-1",
    }, headers={"X-Admin-Key": "a" * 40})
    assert response.status_code == 409


def test_activation_requires_prolific_configuration(env, study):
    client, _, _ = env
    enroll(client, study)
    assert client.post(f"/v1/admin/studies/{study['id']}/activate",
                       headers={"X-Admin-Key": "a" * 40}).status_code == 409


def test_unknown_models_and_invalid_structure_rejected(study):
    study["models"] = ["auto"]
    with pytest.raises(ValueError):
        StudyConfig.model_validate(study)
    study["models"] = list(MODEL_IDS)
    study["steps"] = study["steps"][:-1]
    with pytest.raises(ValueError):
        StudyConfig.model_validate(study)


def test_provider_contract_no_fallback_no_unsupported_temperature(env):
    _, _, settings = env
    def handler(request):
        body = json.loads(request.content)
        assert body["provider"] == {"allow_fallbacks": False, "require_parameters": True}
        assert "temperature" not in body and "models" not in body
        return httpx.Response(200, json={"model": body["model"], "id": "g1", "usage": {}, "choices": [
            {"finish_reason": "stop", "message": {"content": "ok"}}]})
    provider = OpenRouter(settings, httpx.MockTransport(handler))
    for model in MODEL_IDS:
        assert provider.complete(model, [{"role": "user", "content": "test"}])["returned_model"] == model


@pytest.mark.parametrize("response,code", [
    (httpx.Response(401, text="sensitive provider details"), "openrouter_http_401"),
    (httpx.Response(200, json={"error": {"message": "private"}}), "openrouter_response_error"),
    (httpx.Response(200, json={"model": "wrong", "choices": [
        {"finish_reason": "stop", "message": {"content": "test"}}]}), "unexpected_model"),
    (httpx.Response(200, json={"choices": [
        {"finish_reason": "length", "message": {"content": "truncated"}}]}), "incomplete_completion"),
])
def test_provider_errors_are_sanitized(env, response, code):
    _, _, settings = env
    with pytest.raises(ProviderError, match=code):
        OpenRouter(settings, httpx.MockTransport(lambda _: response)).complete(MODEL_IDS[0], [])


def test_no_secret_or_truth_in_public_config(env, study):
    client, _, _ = env
    enroll(client, study)
    response = client.get(f"/v1/studies/{study['id']}", headers={"X-Admin-Key": "a" * 40})
    for forbidden in ("patient_facts", "reference_diagnosis", "completion_code", "openrouter", "labs"):
        assert forbidden not in response.text


def test_request_size_limit(env):
    client, _, _ = env
    assert client.post("/v1/admin/studies", content="x" * 256001).status_code == 413
