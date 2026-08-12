import {
  getSemanticView,
  SemanticViewValidationError,
} from "@/semantic-view/service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ viewKey: string }> },
) {
  const { viewKey } = await context.params;
  try {
    return Response.json(await getSemanticView(viewKey));
  } catch (error) {
    if (error instanceof SemanticViewValidationError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[semantic-view.read]", { viewKey, error });
    return Response.json(
      { error: "无法读取 Business View。" },
      { status: 500 },
    );
  }
}
