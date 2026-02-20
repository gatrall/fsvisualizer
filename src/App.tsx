import cytoscape, { Core, ElementsDefinition } from "cytoscape";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { GraphJson, GraphNodeData } from "./types";

type LayoutMode = "concentric" | "breadthfirst" | "cose" | "circle";
type ViewMode =
  | "search-neighbors"
  | "search-only"
  | "full"
  | "selected-1"
  | "selected-2"
  | "tree-outgoing"
  | "tree-incoming"
  | "hierarchy";

type EdgeKind = "import" | "reexport";

interface DirectedNeighbor {
  id: string;
  kind: EdgeKind;
}

interface FolderTree {
  childrenByParent: Map<string, string[]>;
  childNameByPath: Map<string, string>;
  countsByPath: Map<string, number>;
}

interface ViewportState {
  zoom: number;
  panX: number;
  panY: number;
}

const ALL_SCOPE = "__all__";
const ROOT_SCOPE = "__root__";
const UNRESOLVED_SCOPE = "__unresolved__";
const DEFAULT_VIEW_MODE: ViewMode = "selected-1";
const DEFAULT_LAYOUT_MODE: LayoutMode = "circle";
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.85;
const VIEW_MODE_VALUES: ViewMode[] = [
  "search-neighbors",
  "search-only",
  "full",
  "selected-1",
  "selected-2",
  "tree-outgoing",
  "tree-incoming",
  "hierarchy"
];
const LAYOUT_MODE_VALUES: LayoutMode[] = ["concentric", "breadthfirst", "cose", "circle"];

function emptyGraph(): GraphJson {
  return {
    root: "",
    generatedAt: "",
    elements: {
      nodes: [],
      edges: []
    }
  };
}

function getScopeKey(node: GraphNodeData): string {
  if (node.isVirtual || node.filePath === "(unresolved module)") {
    return UNRESOLVED_SCOPE;
  }

  const normalized = node.filePath.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  if (slash < 0) {
    return ROOT_SCOPE;
  }

  return normalized.slice(0, slash);
}

function getScopeLabel(key: string): string {
  if (key === ROOT_SCOPE) {
    return "(root files)";
  }

  if (key === UNRESOLVED_SCOPE) {
    return "(unresolved modules)";
  }

  return key;
}

function expandNeighbors(
  seeds: Set<string>,
  maxDepth: number,
  adjacency: Map<string, Set<string>>,
  allowed: Set<string>
): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];

  for (const seed of seeds) {
    if (!allowed.has(seed)) {
      continue;
    }

    visited.add(seed);
    queue.push({ id: seed, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) {
      continue;
    }

    const neighbors = adjacency.get(current.id);
    if (!neighbors) {
      continue;
    }

    for (const neighbor of neighbors) {
      if (!allowed.has(neighbor) || visited.has(neighbor)) {
        continue;
      }

      visited.add(neighbor);
      queue.push({ id: neighbor, depth: current.depth + 1 });
    }
  }

  return visited;
}

function expandDirected(
  seeds: Set<string>,
  maxDepth: number,
  adjacency: Map<string, DirectedNeighbor[]>,
  allowed: Set<string>,
  includeImportEdges: boolean,
  includeReexportEdges: boolean
): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];

  for (const seed of seeds) {
    if (!allowed.has(seed)) {
      continue;
    }

    visited.add(seed);
    queue.push({ id: seed, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) {
      continue;
    }

    const neighbors = adjacency.get(current.id) ?? [];
    for (const neighbor of neighbors) {
      const kindAllowed =
        neighbor.kind === "import" ? includeImportEdges : includeReexportEdges;
      if (!kindAllowed) {
        continue;
      }

      if (!allowed.has(neighbor.id) || visited.has(neighbor.id)) {
        continue;
      }

      visited.add(neighbor.id);
      queue.push({ id: neighbor.id, depth: current.depth + 1 });
    }
  }

  return visited;
}

function getLayoutOptions(layoutMode: LayoutMode): cytoscape.LayoutOptions {
  switch (layoutMode) {
    case "breadthfirst":
      return {
        name: "breadthfirst",
        animate: false,
        fit: true,
        directed: true,
        spacingFactor: 1.2,
        padding: 35
      };
    case "cose":
      return {
        name: "cose",
        animate: false,
        fit: true,
        nodeRepulsion: 180000,
        idealEdgeLength: 90,
        padding: 35
      };
    case "circle":
      return {
        name: "circle",
        animate: false,
        fit: true,
        padding: 35
      };
    case "concentric":
    default:
      return {
        name: "concentric",
        animate: false,
        fit: true,
        minNodeSpacing: 15,
        spacingFactor: 1.15,
        padding: 35,
        concentric(node) {
          return node.connectedEdges().length;
        },
        levelWidth() {
          return 2;
        }
      };
  }
}

function buildFolderTree(nodes: GraphJson["elements"]["nodes"]): FolderTree {
  const childrenByParent = new Map<string, Set<string>>();
  const childNameByPath = new Map<string, string>();
  const countsByPath = new Map<string, number>();

  for (const node of nodes) {
    if (node.data.isVirtual || node.data.filePath === "(unresolved module)") {
      continue;
    }

    const normalized = node.data.id.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);

    if (segments.length < 2) {
      continue;
    }

    for (let i = 0; i < segments.length - 1; i += 1) {
      const folderPath = segments.slice(0, i + 1).join("/");
      const parentPath = i === 0 ? "" : segments.slice(0, i).join("/");
      const folderName = segments[i];

      const siblings = childrenByParent.get(parentPath) ?? new Set<string>();
      siblings.add(folderPath);
      childrenByParent.set(parentPath, siblings);
      childNameByPath.set(folderPath, folderName);
      countsByPath.set(folderPath, (countsByPath.get(folderPath) ?? 0) + 1);
    }
  }

  const sortedChildrenByParent = new Map<string, string[]>();
  for (const [parent, children] of childrenByParent.entries()) {
    sortedChildrenByParent.set(
      parent,
      [...children].sort((a, b) => a.localeCompare(b))
    );
  }

  return {
    childrenByParent: sortedChildrenByParent,
    childNameByPath,
    countsByPath
  };
}

