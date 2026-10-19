import type { WorkspaceReaders } from "./readers";
import { workspaceDataSchema } from "../domain/workspace-schema";
import { technicalCatalogSchema } from "../domain/technical-catalog";

export function createReadServices(readers: WorkspaceReaders): WorkspaceReaders {
  return Object.freeze({
    readWorkspace: async () => workspaceDataSchema.parse(await readers.readWorkspace()),
    readTechnicalCatalog: async () => technicalCatalogSchema.parse(await readers.readTechnicalCatalog()),
  });
}
