import workspaceSeed from "../../lib/db/demo-seed.json";
import technicalSeed from "../../lib/db/technical-catalog-seed.json";
import { parseWorkspaceRecords } from "../../domain/workspace-schema";
import { technicalCatalogSchema } from "../../domain/technical-catalog";
import { createReadServices } from "../../application/read-services";
import type { ScenarioMetadata, WorkspaceReaders } from "../../application/readers";

type ScenarioSources = { records: { id: string; kind: string; payload: unknown }[]; technical: unknown };

export function createDemoReaders(sources: ScenarioSources): WorkspaceReaders {
  return createReadServices({
    readWorkspace: async () => parseWorkspaceRecords(sources.records),
    readTechnicalCatalog: async () => technicalCatalogSchema.parse(sources.technical),
  });
}

export const demoReaders = createDemoReaders({ records: workspaceSeed.records, technical: technicalSeed.payload });

export async function readScenarioMetadata(): Promise<ScenarioMetadata> {
  const data = await demoReaders.readWorkspace();
  return {
    id: "nexo-existing-scenario-v1", asOf: data.snapshot.asOf, currency: "BRL", monetaryUnit: "reais", readOnly: true,
    slices: { overview: "Panorama agregado do cenário", sample: "Amostra de registros disponível", selection: "Seleção após aplicação dos filtros" },
  };
}
