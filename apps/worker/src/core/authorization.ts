import type {
  AuthenticatedIdentity,
  PagePermission,
} from "@nago-wiki/shared";
import {
  clampPermissionToWorkspaceRole,
  type D1WikiRepository,
} from "./repository";

export class AuthorizationService {
  public constructor(private readonly repository: D1WikiRepository) {}

  public async effectivePermission(
    identity: AuthenticatedIdentity,
    pageId: string,
  ): Promise<PagePermission> {
    if (identity.status !== "active") return "none";
    const page = await this.repository.getPage(pageId);
    if (page?.workspaceId !== identity.workspaceId) return "none";
    if (identity.role === "owner") return "owner";

    const restrictedPermissions =
      await this.repository.getRestrictedAncestorPermissions(
        page.id,
        identity.workspaceId,
        identity.id,
      );
    if (restrictedPermissions.length === 0) {
      return identity.role;
    }
    if (restrictedPermissions.some((permission) => permission === null)) {
      return "none";
    }
    const aclPermission = restrictedPermissions.includes("viewer")
      ? "viewer"
      : "editor";
    return clampPermissionToWorkspaceRole(identity.role, aclPermission);
  }
}

export function canEdit(permission: PagePermission): boolean {
  return permission === "owner" || permission === "editor";
}

export function canView(permission: PagePermission): boolean {
  return permission !== "none";
}
