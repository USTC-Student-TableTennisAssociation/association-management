import { currentAuthUser } from "@/auth/session";
import { getDatabase } from "@/db";
import { extensionRegistry } from "@/shell/composition-root";
import { installedViewService } from "@/shell/composition-root";

export async function GET() {
  const user = await currentAuthUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  await installedViewService.synchronize();
  const installed = await getDatabase().installedView.findMany({
    orderBy: { viewKey: "asc" },
    select: {
      viewKey: true,
      pluginVersion: true,
      schemaVersion: true,
      stateVersion: true,
      status: true,
      settingsJson: true,
    },
  });
  return Response.json({
    views: installed.flatMap((state) => {
      const viewModule = extensionRegistry.getView(state.viewKey);
      const presentationExtension = extensionRegistry.listPresentations()
        .find((candidate) =>
          candidate.targetView === state.viewKey &&
          candidate.schemaVersion === state.schemaVersion
        );
      const presentation = presentationExtension?.presentations[0];
      return viewModule
        ? [{
            ...state,
            stateVersion: state.stateVersion.toString(),
            label: viewModule.manifest.label,
            specializedLabel: viewModule.manifest.specializedLabel,
            description: viewModule.manifest.description,
            ...(presentation ? { presentation } : {}),
          }]
        : [];
    }),
  });
}
