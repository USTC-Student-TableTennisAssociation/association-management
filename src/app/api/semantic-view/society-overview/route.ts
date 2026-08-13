import { getSocietyInformation } from "@/semantic-view/service";

/** @deprecated Use /api/semantic-view/society_information. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getSocietyInformation());
  } catch (error) {
    console.error("[semantic-view.legacy-society-overview]", error);
    return Response.json(
      { error: "无法读取社团信息。" },
      { status: 500 },
    );
  }
}
