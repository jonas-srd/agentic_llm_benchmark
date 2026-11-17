import type { Metadata } from "next";
import { StageCard } from "@/components/ui/stage-card";

export const metadata: Metadata = {
  title: "Impressum / Legal notice | Clinical Reasoning Study",
  description:
    "Provider information and contact details for the clinical reasoning study.",
};

export default function LegalNotice() {
  return (
    <main className="page-shell legal-page">
      <a className="legal-back" href="/">
        ← Back to the study
      </a>
      <StageCard
        eyebrow="CLINICAL REASONING STUDY"
        title="Impressum / Legal notice"
        description="Provider information and contact details."
      >
        <div className="legal-contacts">
          <section aria-labelledby="project-contact">
            <h2 id="project-contact">Study contact</h2>
            <address>
              <strong>Prof. Dr. Stefan Feuerriegel</strong>
              <br />
              Institute of Artificial Intelligence (AI) in Management
              <br />
              LMU Munich School of Management
              <br />
              Ludwigstr. 28 / RG
              <br />
              80539 Munich, Germany
            </address>
            <p>
              <a href="mailto:feuerriegel@lmu.de">feuerriegel@lmu.de</a>
              <br />
              Institute office: <a href="tel:+498921806790">+49 89 2180-6790</a>
            </p>
            <p>
              Responsible for the study content: Prof. Dr. Stefan Feuerriegel,
              at the address above.
            </p>
          </section>
          <section aria-labelledby="service-provider">
            <h2 id="service-provider">Service provider</h2>
            <address>
              <strong>Ludwig-Maximilians-Universität München</strong>
              <br />
              Geschwister-Scholl-Platz 1<br />
              80539 Munich, Germany
            </address>
            <p>
              <a href="tel:+498921800">+49 89 2180-0</a>
              <br />
              <a href="mailto:poststelle@verwaltung.uni-muenchen.de">
                poststelle@verwaltung.uni-muenchen.de
              </a>
            </p>
            <p>
              LMU is a state institution of the Free State of Bavaria and a
              legal corporation under public law. Its legal representative is
              President Prof. Dr. med. Dr. h.c. Matthias H. Tschöp.
            </p>
          </section>
        </div>
        <section className="legal-details" aria-labelledby="legal-information">
          <h2 id="legal-information">Legal information</h2>
          <p>
            Information under Section 5 of the German Digital Services Act (DDG)
            and Section 18(2) of the German Interstate Media Treaty (MStV).
          </p>
          <p>
            <strong>Supervisory authority</strong>
            <br />
            Bavarian State Ministry of Science and the Arts
            <br />
            Salvatorstraße 2, 80327 Munich, Germany
            <br />
            <a href="https://www.stmwk.bayern.de/">Ministry website</a>
          </p>
          <p>
            <strong>VAT identification number:</strong> DE811205325
          </p>
          <p>
            Further institutional information, including secure communication
            options, is available in the{" "}
            <a href="https://www.lmu.de/de/footer/impressum/index.html">
              central LMU legal notice
            </a>
            .
          </p>
        </section>
        <p className="legal-sources">
          Official contact details:{" "}
          <a href="https://www.som.lmu.de/de/fakultaet/personenuebersicht/kontaktseite/stefan-feuerriegel-840c1071.html">
            LMU faculty profile
          </a>{" "}
          ·{" "}
          <a href="https://www.osc.lmu.de/people/people/stefan-feuerriegel.html">
            LMU Open Science Center
          </a>
        </p>
      </StageCard>
    </main>
  );
}
