export interface GraphNodeData {
  id: string;
  label: string;
  filePath: string;
  modulePath: string;
  sourceUrl?: string;
  imports: string[];
  reexports: string[];
  importTargets: string[];
  reexportTargets: string[];
  importCount: number;
  reexportCount: number;
  exports: string[];
  exportCount: number;
  symbolUsers?: Record<string, string[]>;
  isVirtual?: boolean;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  kind: "import" | "reexport";
}

export interface GraphJson {
  root: string;
  generatedAt: string;
  elements: {
    nodes: Array<{ data: GraphNodeData }>;
    edges: Array<{ data: GraphEdgeData }>;
  };
}
