import type { WorkspaceData } from "../domain/workspace";
import type { TechnicalCatalog } from "../domain/technical-catalog";

export type DataReader<T> = () => Promise<T>;
export interface WorkspaceReaders {
  readWorkspace: DataReader<WorkspaceData>;
  readTechnicalCatalog: DataReader<TechnicalCatalog>;
}
export interface ScenarioMetadata {
  id: string;
  asOf: string;
  currency: "BRL";
  monetaryUnit: "reais";
  readOnly: true;
  slices: { overview: string; sample: string; selection: string };
}
