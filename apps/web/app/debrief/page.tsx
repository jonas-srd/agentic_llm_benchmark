import { redirect } from "next/navigation";
import { StudyHeader } from "@/components/study-header";
import { StageCard } from "@/components/ui/stage-card";
import { StudyDebrief } from "@/components/study-debrief";

export const dynamic = "force-dynamic";

export default function DebriefPreviewPage() {
  if (process.env.APP_ENV === "production") redirect("/");
  return (
    <>
      <StudyHeader step={0} total={0} subtitle="Debrief" preview />
      <main className="page-shell">
        <StageCard
          eyebrow="DEBRIEF PREVIEW"
          title="Thank you for taking part"
          description="This is a preview of the information shown after the questionnaire."
        >
          <StudyDebrief />
          <p>
            At the end of a research session, you can choose whether your
            responses may be included in the analysis. Either choice lets you
            complete the study and return to Prolific. Test sessions are
            excluded automatically.
          </p>
          <div className="action-row">
            <a href="/post-survey">View post-survey</a>
            <a href="/">Back to study</a>
          </div>
        </StageCard>
      </main>
    </>
  );
}
