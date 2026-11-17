import { CONFIDENCE_LABELS, DEFAULT_CONFIDENCE } from "@clinical/shared";

export function ConfidenceSlider({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const selected = value ?? DEFAULT_CONFIDENCE;
  const id = "diagnosis-confidence";
  return (
    <div className="confidence-field">
      <div className="confidence-heading">
        <label htmlFor={id}>Confidence</label>
        <output htmlFor={id}>{selected} / 7</output>
      </div>
      <input
        id={id}
        type="range"
        min={1}
        max={7}
        step={1}
        aria-label="Confidence"
        aria-valuetext={`${selected} of 7: ${CONFIDENCE_LABELS[selected - 1]}`}
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="confidence-ticks" aria-hidden="true">
        {CONFIDENCE_LABELS.map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <div className="scale-anchors" aria-hidden="true">
        <span>Not at all confident</span>
        <span>Extremely confident</span>
      </div>
    </div>
  );
}
