export function StudyInstructions() {
  return (
    <>
      <ol className="instruction-list">
        <li>
          <span aria-hidden="true">1</span>
          <div>
            <h2>Read the patient case</h2>
            <p>
              Imagine a patient comes to your office. You are given some
              information about their symptoms, but not the full picture. Ask
              follow-up questions to identify the correct diagnosis.
            </p>
          </div>
        </li>
        <li>
          <span aria-hidden="true">2</span>
          <div>
            <h2>Ask the patient</h2>
            <p>
              Ask three questions, one at a time. You can ask about their history
              or request examination findings, tests or images.
            </p>
          </div>
        </li>
        <li>
          <span aria-hidden="true">3</span>
          <div>
            <h2>Enter your diagnosis</h2>
            <p>
              After the third answer, enter the single most likely diagnosis.
              Rate your confidence from 1 (not at all confident) to 7 (extremely
              confident).
            </p>
          </div>
        </li>
      </ol>
      <p>
        After all patient cases, complete a short questionnaire. There is no
        time limit.
      </p>
    </>
  );
}
