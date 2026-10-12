import { createServerFn } from "@tanstack/react-start";

/** Read the Railway account, its projects and the state of every service. */
export const railwayStatus = createServerFn({ method: "POST" }).handler(async () => {
  const { requireStaff } = await import("./auth-guard.server");
  await requireStaff();
  try {
    const { loadProjects, railwayToken } = await import("./railway.server");
    if (!railwayToken()) return { ok: false as const, error: "Railway token is not set yet." };
    const data = await loadProjects();
    return { ok: true as const, ...data };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Railway failed" };
  }
});

type Action = { serviceId?: string; environmentId?: string; action?: "redeploy" | "restart" };

/** Redeploy or restart one Railway service. */
export const railwayAction = createServerFn({ method: "POST" })
  .inputValidator((input: Action) => ({
    serviceId: String(input?.serviceId || ""),
    environmentId: String(input?.environmentId || ""),
    action: input?.action === "restart" ? ("restart" as const) : ("redeploy" as const),
  }))
  .handler(async ({ data }) => {
    const { requireStaff } = await import("./auth-guard.server");
    await requireStaff();
    if (!data.serviceId || !data.environmentId)
      return { ok: false as const, error: "Pick a service first." };
    try {
      const { redeployService, restartService } = await import("./railway.server");
      if (data.action === "restart") await restartService(data.serviceId, data.environmentId);
      else await redeployService(data.serviceId, data.environmentId);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : "Railway failed" };
    }
  });
