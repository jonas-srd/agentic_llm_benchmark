"use client";
import { questionVisible, type StudyStep } from "@clinical/shared";
export function QuestionnaireFields({
  questions,
  answers,
  onChange,
  disabled = false,
}: {
  questions: StudyStep["questions"];
  answers: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {questions
        .filter((q) => questionVisible(q, answers))
        .map((q) => (
          <div className="field" key={q.id}>
            {q.section && <h2 className="survey-section">{q.section}</h2>}
            {q.kind === "likert" ? (
              <fieldset className="survey-likert" disabled={disabled}>
                <legend>{q.label}</legend>
                <div
                  className="likert-options"
                  style={{
                    gridTemplateColumns: `repeat(${(q.maximum ?? 7) - (q.minimum ?? 1) + 1}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from(
                    { length: (q.maximum ?? 7) - (q.minimum ?? 1) + 1 },
                    (_, index) => index + (q.minimum ?? 1),
                  ).map((value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={q.id}
                        value={value}
                        required={q.required}
                        checked={answers[q.id] === value}
                        aria-label={`${value} of ${q.maximum ?? 7}${value === (q.minimum ?? 1) ? `: ${q.lower_label}` : value === (q.maximum ?? 7) ? `: ${q.upper_label}` : ""}`}
                        onChange={() => onChange(q.id, value)}
                      />
                      <span aria-hidden="true">{value}</span>
                    </label>
                  ))}
                </div>
                <div className="scale-anchors">
                  <span>{q.lower_label}</span>
                  <span>{q.upper_label}</span>
                </div>
              </fieldset>
            ) : q.kind === "multiple_choice" ? (
              <fieldset className="survey-multiple" disabled={disabled}>
                <legend>{q.label}</legend>
                {q.options.map((option, index) => {
                  const selected = Array.isArray(answers[q.id])
                    ? (answers[q.id] as string[])
                    : [];
                  return (
                    <label className="check-line" key={option}>
                      <input
                        type="checkbox"
                        name={q.id}
                        value={option}
                        checked={selected.includes(option)}
                        ref={
                          index === 0
                            ? (input) => {
                                input?.setCustomValidity(
                                  q.required && selected.length === 0
                                    ? "Select at least one option."
                                    : "",
                                );
                              }
                            : undefined
                        }
                        onChange={(event) =>
                          onChange(
                            q.id,
                            event.target.checked
                              ? [...selected, option]
                              : selected.filter((value) => value !== option),
                          )
                        }
                      />
                      <span>{option}</span>
                    </label>
                  );
                })}
              </fieldset>
            ) : q.kind === "boolean" && q.id === "physician" ? (
              <label className="check-line">
                <input
                  type="checkbox"
                  required={q.required}
                  checked={answers[q.id] === true}
                  onChange={(e) => onChange(q.id, e.target.checked)}
                />
                <span>{q.label}</span>
              </label>
            ) : q.kind === "boolean" ? (
              <fieldset className="boolean-question" disabled={disabled}>
                <legend>{q.label}</legend>
                {[true, false].map((choice) => (
                  <label key={String(choice)}>
                    <input
                      type="radio"
                      name={q.id}
                      required={q.required}
                      checked={answers[q.id] === choice}
                      onChange={() => onChange(q.id, choice)}
                    />
                    {choice ? "Yes" : "No"}
                  </label>
                ))}
              </fieldset>
            ) : (
              <>
                <label htmlFor={q.id}>
                  {q.label}
                  {!q.required && <span className="optional"> (optional)</span>}
                </label>
                {q.kind === "choice" ? (
                  <select
                    id={q.id}
                    disabled={disabled}
                    required={q.required}
                    value={String(answers[q.id] ?? "")}
                    onChange={(e) => onChange(q.id, e.target.value)}
                  >
                    <option value="" disabled>
                      Select an option
                    </option>
                    {q.options.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                ) : q.kind === "text" && q.id === "feedback" ? (
                  <textarea
                    id={q.id}
                    rows={3}
                    disabled={disabled}
                    maxLength={6000}
                    required={q.required}
                    value={String(answers[q.id] ?? "")}
                    onChange={(e) => onChange(q.id, e.target.value)}
                  />
                ) : (
                  <input
                    id={q.id}
                    type={q.kind === "number" ? "number" : "text"}
                    min={q.minimum ?? undefined}
                    max={q.maximum ?? undefined}
                    step={q.integer ? 1 : "any"}
                    disabled={disabled}
                    maxLength={6000}
                    required={q.required}
                    value={String(answers[q.id] ?? "")}
                    onChange={(e) =>
                      onChange(
                        q.id,
                        q.kind === "number" && e.target.value !== ""
                          ? Number(e.target.value)
                          : e.target.value,
                      )
                    }
                  />
                )}
              </>
            )}
          </div>
        ))}
    </>
  );
}
