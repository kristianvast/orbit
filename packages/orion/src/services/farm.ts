import type { DbMutateRequest, DbMutateResult, DbMutationParams } from "@orbit/protocol";
import type { Repository, WriteOrigin } from "../db/repo";
import type { SecretStore } from "../secrets";
import { CameraService } from "./cameras";
import { ConnectorService } from "./connectors";

/** Named mutations shared by db.mutate (UI) and the agent's farm tools. */
export class FarmService {
  readonly connectors: ConnectorService;
  readonly cameras: CameraService;

  constructor(
    readonly repo: Repository,
    readonly secrets: SecretStore,
    readonly workspace: string,
    connectorTemplateDir: string | null = null,
  ) {
    this.connectors = new ConnectorService(repo, secrets, workspace, connectorTemplateDir);
    this.cameras = new CameraService(repo, secrets);
  }

  async mutate(req: DbMutateRequest, origin?: Partial<WriteOrigin>): Promise<DbMutateResult> {
    switch (req.mutation) {
      case "animals.upsert":
        return this.repo.upsertAnimal(req.params.animal, origin);
      case "devices.upsert":
        return this.repo.upsertDevice(req.params.device, origin);
      case "bindings.set":
        return this.repo.setBinding(req.params.deviceId, req.params.animalId, origin);
      case "bindings.clear":
        return this.repo.clearBinding(req.params.deviceId, origin);
      case "connectors.upsert":
        return this.upsertConnector(req.params, origin);
      case "connectors.syncNow": {
        await this.connectors.run(req.params.id);
        return { ids: [req.params.id], snapshotId: null };
      }
      case "cameras.upsert":
        return this.cameras.upsert(req.params.camera, origin);
    }
  }

  private async upsertConnector(
    params: DbMutationParams<"connectors.upsert">,
    origin?: Partial<WriteOrigin>,
  ): Promise<DbMutateResult> {
    const { secret, ...connector } = params.connector;
    const id = connector.id ?? crypto.randomUUID();
    let credentialRef: string | undefined;
    if (secret !== undefined) {
      credentialRef = `connector:${id}`;
      await this.secrets.set(credentialRef, secret);
    }
    return this.repo.upsertConnector(
      { ...connector, ...(credentialRef ? { credentialRef } : {}) },
      origin,
      connector.id ? undefined : id,
    );
  }
}
