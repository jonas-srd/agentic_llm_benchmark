"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="page-shell">
      <section className="stage-card">
        <h1>Let’s reconnect</h1>
        <p>
          Your submitted answers are saved. Please try loading this step again.
        </p>
        <button onClick={reset}>Try again</button>
      </section>
    </main>
  );
}
