export interface ImportWorkflowParams {
  importId: string;
  workspaceId: string;
  requestedBy: string;
}

/** Durable import orchestration; conversion steps are added by the import slice. */
export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportWorkflowParams> {
  public override async run(
    event: Readonly<WorkflowEvent<ImportWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ importId: string; status: "accepted" }> {
    return step.do("accept import", () =>
      Promise.resolve({ importId: event.payload.importId, status: "accepted" as const }),
    );
  }
}
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
