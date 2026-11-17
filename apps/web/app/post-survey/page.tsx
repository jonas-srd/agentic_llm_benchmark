import { redirect } from "next/navigation";
import { PostSurveyPreview } from "@/components/post-survey-preview";

export const dynamic = "force-dynamic";

export default function PostSurveyPage() {
  if (process.env.APP_ENV === "production") redirect("/");
  return <PostSurveyPreview />;
}
