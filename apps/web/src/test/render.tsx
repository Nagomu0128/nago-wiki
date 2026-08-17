import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderedView {
  container: HTMLDivElement;
  root: Root;
  unmount(): void;
}

export function renderView(node: ReactNode): Promise<RenderedView> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return Promise.resolve({
    container,
    root,
    unmount() {
      act(() => { root.unmount(); });
      container.remove();
    },
  });
}

export async function flushUi() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => { window.setTimeout(resolve, 0); });
  });
}

export function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value") as TypedPropertyDescriptor<string> | undefined;
    if (descriptor?.set) Reflect.apply(descriptor.set, element, [value]);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