function chooseDefaultNodeId(graph: GraphJson): string | null {
  if (graph.elements.nodes.length === 0) {
    return null;
  }

  const nodeInfo = new Map<
    string,
    {
      isVirtual: boolean;
      degree: number;
    }
  >();

  for (const node of graph.elements.nodes) {
    nodeInfo.set(node.data.id, {
      isVirtual: Boolean(node.data.isVirtual),
      degree: 0
    });
  }

  for (const edge of graph.elements.edges) {
    const source = nodeInfo.get(edge.data.source);
    const target = nodeInfo.get(edge.data.target);

    if (source) {
      source.degree += 1;
    }
    if (target) {
      target.degree += 1;
    }
  }

  return [...nodeInfo.entries()]
    .sort((a, b) => {
      if (a[1].isVirtual !== b[1].isVirtual) {
        return a[1].isVirtual ? 1 : -1;
      }

      if (b[1].degree !== a[1].degree) {
        return b[1].degree - a[1].degree;
      }

      return a[0].localeCompare(b[0]);
    })[0]?.[0] ?? null;
}

function parseViewMode(value: string | null): ViewMode | null {
  if (value && VIEW_MODE_VALUES.includes(value as ViewMode)) {
    return value as ViewMode;
  }

  return null;
}

function parseLayoutMode(value: string | null): LayoutMode | null {
  if (value && LAYOUT_MODE_VALUES.includes(value as LayoutMode)) {
    return value as LayoutMode;
  }

  return null;
}

function clampViewportState(viewport: ViewportState): ViewportState {
  return {
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewport.zoom)),
    panX: viewport.panX,
    panY: viewport.panY
  };
}

function parseViewportState(value: unknown): ViewportState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const zoom = typeof record.zoom === "number" ? record.zoom : NaN;
  const panX = typeof record.panX === "number" ? record.panX : NaN;
  const panY = typeof record.panY === "number" ? record.panY : NaN;

  if (!Number.isFinite(zoom) || !Number.isFinite(panX) || !Number.isFinite(panY)) {
    return null;
  }

  return clampViewportState({ zoom, panX, panY });
}

function getViewportState(cy: Core): ViewportState {
  const pan = cy.pan();
  return clampViewportState({
    zoom: cy.zoom(),
    panX: pan.x,
    panY: pan.y
  });
}

function applyViewportState(cy: Core, viewport: ViewportState): void {
  const clamped = clampViewportState(viewport);
  cy.viewport({
    zoom: clamped.zoom,
    pan: {
      x: clamped.panX,
      y: clamped.panY
    }
  });
}

function getNavigationFromHistoryState(stateValue: unknown): {
  nodeId: string | null;
  viewMode: ViewMode | null;
  layoutMode: LayoutMode | null;
} {
  return {
    nodeId:
      stateValue && typeof stateValue === "object" && typeof (stateValue as Record<string, unknown>).nodeId === "string"
        ? ((stateValue as Record<string, unknown>).nodeId as string)
        : null,
    viewMode: parseViewMode(
      stateValue && typeof stateValue === "object" && typeof (stateValue as Record<string, unknown>).viewMode === "string"
        ? ((stateValue as Record<string, unknown>).viewMode as string)
        : null
    ),
    layoutMode: parseLayoutMode(
      stateValue && typeof stateValue === "object" && typeof (stateValue as Record<string, unknown>).layoutMode === "string"
        ? ((stateValue as Record<string, unknown>).layoutMode as string)
        : null
    )
  };
}

function getBaseLabelSize(
  viewMode: ViewMode,
  layoutMode: LayoutMode,
  visibleNodeCount: number
): number {
  let base = 9.5;

  if (viewMode === "selected-1" || viewMode === "tree-outgoing" || viewMode === "tree-incoming") {
    base += 0.8;
  }

  if (viewMode === "search-only") {
    base += 0.6;
  }

  if (layoutMode === "circle") {
    if (visibleNodeCount <= 40) {
      base += 3.2;
    } else if (visibleNodeCount <= 90) {
      base += 2.2;
    } else if (visibleNodeCount <= 150) {
      base += 1.3;
    }
  } else if (visibleNodeCount <= 40) {
    base += 1.8;
  } else if (visibleNodeCount <= 90) {
    base += 0.9;
  }

  if (visibleNodeCount > 220) {
    base -= 1.7;
  } else if (visibleNodeCount > 160) {
    base -= 1.1;
  } else if (visibleNodeCount > 120) {
    base -= 0.6;
  }

  return Math.max(7.2, Math.min(16.5, base));
}

function getZoomScale(zoom: number): number {
  if (zoom < 0.68) {
    return 1.35;
  }

  if (zoom < 0.9) {
    return 1.18;
  }

  if (zoom > 1.72) {
    return 0.78;
  }

  if (zoom > 1.5) {
    return 0.88;
  }

  return 1;
}

function applyAdaptiveLabelStyling(
  cy: Core,
  viewMode: ViewMode,
  layoutMode: LayoutMode,
  visibleNodeCount: number
): void {
  const base = getBaseLabelSize(viewMode, layoutMode, visibleNodeCount);
  const size = Math.max(7, Math.min(18, Number((base * getZoomScale(cy.zoom())).toFixed(1))));
  const outline = Number(Math.max(1.8, Math.min(4.4, size * 0.28)).toFixed(1));
  const padding = Math.max(1, Math.min(4, Math.round(size / 4.8)));

  cy.nodes().style("font-size", size);
  cy.nodes().style("text-outline-width", outline);
  cy.nodes().style("text-background-padding", `${padding}px`);
}

