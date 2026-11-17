export function ResponseProgress({
  target,
}: {
  target: "auto" | "patient" | "lab" | "both";
}) {
  return (
    <div className="response-progress" role="status">
      <span className="response-spinner" aria-hidden="true" />
      <span>
        {target === "patient"
          ? "Patient is replying…"
          : target === "lab"
            ? "Lab is preparing results…"
            : "Preparing your reply…"}
      </span>
    </div>
  );
}
