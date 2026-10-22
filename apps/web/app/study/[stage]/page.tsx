import { redirect } from "next/navigation";
import { getSession } from "@/lib/backend";
import { stagePath, stageSlug } from "@clinical/shared";
import { StudyStage } from "@/components/stages/registry";
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
  if (!session) redirect("/");
  if (stage !== stageSlug(session)) redirect(stagePath(session));
  return <StudyStage session={session} />;
}
