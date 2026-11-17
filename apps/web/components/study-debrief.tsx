import { STUDY_DEBRIEF_SECTIONS } from "@clinical/shared";

export function StudyDebrief() {
  return (
    <section className="prose" aria-labelledby="study-debrief-title">
      <h2 id="study-debrief-title">About this study</h2>
      {STUDY_DEBRIEF_SECTIONS.map((section) => (
        <div key={section.title}>
          <h3>{section.title}</h3>
          <p>{section.text}</p>
        </div>
      ))}
      <h3>Questions about the study?</h3>
      <p>
        Contact Prof. Dr. Stefan Feuerriegel at{" "}
        <a href="mailto:feuerriegel@lmu.de">feuerriegel@lmu.de</a>. You can also
        contact the research team through Prolific.{" "}
        <a href="/impressum">Researcher details</a>.
      </p>
    </section>
  );
}
