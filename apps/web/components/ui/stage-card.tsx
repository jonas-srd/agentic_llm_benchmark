import type { ReactNode } from "react";
export function StageCard({
  eyebrow,
  title,
  description,
  children,
  wide = false,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`stage-card${wide ? " wide" : ""}`}>
      <div className="stage-heading">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="lede">{description}</p>}
      </div>
      {children}
    </section>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <div className="error-notice" role="alert">
      {message}
    </div>
  ) : null;
}
