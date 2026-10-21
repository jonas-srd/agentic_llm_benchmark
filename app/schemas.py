from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

MODEL_IDS = (
    "openai/gpt-6.1-sol",
    "anthropic/claude-sonnet-5.5",
    "qwen/qwen3.8-2.4t-a95b",
)
Identifier = Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")]
ProlificId = Annotated[str, Field(pattern=r"^[a-zA-Z0-9]{24}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Question(StrictModel):
    id: Identifier
    label: str = Field(min_length=1, max_length=1000)
    kind: Literal["text", "number", "boolean", "choice"] = "text"
    required: bool = True
    options: list[str] = Field(default_factory=list, max_length=30)
    minimum: float | None = None
    maximum: float | None = None

    @model_validator(mode="after")
    def validate_options(self):
        if self.kind == "choice" and not self.options:
            raise ValueError("Choice questions need options")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("Invalid numeric bounds")
        return self


class StudyStep(StrictModel):
    id: Identifier
    title: str = Field(min_length=1, max_length=200)
    kind: Literal["information", "questionnaire", "simulation", "final_check"]
    instructions: str = Field(default="", max_length=10000)
    questions: list[Question] = Field(default_factory=list, max_length=50)
    case_id: Identifier | None = None

    @model_validator(mode="after")
    def unique_questions(self):
        if len({q.id for q in self.questions}) != len(self.questions):
            raise ValueError("Question IDs must be unique")
        if self.kind == "simulation" and not self.case_id:
            raise ValueError("Simulation needs a case")
        return self


class CaseSpec(StrictModel):
    id: Identifier
    title: str = Field(min_length=1, max_length=200)
    opening: str = Field(min_length=1, max_length=3000)
    patient_facts: str = Field(min_length=1, max_length=12000)
    labs: dict[str, str] = Field(default_factory=dict, max_length=50)
    reference_diagnosis: str = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def bounded_labs(self):
        if any(len(k) > 100 or len(v) > 2000 for k, v in self.labs.items()):
            raise ValueError("Lab entries too long")
        return self


class StudyConfig(StrictModel):
    id: Identifier
    title: str = Field(min_length=1, max_length=200)
    version: str = Field(default="1", min_length=1, max_length=40)
    consent_version: str = Field(default="1", min_length=1, max_length=40)
    consent_text: str = Field(min_length=1, max_length=20000)
    prolific_study_id: ProlificId | None = None
    completion_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9]{4,30}$")
    max_participants: int = Field(default=100, ge=1, le=10000)
    max_doctor_turns: int = Field(default=6, ge=2, le=12)
    conditions: list[Identifier] = Field(default=["Agent_Simulation"], min_length=1, max_length=10)
    models: list[str] = Field(default_factory=lambda: list(MODEL_IDS), min_length=1, max_length=3)
    steps: list[StudyStep] = Field(min_length=1, max_length=40)
    cases: list[CaseSpec] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def validate_structure(self):
        if len(set(self.models)) != len(self.models) or not set(self.models) <= set(MODEL_IDS):
            raise ValueError("Use unique, approved OpenRouter model IDs")
        for items in (self.steps, self.cases):
            if len({item.id for item in items}) != len(items):
                raise ValueError("IDs must be unique")
        if len(set(self.conditions)) != len(self.conditions):
            raise ValueError("Conditions must be unique")
        case_ids = {c.id for c in self.cases}
        if any(s.kind == "simulation" and s.case_id not in case_ids for s in self.steps):
            raise ValueError("Unknown simulation case")
        if self.steps[-1].kind != "final_check" or any(s.kind == "final_check" for s in self.steps[:-1]):
            raise ValueError("Exactly one final_check must finish the study")
        return self


class Enroll(StrictModel):
    PROLIFIC_PID: ProlificId
    STUDY_ID: ProlificId
    SESSION_ID: ProlificId
    consent: Literal[True]
    consent_version: str = Field(min_length=1, max_length=40)


class Answer(StrictModel):
    request_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    revision: int = Field(ge=0)
    answers: dict = Field(default_factory=dict, max_length=50)
    include_in_analysis: bool | None = None


class DoctorAction(StrictModel):
    action: Literal["ask_patient", "order_lab", "diagnosis"]
    message: str = Field(min_length=1, max_length=6000)
    tests: list[str] = Field(default_factory=list, max_length=10)
    diagnosis: str | None = Field(default=None, max_length=2000)
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def valid_action(self):
        if self.action == "order_lab" and not self.tests:
            raise ValueError("Specify lab tests")
        if self.action == "diagnosis" and (not self.diagnosis or self.confidence is None):
            raise ValueError("Diagnosis and confidence required")
        return self
