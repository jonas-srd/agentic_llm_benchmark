import { getSession, getStudy } from "@/lib/backend";
import { IntroStage } from "@/components/stages/intro";
import { StageCard } from "@/components/ui/stage-card";
import { redirect } from "next/navigation";
import { stagePath } from "@clinical/shared";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const study = typeof params.study === "string" ? params.study : undefined;
  const session = await getSession();
  if (session && !study) redirect(stagePath(session));
  try {
    const info = await getStudy(study);
    const ids = Object.fromEntries(
      ["PROLIFIC_PID", "STUDY_ID", "SESSION_ID"].map((k) => [
        k,
        typeof params[k] === "string" ? params[k] : "",
      ]),
    );
    return (
      <IntroStage info={info} existing={session} ids={ids} study={study} />
    );
  } catch {
    return (
      <main className="page-shell">
        <StageCard
          eyebrow="CLINICAL REASONING STUDY"
          title="Study unavailable"
          description={
            study
              ? "Please check your Prolific link, or try again shortly."
              : "Test access is temporarily unavailable. Please try again shortly."
          }
        >
          <a className="button" href="">
            Try again
          </a>
        </StageCard>
      </main>
    );
  }
}