export default function App() {
  const [graph, setGraph] = useState<GraphJson>(emptyGraph());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<string>(ALL_SCOPE);
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW_MODE);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(DEFAULT_LAYOUT_MODE);
  const [selectedExportSymbol, setSelectedExportSymbol] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [showImportEdges, setShowImportEdges] = useState(true);
  const [showReexportEdges, setShowReexportEdges] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [treeDepth, setTreeDepth] = useState(3);
  const [hierarchyFolderPrefix, setHierarchyFolderPrefix] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const pendingHistoryActionRef = useRef<"push" | "replace" | "none">("none");
  const pendingCenterSelectionRef = useRef(false);
  const pendingFitSelectionRef = useRef(false);
  const pendingViewportRestoreRef = useRef<ViewportState | null>(null);
  const pendingViewportFallbackTimerRef = useRef<number | null>(null);
  const historyViewportRafRef = useRef<number | null>(null);
  const viewModeRef = useRef<ViewMode>(DEFAULT_VIEW_MODE);
  const layoutModeRef = useRef<LayoutMode>(DEFAULT_LAYOUT_MODE);

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNodeData>();
    for (const node of graph.elements.nodes) {
      map.set(node.data.id, node.data);
    }
    return map;
  }, [graph]);

  const nodeOrder = useMemo(() => graph.elements.nodes.map((node) => node.data.id), [graph]);
  const defaultNodeId = useMemo(() => chooseDefaultNodeId(graph), [graph]);

  const allNodeIds = useMemo(() => new Set(nodeOrder), [nodeOrder]);

  const scopeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph.elements.nodes) {
      const key = getScopeKey(node.data);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const options = [
      {
        value: ALL_SCOPE,
        label: `All folders (${graph.elements.nodes.length})`
      }
    ];

    const keys = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      options.push({
        value: key,
        label: `${getScopeLabel(key)} (${counts.get(key) ?? 0})`
      });
    }

    return options;
  }, [graph]);

  useEffect(() => {
    const exists = scopeOptions.some((option) => option.value === scope);
    if (!exists) {
      setScope(ALL_SCOPE);
    }
  }, [scopeOptions, scope]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();

    for (const nodeId of nodeOrder) {
      map.set(nodeId, new Set<string>());
    }

    for (const edge of graph.elements.edges) {
      const source = edge.data.source;
      const target = edge.data.target;

      if (!map.has(source)) {
        map.set(source, new Set<string>());
      }
      if (!map.has(target)) {
        map.set(target, new Set<string>());
      }

      map.get(source)?.add(target);
      map.get(target)?.add(source);
    }

    return map;
  }, [graph, nodeOrder]);

  const outgoingAdjacency = useMemo(() => {
    const map = new Map<string, DirectedNeighbor[]>();

    for (const nodeId of nodeOrder) {
      map.set(nodeId, []);
    }

    for (const edge of graph.elements.edges) {
      const source = edge.data.source;
      const target = edge.data.target;
      const kind = edge.data.kind;

      const current = map.get(source) ?? [];
      current.push({ id: target, kind });
      map.set(source, current);
    }

    return map;
  }, [graph, nodeOrder]);

  const incomingAdjacency = useMemo(() => {
    const map = new Map<string, DirectedNeighbor[]>();

    for (const nodeId of nodeOrder) {
      map.set(nodeId, []);
    }

    for (const edge of graph.elements.edges) {
      const source = edge.data.source;
      const target = edge.data.target;
      const kind = edge.data.kind;

      const current = map.get(target) ?? [];
      current.push({ id: source, kind });
      map.set(target, current);
    }

    return map;
  }, [graph, nodeOrder]);

  const scopedNodeIds = useMemo(() => {
    if (scope === ALL_SCOPE) {
      return new Set(allNodeIds);
    }

    const out = new Set<string>();
    for (const node of graph.elements.nodes) {
      if (getScopeKey(node.data) === scope) {
        out.add(node.data.id);
      }
    }
    return out;
  }, [graph, scope, allNodeIds]);

  const searchTerm = search.trim().toLowerCase();

  const searchMatchedIds = useMemo(() => {
    const out = new Set<string>();
    if (!searchTerm) {
      return out;
    }

    for (const node of graph.elements.nodes) {
      if (!scopedNodeIds.has(node.data.id)) {
        continue;
      }

      const id = node.data.id.toLowerCase();
      const label = node.data.label.toLowerCase();
      if (id.includes(searchTerm) || label.includes(searchTerm)) {
        out.add(node.data.id);
      }
    }

    return out;
  }, [graph, scopedNodeIds, searchTerm]);

  const selectedSymbolUserIds = useMemo(() => {
    if (!selectedId || !selectedExportSymbol) {
      return new Set<string>();
    }

    const selectedNodeData = nodeById.get(selectedId);
    const users = selectedNodeData?.symbolUsers?.[selectedExportSymbol] ?? [];
    return new Set(users);
  }, [nodeById, selectedExportSymbol, selectedId]);

  const folderTree = useMemo(() => buildFolderTree(graph.elements.nodes), [graph]);
  const expandedFolderSet = useMemo(() => new Set(expandedFolders), [expandedFolders]);

  useEffect(() => {
    setExpandedFolders((previous) => {
      const valid = previous.filter((path) => folderTree.countsByPath.has(path));
      if (valid.length > 0) {
        return valid;
      }

      return folderTree.childrenByParent.get("") ?? [];
    });
  }, [folderTree]);

  useEffect(() => {
    if (hierarchyFolderPrefix && !folderTree.countsByPath.has(hierarchyFolderPrefix)) {
      setHierarchyFolderPrefix("");
    }
  }, [folderTree, hierarchyFolderPrefix]);

  const hierarchyScopedNodeIds = useMemo(() => {
    if (!hierarchyFolderPrefix) {
      return new Set(scopedNodeIds);
    }

    const prefix = `${hierarchyFolderPrefix}/`;
    const out = new Set<string>();
    for (const id of scopedNodeIds) {
      if (id.startsWith(prefix)) {
        out.add(id);
      }
    }

    return out;
  }, [hierarchyFolderPrefix, scopedNodeIds]);

  const visibleNodeIds = useMemo(() => {
    const allowed = new Set(scopedNodeIds);

    if (selectedId && allNodeIds.has(selectedId) && !allowed.has(selectedId)) {
      allowed.add(selectedId);
    }

    let visible = new Set<string>(allowed);

    if (viewMode === "search-only") {
      if (searchMatchedIds.size > 0) {
        visible = new Set(searchMatchedIds);
      }
    } else if (viewMode === "search-neighbors") {
      if (searchMatchedIds.size > 0) {
        visible = expandNeighbors(searchMatchedIds, 1, adjacency, allowed);
      }
    } else if (viewMode === "selected-1" || viewMode === "selected-2") {
      if (selectedId && allNodeIds.has(selectedId)) {
        const depth = viewMode === "selected-1" ? 1 : 2;
        const selectedAllowed = scopedNodeIds.has(selectedId) ? allowed : allNodeIds;
        visible = expandNeighbors(new Set([selectedId]), depth, adjacency, selectedAllowed);
      }
    } else if (viewMode === "tree-outgoing" || viewMode === "tree-incoming") {
      if (selectedId && allNodeIds.has(selectedId)) {
        const selectedAllowed = scopedNodeIds.has(selectedId) ? allowed : allNodeIds;
        visible = expandDirected(
          new Set([selectedId]),
          treeDepth,
          viewMode === "tree-outgoing" ? outgoingAdjacency : incomingAdjacency,
          selectedAllowed,
          showImportEdges,
          showReexportEdges
        );
      }
    } else if (viewMode === "hierarchy") {
      visible = new Set(hierarchyScopedNodeIds);

      if (searchMatchedIds.size > 0) {
        const scopedSeeds = new Set(
          [...searchMatchedIds].filter((id) => hierarchyScopedNodeIds.has(id))
        );
        if (scopedSeeds.size > 0) {
          visible = expandNeighbors(scopedSeeds, 1, adjacency, hierarchyScopedNodeIds);
        }
      }
    }

    if (visible.size === 0) {
      visible =
        viewMode === "hierarchy"
          ? new Set(hierarchyScopedNodeIds)
          : new Set(allowed);
    }

    if (selectedId && allNodeIds.has(selectedId)) {
      visible.add(selectedId);
    }

    for (const userId of selectedSymbolUserIds) {
      if (allNodeIds.has(userId)) {
        visible.add(userId);
      }
    }

    return visible;
  }, [
    adjacency,
    allNodeIds,
    hierarchyScopedNodeIds,
    incomingAdjacency,
    outgoingAdjacency,
    scopedNodeIds,
    searchMatchedIds,
    selectedSymbolUserIds,
    selectedId,
    showImportEdges,
    showReexportEdges,
    treeDepth,
    viewMode
  ]);

  const sidebarNodes = useMemo(() => {
    return graph.elements.nodes.filter((node) => {
      if (!visibleNodeIds.has(node.data.id)) {
        return false;
      }

      if (!searchTerm) {
        return true;
      }

      const id = node.data.id.toLowerCase();
      const label = node.data.label.toLowerCase();
      return id.includes(searchTerm) || label.includes(searchTerm);
    });
  }, [graph, searchTerm, visibleNodeIds]);

  const visibleNodeCount = visibleNodeIds.size;

  const visibleEdgeCount = useMemo(() => {
    let count = 0;
    for (const edge of graph.elements.edges) {
      const sourceVisible = visibleNodeIds.has(edge.data.source);
      const targetVisible = visibleNodeIds.has(edge.data.target);
      const kindVisible =
        edge.data.kind === "import" ? showImportEdges : showReexportEdges;
      if (sourceVisible && targetVisible && kindVisible) {
        count += 1;
      }
    }
    return count;
  }, [graph, visibleNodeIds, showImportEdges, showReexportEdges]);

  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;
  const selectedSymbolUsers = useMemo(() => {
    if (!selectedNode || !selectedExportSymbol) {
      return [];
    }

    const users = selectedNode.symbolUsers?.[selectedExportSymbol] ?? [];
    return [...users].sort((a, b) => a.localeCompare(b));
  }, [selectedNode, selectedExportSymbol]);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    layoutModeRef.current = layoutMode;
  }, [layoutMode]);

  useEffect(() => {
    setSelectedExportSymbol(null);
  }, [selectedId]);

  useEffect(() => {
    return () => {
      if (typeof window === "undefined") {
        return;
      }

      if (pendingViewportFallbackTimerRef.current !== null) {
        window.clearTimeout(pendingViewportFallbackTimerRef.current);
        pendingViewportFallbackTimerRef.current = null;
      }

      if (historyViewportRafRef.current !== null) {
        window.cancelAnimationFrame(historyViewportRafRef.current);
        historyViewportRafRef.current = null;
      }

      pendingViewportRestoreRef.current = null;
    };
  }, []);

  function updateSelectedNode(
    nodeId: string | null,
    historyAction: "push" | "replace" | "none",
    shouldCenter = false,
    shouldFit = false
  ): void {
    pendingHistoryActionRef.current = historyAction;
    pendingCenterSelectionRef.current = shouldCenter;
    pendingFitSelectionRef.current = shouldFit;
    setSelectedId(nodeId);
  }

  function updateViewMode(
    nextMode: ViewMode,
    historyAction: "replace" | "none" = "replace"
  ): void {
    pendingHistoryActionRef.current = historyAction;
    setViewMode(nextMode);
  }

  function updateLayoutMode(
    nextMode: LayoutMode,
    historyAction: "replace" | "none" = "replace"
  ): void {
    pendingHistoryActionRef.current = historyAction;
    setLayoutMode(nextMode);
  }

  function persistCurrentHistoryViewport(): void {
    if (typeof window === "undefined") {
      return;
    }

    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    const currentState =
      window.history.state && typeof window.history.state === "object"
        ? (window.history.state as Record<string, unknown>)
        : {};
    const viewport = getViewportState(cy);
    const nextState: Record<string, unknown> = {
      ...currentState,
      nodeId: selectedId,
      viewMode: viewModeRef.current,
      layoutMode: layoutModeRef.current,
      viewport
    };

    if (selectedId === null) {
      delete nextState.nodeId;
    }

    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(nextState, "", currentUrl);
  }

  function scheduleViewportPersistence(): void {
    if (historyViewportRafRef.current !== null || typeof window === "undefined") {
      return;
    }

    historyViewportRafRef.current = window.requestAnimationFrame(() => {
      historyViewportRafRef.current = null;
      persistCurrentHistoryViewport();
    });
  }

  function scheduleViewportFallbackRestore(): void {
    if (typeof window === "undefined") {
      return;
    }

    if (pendingViewportFallbackTimerRef.current !== null) {
      window.clearTimeout(pendingViewportFallbackTimerRef.current);
      pendingViewportFallbackTimerRef.current = null;
    }

    pendingViewportFallbackTimerRef.current = window.setTimeout(() => {
      pendingViewportFallbackTimerRef.current = null;
      const pendingViewport = pendingViewportRestoreRef.current;
      const cy = cyRef.current;

      if (!pendingViewport || !cy) {
        return;
      }

      applyViewportState(cy, pendingViewport);
      pendingViewportRestoreRef.current = null;
      setZoomPercent(Math.round(cy.zoom() * 100));
      applyAdaptiveLabelStyling(cy, viewModeRef.current, layoutModeRef.current, visibleNodeCount);
      scheduleViewportPersistence();
    }, 180);
  }

  function fitVisibleElements(cy: Core): void {
    const visibleElements = cy.elements().not(".hidden");
    if (visibleElements.empty()) {
      return;
    }

    const padding = 46;
    const bounds = visibleElements.boundingBox({
      includeLabels: true,
      includeOverlays: false
    });

    if (Number.isFinite(bounds.w) && Number.isFinite(bounds.h) && bounds.w > 0 && bounds.h > 0) {
      const availableWidth = Math.max(1, cy.width() - padding * 2);
      const availableHeight = Math.max(1, cy.height() - padding * 2);
      const widthZoom = availableWidth / bounds.w;
      const heightZoom = availableHeight / bounds.h;
      const targetZoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, Math.min(widthZoom, heightZoom))
      );
      const centerX = bounds.x1 + bounds.w / 2;
      const centerY = bounds.y1 + bounds.h / 2;

      cy.viewport({
        zoom: targetZoom,
        pan: {
          x: cy.width() / 2 - centerX * targetZoom,
          y: cy.height() / 2 - centerY * targetZoom
        }
      });
    } else {
      cy.fit(visibleElements, padding);
    }

    setZoomPercent(Math.round(cy.zoom() * 100));
    scheduleViewportPersistence();
  }

  function runLayoutAndFit(cy: Core, mode: LayoutMode): void {
    const visibleElements = cy.elements().not(".hidden");
    if (visibleElements.empty()) {
      return;
    }

    const isRestoringViewport = pendingViewportRestoreRef.current !== null;
    const layout = visibleElements.layout(getLayoutOptions(mode));
    layout.on("layoutstop", () => {
      if (isRestoringViewport) {
        const pendingViewport = pendingViewportRestoreRef.current;
        if (pendingViewport) {
          applyViewportState(cy, pendingViewport);
          pendingViewportRestoreRef.current = null;
        }
      } else {
        fitVisibleElements(cy);
      }

      applyAdaptiveLabelStyling(cy, viewModeRef.current, layoutModeRef.current, visibleNodeCount);
      setZoomPercent(Math.round(cy.zoom() * 100));
      scheduleViewportPersistence();
    });
    layout.run();
  }

  useEffect(() => {
    const abort = new AbortController();

    async function loadGraph(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`${import.meta.env.BASE_URL}graph.json`, {
          signal: abort.signal
        });
        if (!response.ok) {
          throw new Error(`Failed to load graph.json (${response.status})`);
        }

        const data = (await response.json()) as GraphJson;
        setGraph(data);
        updateViewMode(DEFAULT_VIEW_MODE, "none");
        updateLayoutMode(DEFAULT_LAYOUT_MODE, "none");

        if (typeof window !== "undefined") {
          const cleanUrl = `${window.location.pathname}${window.location.hash}`;
          window.history.replaceState({}, "", cleanUrl);
        }

        pendingViewportRestoreRef.current = null;

        const initialNodeId = chooseDefaultNodeId(data);
        if (initialNodeId) {
          updateSelectedNode(initialNodeId, "replace", false, true);
        } else {
          updateSelectedNode(null, "replace");
        }
      } catch (loadError) {
        if ((loadError as Error).name !== "AbortError") {
          setError((loadError as Error).message);
          setGraph(emptyGraph());
          updateSelectedNode(null, "replace");
        }
      } finally {
        setLoading(false);
      }
    }

    loadGraph();

    return () => {
      abort.abort();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onPopState = (event: PopStateEvent) => {
      const stateValue =
        event.state && typeof event.state === "object"
          ? (event.state as Record<string, unknown>)
          : undefined;
      const historyNavigation = getNavigationFromHistoryState(stateValue);

      const fromStateViewport = parseViewportState(stateValue?.viewport);

      const nextViewMode = historyNavigation.viewMode ?? DEFAULT_VIEW_MODE;
      const nextLayoutMode = historyNavigation.layoutMode ?? DEFAULT_LAYOUT_MODE;
      const requestedNode = historyNavigation.nodeId;

      pendingViewportRestoreRef.current = fromStateViewport;
      scheduleViewportFallbackRestore();
      updateViewMode(nextViewMode, "none");
      updateLayoutMode(nextLayoutMode, "none");

      if (requestedNode && allNodeIds.has(requestedNode)) {
        updateSelectedNode(requestedNode, "none", false, fromStateViewport === null);
        return;
      }

      if (!requestedNode) {
        updateSelectedNode(defaultNodeId, "none", false, fromStateViewport === null);
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [allNodeIds, defaultNodeId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const action = pendingHistoryActionRef.current;
    pendingHistoryActionRef.current = "none";

    if (action === "none") {
      return;
    }

    const currentState =
      window.history.state && typeof window.history.state === "object"
        ? (window.history.state as Record<string, unknown>)
        : {};
    const currentNavigation = getNavigationFromHistoryState(currentState);
    const cy = cyRef.current;
    const viewport = cy ? getViewportState(cy) : parseViewportState(currentState.viewport);
    const nextState: Record<string, unknown> = {
      ...currentState,
      nodeId: selectedId,
      viewMode,
      layoutMode,
      viewport
    };

    if (selectedId === null) {
      delete nextState.nodeId;
    }

    const sameNode = currentNavigation.nodeId === selectedId;
    const sameView = currentNavigation.viewMode === viewMode;
    const sameLayout = currentNavigation.layoutMode === layoutMode;
    const sameHistoryState = sameNode && sameView && sameLayout;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (action === "push" && !sameHistoryState) {
      window.history.pushState(nextState, "", currentUrl);
      return;
    }

    if (action === "replace" && !sameHistoryState) {
      window.history.replaceState(nextState, "", currentUrl);
    }
  }, [selectedId, viewMode, layoutMode]);

  useEffect(() => {
    if (nodeOrder.length === 0) {
      if (selectedId !== null) {
        updateSelectedNode(null, "replace");
      }
      return;
    }

    if (selectedId && visibleNodeIds.has(selectedId)) {
      return;
    }

    const firstVisible = nodeOrder.find((id) => visibleNodeIds.has(id)) ?? null;
    if (firstVisible !== selectedId) {
      updateSelectedNode(firstVisible, "replace");
    }
  }, [nodeOrder, visibleNodeIds, selectedId]);

  useEffect(() => {
    if (selectedId === null) {
      return;
    }

    if (visibleNodeIds.has(selectedId)) {
      return;
    }

    pendingViewportRestoreRef.current = null;
    pendingCenterSelectionRef.current = false;
    pendingFitSelectionRef.current = false;
  }, [selectedId, visibleNodeIds]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const elements: ElementsDefinition = {
      nodes: graph.elements.nodes,
      edges: graph.elements.edges
    };

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      wheelSensitivity: 0.18,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#2563eb",
            label: "data(label)",
            "font-size": 10,
            "min-zoomed-font-size": 7,
            "font-weight": 500,
            color: "#1f2937",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 7,
            "text-outline-color": "#f3f4f6",
            "text-outline-width": 3,
            "text-background-color": "rgba(243, 244, 246, 0.96)",
            "text-background-opacity": 1,
            "text-background-shape": "roundrectangle",
            "text-background-padding": "2px",
            "z-index": 20,
            width: 14,
            height: 14
          }
        },
        {
          selector: "node.nolabel:not(.search-hit):not(:selected)",
          style: {
            label: ""
          }
        },
        {
          selector: "node.hidden",
          style: {
            display: "none"
          }
        },
        {
          selector: "node.search-hit",
          style: {
            "border-width": 2,
            "border-color": "#f59e0b"
          }
        },
        {
          selector: "node.symbol-user",
          style: {
            "border-width": 2,
            "border-color": "#22c55e",
            "background-color": "#16a34a"
          }
        },
        {
          selector: "node[isVirtual]",
          style: {
            "background-color": "#9ca3af"
          }
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 3,
            "border-color": "#f97316"
          }
        },
        {
          selector: "edge.hidden",
          style: {
            display: "none"
          }
        },
        {
          selector: 'edge[kind = "import"]',
          style: {
            "line-color": "rgba(148, 163, 184, 0.40)",
            width: 1.1,
            "line-style": "dashed",
            "target-arrow-color": "rgba(148, 163, 184, 0.44)",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.75,
            opacity: 0.55,
            "z-index": 4
          }
        },
        {
          selector: 'edge[kind = "reexport"]',
          style: {
            "line-color": "rgba(14, 165, 233, 0.34)",
            width: 1.4,
            "line-style": "solid",
            "target-arrow-color": "rgba(14, 165, 233, 0.38)",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.78,
            opacity: 0.6,
            "z-index": 4
          }
        }
      ],
      layout: getLayoutOptions(layoutMode)
    });

    cy.on("tap", "node", (event) => {
      const node = event.target;
      updateSelectedNode(node.id(), "push", false, true);
    });

    cy.on("zoom", () => {
      setZoomPercent(Math.round(cy.zoom() * 100));
      scheduleViewportPersistence();
    });

    cy.on("pan", () => {
      scheduleViewportPersistence();
    });

    setZoomPercent(Math.round(cy.zoom() * 100));
    applyAdaptiveLabelStyling(cy, viewModeRef.current, layoutModeRef.current, visibleNodeCount);

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const id = node.id();
        node.toggleClass("hidden", !visibleNodeIds.has(id));
        node.toggleClass("nolabel", !showLabels);
        node.toggleClass("search-hit", searchMatchedIds.has(id));
        node.toggleClass("symbol-user", selectedSymbolUserIds.has(id));
      });

      cy.edges().forEach((edge) => {
        const source = String(edge.data("source"));
        const target = String(edge.data("target"));
        const kind = String(edge.data("kind"));
        const sourceVisible = visibleNodeIds.has(source);
        const targetVisible = visibleNodeIds.has(target);
        const kindVisible = kind === "import" ? showImportEdges : showReexportEdges;

        edge.toggleClass("hidden", !(sourceVisible && targetVisible && kindVisible));
      });
    });
  }, [
    visibleNodeIds,
    showLabels,
    searchMatchedIds,
    selectedSymbolUserIds,
    showImportEdges,
    showReexportEdges
  ]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    applyAdaptiveLabelStyling(cy, viewMode, layoutMode, visibleNodeCount);
  }, [zoomPercent, viewMode, layoutMode, visibleNodeCount]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedId) {
      pendingCenterSelectionRef.current = false;
      pendingFitSelectionRef.current = false;
      return;
    }

    const node = cy.getElementById(selectedId);
    if (node.empty() || node.hasClass("hidden")) {
      pendingCenterSelectionRef.current = false;
      pendingFitSelectionRef.current = false;
      return;
    }

    const shouldCenter = pendingCenterSelectionRef.current;
    const shouldFit = pendingFitSelectionRef.current;
    pendingCenterSelectionRef.current = false;
    pendingFitSelectionRef.current = false;

    cy.nodes().unselect();
    node.select();

    if (shouldCenter) {
      cy.animate({
        center: { eles: node },
        duration: 250
      });
    }

    if (shouldFit) {
      fitVisibleElements(cy);
    }
  }, [selectedId, visibleNodeIds]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    runLayoutAndFit(cy, layoutMode);
  }, [
    layoutMode,
    viewMode,
    visibleNodeIds,
    showImportEdges,
    showReexportEdges,
    treeDepth,
    hierarchyFolderPrefix
  ]);

  function focusNode(nodeId: string): void {
    updateSelectedNode(nodeId, "push", false, true);
  }

  function fitVisible(): void {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    fitVisibleElements(cy);
  }

  function recomputeLayout(): void {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    runLayoutAndFit(cy, layoutMode);
  }

  function zoomBy(multiplier: number): void {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }

    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cy.zoom() * multiplier));
    cy.zoom({
      level: next,
      renderedPosition: {
        x: cy.width() / 2,
        y: cy.height() / 2
      }
    });
    setZoomPercent(Math.round(cy.zoom() * 100));
    scheduleViewportPersistence();
  }

  function applyPreset(nextMode: "tree-outgoing" | "tree-incoming" | "hierarchy"): void {
    updateViewMode(nextMode, "replace");
    updateLayoutMode("breadthfirst", "replace");
    setShowLabels(true);
  }

  function resetToStart(): void {
    pendingViewportRestoreRef.current = null;
    pendingCenterSelectionRef.current = false;
    pendingFitSelectionRef.current = false;

    if (typeof window !== "undefined") {
      const cleanUrl = `${window.location.pathname}${window.location.hash}`;
      window.history.replaceState({}, "", cleanUrl);
    }

    setSearch("");
    setScope(ALL_SCOPE);
    setTreeDepth(3);
    setHierarchyFolderPrefix("");
    setSelectedExportSymbol(null);
    setShowLabels(true);
    setShowImportEdges(true);
    setShowReexportEdges(true);
    setExpandedFolders(folderTree.childrenByParent.get("") ?? []);
    updateViewMode(DEFAULT_VIEW_MODE, "replace");
    updateLayoutMode(DEFAULT_LAYOUT_MODE, "replace");
    updateSelectedNode(defaultNodeId, "replace", false, true);
  }

  function toggleFolderExpanded(path: string): void {
    setExpandedFolders((previous) => {
      if (previous.includes(path)) {
        return previous.filter((item) => item !== path);
      }

      return [...previous, path].sort((a, b) => a.localeCompare(b));
    });
  }

  function selectHierarchyFolder(path: string): void {
    setHierarchyFolderPrefix(path);
    updateViewMode("hierarchy", "replace");
    updateLayoutMode("breadthfirst", "replace");
  }

  function renderFolderBranch(parentPath: string, depth: number) {
    const children = folderTree.childrenByParent.get(parentPath) ?? [];
    if (children.length === 0) {
      return null;
    }

    return children.map((path) => {
      const name = folderTree.childNameByPath.get(path) ?? path;
      const count = folderTree.countsByPath.get(path) ?? 0;
      const hasChildren = (folderTree.childrenByParent.get(path)?.length ?? 0) > 0;
      const isExpanded = expandedFolderSet.has(path);
      const isActive = hierarchyFolderPrefix === path;

      return (
        <Fragment key={path}>
          <div className={`folder-row${isActive ? " active" : ""}`}>
            <div className="folder-indent" style={{ width: 10 + depth * 14 }} />
            {hasChildren ? (
              <button
                className="folder-toggle"
                onClick={() => toggleFolderExpanded(path)}
                type="button"
              >
                {isExpanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="folder-spacer">•</span>
            )}
            <button
              className="folder-select"
              onClick={() => selectHierarchyFolder(path)}
              type="button"
            >
              {name}
              <span className="folder-count"> ({count})</span>
            </button>
          </div>
          {hasChildren && isExpanded ? renderFolderBranch(path, depth + 1) : null}
        </Fragment>
      );
    });
  }

  function renderModuleLinks(modules: string[], targets: string[]) {
    if (modules.length === 0) {
      return <div className="details-row">None</div>;
    }

    return (
      <ul className="details-list">
        {modules.map((modulePath, index) => {
          const targetId = targets[index] ?? modulePath;
          return (
            <li className="details-list-item" key={`${modulePath}-${index}`}>
              <button className="inline-link" onClick={() => focusNode(targetId)} type="button">
                {modulePath}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="sidebar-title-button" onClick={resetToStart} type="button">
            Onshape Standard FeatureScript Modules ({graph.elements.nodes.length})
          </button>
          <input
            className="search-input"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by id or label"
            value={search}
          />

          <div className="button-row" style={{ marginTop: 10 }}>
            <button
              className="toolbar-button"
              onClick={() => applyPreset("tree-outgoing")}
              type="button"
            >
              Dependency Tree
            </button>
            <button
              className="toolbar-button"
              onClick={() => applyPreset("tree-incoming")}
              type="button"
            >
              Reverse Tree
            </button>
            <button className="toolbar-button" onClick={() => applyPreset("hierarchy")} type="button">
              Hierarchy
            </button>
          </div>

          <div className="control-group">
            <label className="control-label" htmlFor="scope-select">
              Folder Scope
            </label>
            <select
              className="control-input"
              id="scope-select"
              onChange={(event) => setScope(event.target.value)}
              value={scope}
            >
              {scopeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label className="control-label" htmlFor="view-mode-select">
              View Mode
            </label>
            <select
              className="control-input"
              id="view-mode-select"
              onChange={(event) => updateViewMode(event.target.value as ViewMode, "replace")}
              value={viewMode}
            >
              <option value="search-neighbors">Search + neighbors</option>
              <option value="search-only">Search matches only</option>
              <option value="selected-1">Selected + 1 hop</option>
              <option value="selected-2">Selected + 2 hops</option>
              <option value="tree-outgoing">Dependency tree (outgoing)</option>
              <option value="tree-incoming">Reverse dependency tree (incoming)</option>
              <option value="hierarchy">Hierarchy (folder scoped)</option>
              <option value="full">Full visible scope</option>
            </select>
          </div>

          {(viewMode === "tree-outgoing" || viewMode === "tree-incoming") && (
            <div className="control-group">
              <label className="control-label" htmlFor="depth-select">
                Tree Depth
              </label>
              <select
                className="control-input"
                id="depth-select"
                onChange={(event) => setTreeDepth(Number(event.target.value))}
                value={treeDepth}
              >
                <option value={1}>1 hop</option>
                <option value={2}>2 hops</option>
                <option value={3}>3 hops</option>
                <option value={4}>4 hops</option>
                <option value={5}>5 hops</option>
                <option value={6}>6 hops</option>
              </select>
            </div>
          )}

          <div className="control-group">
            <label className="control-label" htmlFor="layout-select">
              Layout
            </label>
            <select
              className="control-input"
              id="layout-select"
              onChange={(event) => updateLayoutMode(event.target.value as LayoutMode, "replace")}
              value={layoutMode}
            >
              <option value="concentric">Concentric (by degree)</option>
              <option value="breadthfirst">Breadthfirst</option>
              <option value="cose">COSE force layout</option>
              <option value="circle">Circle</option>
            </select>
          </div>

          <label className="toggle-row">
            <input
              checked={showLabels}
              onChange={(event) => setShowLabels(event.target.checked)}
              type="checkbox"
            />
            Show labels
          </label>

          <label className="toggle-row">
            <input
              checked={showImportEdges}
              onChange={(event) => setShowImportEdges(event.target.checked)}
              type="checkbox"
            />
            Show import edges
          </label>

          <label className="toggle-row">
            <input
              checked={showReexportEdges}
              onChange={(event) => setShowReexportEdges(event.target.checked)}
              type="checkbox"
            />
            Show reexport edges
          </label>

          <div className="button-row">
            <button
              className="toolbar-button"
              onClick={recomputeLayout}
              title="Re-runs the active layout algorithm on currently visible nodes, then fits the view."
              type="button"
            >
              Recompute Layout
            </button>
            <button className="toolbar-button" onClick={fitVisible} type="button">
              Fit View
            </button>
            <button className="toolbar-button" onClick={() => zoomBy(0.85)} type="button">
              Zoom -
            </button>
            <button className="toolbar-button" onClick={() => zoomBy(1.18)} type="button">
              Zoom +
            </button>
          </div>

          <div className="details-row" style={{ marginTop: 10, marginBottom: 0 }}>
            Sidebar matches: {sidebarNodes.length}
          </div>
        </div>

        {viewMode === "hierarchy" && (
          <div className="folder-panel">
            <div className="folder-header">Folder Hierarchy</div>
            <div className="folder-row">
              <div className="folder-indent" style={{ width: 10 }} />
              <span className="folder-spacer">•</span>
              <button
                className={`folder-select${hierarchyFolderPrefix === "" ? " active" : ""}`}
                onClick={() => selectHierarchyFolder("")}
                type="button"
              >
                All folders
              </button>
            </div>
            <div className="folder-tree-scroll">{renderFolderBranch("", 0)}</div>
          </div>
        )}

        <ul className="node-list">
          {sidebarNodes.map((node) => (
            <li className="node-list-item" key={node.data.id}>
              <button
                className={`node-button${selectedId === node.data.id ? " active" : ""}`}
                onClick={() => focusNode(node.data.id)}
                type="button"
              >
                {node.data.label}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="graph-pane">
        <div className="graph-canvas" ref={containerRef} />
        <div className="status-overlay">
          <div>
            Visible nodes: {visibleNodeCount} / {graph.elements.nodes.length}
          </div>
          <div>
            Visible edges: {visibleEdgeCount} / {graph.elements.edges.length}
          </div>
          <div>
            Zoom: {zoomPercent}% (clamped {Math.round(MIN_ZOOM * 100)}-{Math.round(MAX_ZOOM * 100)}%)
          </div>
        </div>
        {(loading || error) && (
          <div className="status-overlay" style={{ top: 82 }}>
            {loading ? "Loading graph.json..." : `Error: ${error}`}
          </div>
        )}
      </main>

      <aside className="details">
        <div className="details-content">
          <h2 className="details-heading">Selected Node</h2>

          {!selectedNode ? (
            <div className="details-row">No node selected.</div>
          ) : (
            <>
              <div className="details-row">
                <span className="details-label">Id:</span> {selectedNode.id}
              </div>
              <div className="details-row">
                <span className="details-label">File:</span> {selectedNode.filePath}
              </div>
              <div className="details-row">
                <span className="details-label">Module Path:</span> {selectedNode.modulePath}
              </div>
              <div className="details-row">
                <span className="details-label">Imports:</span> {selectedNode.importCount}
              </div>
              <div className="details-row">
                <span className="details-label">Reexports:</span> {selectedNode.reexportCount}
              </div>
              <div className="details-row">
                <span className="details-label">Exports:</span> {selectedNode.exportCount}
              </div>

              <div className="details-row">
                <span className="details-label">Import Targets</span>
              </div>
              {renderModuleLinks(selectedNode.imports, selectedNode.importTargets)}

              <div className="details-row">
                <span className="details-label">Reexport Targets</span>
              </div>
              {renderModuleLinks(selectedNode.reexports, selectedNode.reexportTargets)}

              <div className="details-row">
                <span className="details-label">Exported Symbols</span>
              </div>
              <div>
                {selectedNode.exports.length === 0
                  ? "None"
                  : selectedNode.exports.map((symbol) => (
                      <button
                        className={`export-pill export-symbol-button${
                          selectedExportSymbol === symbol ? " active" : ""
                        }`}
                        key={symbol}
                        onClick={() =>
                          setSelectedExportSymbol((previous) =>
                            previous === symbol ? null : symbol
                          )
                        }
                        type="button"
                      >
                        {symbol}
                      </button>
                    ))}
              </div>

              {selectedExportSymbol && (
                <>
                  <div className="details-row" style={{ marginTop: 12 }}>
                    <span className="details-label">Modules Using `{selectedExportSymbol}`</span>
                  </div>
                  {selectedSymbolUsers.length === 0 ? (
                    <div className="details-row">
                      No direct-import usage found in indexed modules.
                    </div>
                  ) : (
                    <ul className="details-list">
                      {selectedSymbolUsers.map((userId) => (
                        <li className="details-list-item" key={userId}>
                          <button
                            className="inline-link"
                            onClick={() => focusNode(userId)}
                            type="button"
                          >
                            {userId}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
