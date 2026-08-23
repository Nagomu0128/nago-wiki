// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminMember, PageResource, SessionUser, WikiApi } from "../api";
import { flushUi, renderView, type RenderedView } from "../test/render";
import { SettingsDrawer } from "./SettingsDrawer";

const owner: SessionUser = {
  id: "20000000-0000-4000-8000-000000000001",
  displayName: "Owner",
  email: "owner@example.com",
  role: "owner",
};
const editor: AdminMember = {
  id: "20000000-0000-4000-8000-000000000002",
  displayName: "Editor",
  email: "editor@example.com",
  role: "editor",
  status: "active",
  linkedBotProviders: [],
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};
const restrictedPage = {
  page: {
    id: "30000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    parentId: null,
    slug: "secret",
    title: "Secret",
    bodyMd: "private",
    revision: 1,
    contentHash: "a".repeat(64),
    accessMode: "restricted",
    status: "active",
    createdBy: owner.id,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    trashedAt: null,
  },
  permission: "owner",
  tags: [],
} satisfies PageResource;

describe("SettingsDrawer", () => {
  let view: RenderedView | undefined;
  afterEach(() => { view?.unmount(); view = undefined; });

  it("lets an owner update a member and a restricted page ACL", async () => {
    const updateAdminMember = vi.fn().mockResolvedValue({ ...editor, role: "viewer" });
    const replacePageAcl = vi.fn().mockResolvedValue({
      pageId: restrictedPage.page.id,
      revision: 1,
      updatedAt: "2026-08-18T00:01:00.000Z",
      entries: [{ ...editor, userId: editor.id, permission: "editor" }],
    });
    const api = {
      getLinkedBotAccounts: vi.fn().mockResolvedValue([]),
      getAdminMembers: vi.fn().mockResolvedValue([editor]),
      getBotSettings: vi.fn().mockResolvedValue([
        { provider: "discord", enabled: true, channels: [] },
        { provider: "line", enabled: true, channels: [] },
      ]),
      getPageAcl: vi.fn().mockResolvedValue({
        pageId: restrictedPage.page.id,
        revision: 0,
        updatedAt: null,
        entries: [],
      }),
      updateAdminMember,
      replacePageAcl,
    } as unknown as WikiApi;
    view = await renderView(<SettingsDrawer api={api} currentPage={restrictedPage} user={owner} />);
    await flushUi();

    const role = view.container.querySelector<HTMLSelectElement>("select[aria-label='Editorのロール']");
    if (!role) throw new Error("member role control was not rendered");
    act(() => {
      role.value = "viewer";
      role.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const memberSave = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "保存");
    if (!memberSave) throw new Error("member save was not rendered");
    act(() => { memberSave.click(); });
    await flushUi();
    expect(updateAdminMember).toHaveBeenCalledWith(
      editor.id,
      { role: "viewer", status: "active", expectedUpdatedAt: editor.updatedAt },
      expect.any(AbortSignal),
    );

    const permission = view.container.querySelector<HTMLSelectElement>("select[aria-label='Editorのページ権限']");
    if (!permission) throw new Error("ACL control was not rendered");
    act(() => {
      permission.value = "editor";
      permission.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const aclSave = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "ACLを保存");
    if (!aclSave) throw new Error("ACL save was not rendered");
    act(() => { aclSave.click(); });
    await flushUi();
    expect(replacePageAcl).toHaveBeenCalledWith(
      restrictedPage.page.id,
      { baseRevision: 0, entries: [{ userId: editor.id, permission: "editor" }] },
      expect.any(AbortSignal),
    );
  });

  it("does not request owner-only data for a viewer", async () => {
    const getAdminMembers = vi.fn();
    const getBotSettings = vi.fn();
    const getPageAcl = vi.fn();
    const api = {
      getLinkedBotAccounts: vi.fn().mockResolvedValue([]),
      getAdminMembers,
      getBotSettings,
      getPageAcl,
    } as unknown as WikiApi;
    view = await renderView(
      <SettingsDrawer api={api} user={{ ...owner, role: "viewer" }} />,
    );
    await flushUi();

    expect(getAdminMembers).not.toHaveBeenCalled();
    expect(getBotSettings).not.toHaveBeenCalled();
    expect(getPageAcl).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Ownerが管理できます");
  });
});
