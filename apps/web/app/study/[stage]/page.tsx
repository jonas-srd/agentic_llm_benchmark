import { redirect } from "next/navigation";
import { getSession } from "@/lib/backend";
import { stagePath, stageSlug } from "@clinical/shared";
import { StudyStage } from "@/components/stages/registry";
import { StageCard } from "@/components/ui/stage-card";
export const dynamic = "force-dynamic";
export default async function StagePage({
  params,
  searchParams,
}: {
  params: Promise<{ stage: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { stage } = await params;
  if (stage === "intro") {
    const raw = await searchParams;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(raw))
      if (typeof v === "string") qs.set(k, v);
    redirect(`/?${qs}`);
  }
  const session = await getSession();
  if (!session && process.env.APP_ENV === "production")
    return (
      <main className="page-shell">
        <StageCard
          title="Reopen your study link"
          description="For a Prolific study, reopen your personal link from Prolific in the browser where you started. For a practice session, return to the website home page."
        />
      </main>
    );
  if (!session) redirect("/");
  if (stage !== stageSlug(session)) redirect(stagePath(session));
  return <StudyStage session={session} />;
}
