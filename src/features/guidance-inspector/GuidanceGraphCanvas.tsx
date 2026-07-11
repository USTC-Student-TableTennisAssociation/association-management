"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Core, CoseLayoutOptions, NodeSingular, StylesheetJson } from "cytoscape";

import { toCytoscapeElements } from "./cytoscape-adapter";
import { createDefaultGuidancePositions, getFocusedPositions, type GuidancePositionMap } from "./guidance-focus";
import { getGuidelineNeighbors } from "./guidance-graph";
import type {
  GuidanceGraph,
  GuidanceGraphEdge,
  GuidancePosition,
  InspectorSelection,
} from "./guidance-types";

const layoutStorageKey = "guidance-layer-inspector:positions:v1";

type SavedGuidanceLayout = {
  version: 1;
  graphFingerprint: string;
  positions: Record<string, GuidancePosition>;
};

type EdgeTooltip = {
  edge: GuidanceGraphEdge;
  x: number;
  y: number;
};

export type GuidanceGraphCanvasHandle = {
  fitGraph: () => void;
  runAutomaticLayout: () => void;
  restoreDefaultLayout: () => void;
};

type GuidanceGraphCanvasProps = {
  graph: GuidanceGraph;
  selection: InspectorSelection;
  matchingNodeIds: readonly string[];
  onlyShowMatches: boolean;
  hoveredNodeId: string | null;
  diagnosticNodeIds: readonly string[];
  diagnosticEdgeIds: readonly string[];
  onSelectionChange: (selection: InspectorSelection) => void;
};

const cytoscapeStyles: StylesheetJson = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      shape: "round-rectangle",
      width: 170,
      height: 78,
      "background-color": "#ffffff",
      "border-width": 2,
      "border-color": "#94a3b8",
      color: "#182230",
      "font-family": "Arial, Helvetica, sans-serif",
      "font-size": 11,
      "font-weight": 600,
      "text-wrap": "wrap",
      "text-max-width": "150px",
      "text-valign": "center",
      "text-halign": "center",
      "text-outline-color": "#ffffff",
      "text-outline-width": 2,
      "overlay-opacity": 0,
      "transition-property": "opacity, width, height, border-width, border-color, background-color",
      "transition-duration": 180,
    },
  },
  {
    selector: ".kind-workflow",
    style: { shape: "round-rectangle", "background-color": "#ecfdf5", "border-color": "#059669" },
  },
  {
    selector: ".kind-rule",
    style: { shape: "hexagon", "background-color": "#eff6ff", "border-color": "#2563eb" },
  },
  {
    selector: ".kind-checklist",
    style: { shape: "rectangle", "background-color": "#fffbeb", "border-color": "#d97706" },
  },
  {
    selector: ".kind-experience",
    style: { shape: "ellipse", "background-color": "#faf5ff", "border-color": "#9333ea" },
  },
  {
    selector: ".status-draft",
    style: { "border-style": "dashed" },
  },
  {
    selector: ".status-published",
    style: { "border-style": "solid" },
  },
  {
    selector: ".is-mandatory",
    style: { "border-width": 4 },
  },
  {
    selector: "edge",
    style: {
      width: 1.8,
      "line-color": "#94a3b8",
      "target-arrow-color": "#94a3b8",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      label: "data(label)",
      color: "#475569",
      "font-size": 10,
      "font-weight": 700,
      "text-background-color": "#ffffff",
      "text-background-opacity": 0.94,
      "text-background-padding": "3px",
      "text-rotation": "autorotate",
      "overlay-opacity": 0,
      "transition-property": "opacity, width, line-color, target-arrow-color",
      "transition-duration": 180,
    },
  },
  {
    selector: ".relation-contains",
    style: { "line-color": "#059669", "target-arrow-color": "#059669" },
  },
  {
    selector: ".relation-triggers",
    style: {
      "line-color": "#2563eb",
      "target-arrow-color": "#2563eb",
      "line-style": "dashed",
    },
  },
  {
    selector: ".relation-requires",
    style: { width: 3, "line-color": "#c2410c", "target-arrow-color": "#c2410c" },
  },
  {
    selector: ".relation-next",
    style: {
      "line-color": "#7c3aed",
      "target-arrow-color": "#7c3aed",
      "line-style": "dotted",
    },
  },
  {
    selector: ".relation-exception",
    style: {
      "line-color": "#dc2626",
      "target-arrow-color": "#dc2626",
      "line-style": "dashed",
    },
  },
  {
    selector: "node.is-selected",
    style: {
      width: 198,
      height: 90,
      "border-width": 6,
      "border-color": "#0f172a",
      "z-index": 20,
    },
  },
  {
    selector: "node.is-neighbor, node.is-related, node.is-diagnostic",
    style: {
      "border-width": 4,
      "border-color": "#0f766e",
      "z-index": 12,
    },
  },
  {
    selector: "node.is-second-neighbor",
    style: { opacity: 0.65, "z-index": 8 },
  },
  {
    selector: "node.is-hovered",
    style: { "border-color": "#0f172a", "border-width": 5, "z-index": 18 },
  },
  {
    selector: "node.is-dimmed, edge.is-dimmed",
    style: { opacity: 0.18 },
  },
  {
    selector: "node.is-filtered-out, edge.is-filtered-out",
    style: { opacity: 0.28 },
  },
  {
    selector: "node.is-dimmed",
    style: { width: 138, height: 64 },
  },
  {
    selector: "edge.is-active, edge.is-selected, edge.is-diagnostic",
    style: { width: 4.5, opacity: 1, "z-index": 15 },
  },
  {
    selector: ".is-hidden",
    style: { display: "none" },
  },
];

function getGraphFingerprint(graph: GuidanceGraph): string {
  return `${graph.nodes.map((node) => node.id).join("|")}::${graph.edges.map((edge) => edge.id).join("|")}`;
}

function isGuidancePosition(value: unknown): value is GuidancePosition {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  );
}

function readSavedPositions(
  graph: GuidanceGraph,
  fingerprint: string,
): Record<string, GuidancePosition> | null {
  try {
    const rawValue = window.localStorage.getItem(layoutStorageKey);
    if (!rawValue) {
      return null;
    }

    const parsed: unknown = JSON.parse(rawValue);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("graphFingerprint" in parsed) ||
      !("positions" in parsed) ||
      parsed.version !== 1 ||
      parsed.graphFingerprint !== fingerprint ||
      typeof parsed.positions !== "object" ||
      parsed.positions === null
    ) {
      return null;
    }

    const positions = parsed.positions as Record<string, unknown>;
    const restored: Record<string, GuidancePosition> = {};
    for (const node of graph.nodes) {
      const position = positions[node.id];
      if (!isGuidancePosition(position)) {
        return null;
      }
      restored[node.id] = position;
    }

    return restored;
  } catch {
    return null;
  }
}

export const GuidanceGraphCanvas = forwardRef<GuidanceGraphCanvasHandle, GuidanceGraphCanvasProps>(
  function GuidanceGraphCanvas(
    {
      graph,
      selection,
      matchingNodeIds,
      onlyShowMatches,
      hoveredNodeId,
      diagnosticNodeIds,
      diagnosticEdgeIds,
      onSelectionChange,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const cyRef = useRef<Core | null>(null);
    const basePositionsRef = useRef<Record<string, GuidancePosition>>({});
    const onSelectionChangeRef = useRef(onSelectionChange);
    const [isLayoutReady, setIsLayoutReady] = useState(false);
    const [edgeTooltip, setEdgeTooltip] = useState<EdgeTooltip | null>(null);
    const defaultPositions = useMemo(() => createDefaultGuidancePositions(graph), [graph]);
    const graphFingerprint = useMemo(() => getGraphFingerprint(graph), [graph]);

    useEffect(() => {
      onSelectionChangeRef.current = onSelectionChange;
    }, [onSelectionChange]);

    const savePositions = useCallback(
      (positions: GuidancePositionMap) => {
        const savedLayout: SavedGuidanceLayout = {
          version: 1,
          graphFingerprint,
          positions: { ...positions },
        };

        try {
          window.localStorage.setItem(layoutStorageKey, JSON.stringify(savedLayout));
        } catch {
          // 本地存储不可用时仍保持本次会话内的布局，不影响只读浏览。
        }
      },
      [graphFingerprint],
    );

    const captureBasePositions = useCallback(
      (cy: Core) => {
        const positions = Object.fromEntries(
          graph.nodes.map((node) => {
            const position = cy.getElementById(node.id).position();
            return [node.id, { x: position.x, y: position.y }];
          }),
        );
        basePositionsRef.current = positions;
        savePositions(positions);
      },
      [graph.nodes, savePositions],
    );

    const fitGraph = useCallback(() => {
      const cy = cyRef.current;
      if (!cy) {
        return;
      }
      const visibleElements = cy.elements(":visible");
      if (visibleElements.length > 0) {
        cy.fit(visibleElements, 54);
      }
    }, []);

    const runAutomaticLayout = useCallback(
      (restoreDefaultPositions: boolean) => {
        const cy = cyRef.current;
        if (!cy) {
          return;
        }

        if (restoreDefaultPositions) {
          cy.nodes().forEach((node) => {
            const position = defaultPositions[node.id()];
            if (position) {
              node.position(position);
            }
          });
        }

        setIsLayoutReady(false);
        const layoutOptions: CoseLayoutOptions = {
          name: "cose",
          animate: true,
          animationDuration: 360,
          randomize: false,
          fit: true,
          padding: 68,
          nodeRepulsion: 7600,
          idealEdgeLength: 175,
          edgeElasticity: 0.42,
          gravity: 0.34,
          numIter: 900,
        };
        const layout = cy.layout(layoutOptions);
        layout.one("layoutstop", () => {
          captureBasePositions(cy);
          setIsLayoutReady(true);
        });
        layout.run();
      },
      [captureBasePositions, defaultPositions],
    );

    useImperativeHandle(
      ref,
      () => ({
        fitGraph,
        runAutomaticLayout: () => runAutomaticLayout(false),
        restoreDefaultLayout: () => {
          try {
            window.localStorage.removeItem(layoutStorageKey);
          } catch {
            // 删除本地布局失败时仍尝试恢复当前会话里的默认布局。
          }
          runAutomaticLayout(true);
        },
      }),
      [fitGraph, runAutomaticLayout],
    );

    useEffect(() => {
      let disposed = false;

      async function initializeGraph(): Promise<void> {
        const container = containerRef.current;
        if (!container) {
          return;
        }

        const cytoscapeModule = await import("cytoscape");
        if (disposed || !containerRef.current) {
          return;
        }

        const cy = cytoscapeModule.default({
          container,
          elements: toCytoscapeElements(graph),
          style: cytoscapeStyles,
          layout: { name: "preset" },
          minZoom: 0.35,
          maxZoom: 2.4,
          boxSelectionEnabled: false,
          selectionType: "single",
        });

        cyRef.current = cy;
        cy.nodes().forEach((node) => {
          const position = defaultPositions[node.id()];
          if (position) {
            node.position(position);
          }
        });

        cy.on("tap", "node", (event) => {
          onSelectionChangeRef.current({ type: "node", id: event.target.id() });
        });
        cy.on("tap", "edge", (event) => {
          onSelectionChangeRef.current({ type: "edge", id: event.target.id() });
        });
        cy.on("tap", (event) => {
          if (event.target === cy) {
            onSelectionChangeRef.current(null);
          }
        });
        cy.on("mouseover", "edge", (event) => {
          const edge = graph.edgeById.get(event.target.id());
          if (edge) {
            setEdgeTooltip({ edge, x: event.renderedPosition.x, y: event.renderedPosition.y });
          }
        });
        cy.on("mouseout", "edge", () => {
          setEdgeTooltip(null);
        });
        cy.on("dragfree", "node", (event) => {
          const node = event.target as NodeSingular;
          const position = node.position();
          basePositionsRef.current = {
            ...basePositionsRef.current,
            [node.id()]: { x: position.x, y: position.y },
          };
          savePositions(basePositionsRef.current);
        });

        const savedPositions = readSavedPositions(graph, graphFingerprint);
        if (savedPositions) {
          cy.nodes().forEach((node) => {
            const position = savedPositions[node.id()];
            if (position) {
              node.position(position);
            }
          });
          basePositionsRef.current = savedPositions;
          setIsLayoutReady(true);
          fitGraph();
        } else {
          runAutomaticLayout(true);
        }
      }

      void initializeGraph();

      return () => {
        disposed = true;
        setEdgeTooltip(null);
        cyRef.current?.destroy();
        cyRef.current = null;
      };
    }, [defaultPositions, fitGraph, graph, graphFingerprint, runAutomaticLayout, savePositions]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || typeof ResizeObserver === "undefined") {
        return;
      }

      let frameId: number | null = null;
      const observer = new ResizeObserver(() => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        frameId = window.requestAnimationFrame(() => {
          const cy = cyRef.current;
          if (!cy) {
            return;
          }
          cy.resize();
          const visibleElements = cy.elements(":visible");
          if (visibleElements.length > 0) {
            cy.center(visibleElements);
          }
        });
      });

      observer.observe(container);
      return () => {
        observer.disconnect();
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }, []);

    useEffect(() => {
      const cy = cyRef.current;
      if (!cy || !isLayoutReady) {
        return;
      }

      const classNames = [
        "is-selected",
        "is-neighbor",
        "is-second-neighbor",
        "is-related",
        "is-diagnostic",
        "is-dimmed",
        "is-filtered-out",
        "is-hidden",
        "is-hovered",
        "is-active",
      ].join(" ");
      cy.elements().removeClass(classNames);

      const matchingIds = new Set(matchingNodeIds);
      const diagnosticNodeIdSet = new Set(diagnosticNodeIds);
      const diagnosticEdgeIdSet = new Set(diagnosticEdgeIds);
      const selectedEdge = selection?.type === "edge" ? graph.edgeById.get(selection.id) : undefined;
      const selectedEdgeNodeIds = new Set(
        selectedEdge ? [selectedEdge.fromGuidelineId, selectedEdge.toGuidelineId] : [],
      );
      const neighbors =
        selection?.type === "node" ? getGuidelineNeighbors(graph, selection.id) : null;
      const focusVisibleNodeIds = new Set([
        ...(neighbors ? [neighbors.selectedNodeId, ...neighbors.firstDegreeNodeIds] : []),
        ...selectedEdgeNodeIds,
        ...diagnosticNodeIdSet,
      ]);

      cy.nodes().forEach((node) => {
        const nodeId = node.id();
        const matches = matchingIds.has(nodeId);
        if (!matches && onlyShowMatches && !focusVisibleNodeIds.has(nodeId)) {
          node.addClass("is-hidden");
        } else if (!matches) {
          node.addClass("is-filtered-out");
        }
      });
      cy.edges().forEach((edge) => {
        const sourceMatches = matchingIds.has(edge.source().id());
        const targetMatches = matchingIds.has(edge.target().id());
        const isFocusEdge =
          (neighbors?.firstDegreeEdgeIds.includes(edge.id()) ?? false) ||
          edge.id() === selectedEdge?.id ||
          diagnosticEdgeIdSet.has(edge.id());
        if (!sourceMatches || !targetMatches) {
          if (onlyShowMatches && !isFocusEdge) {
            edge.addClass("is-hidden");
          } else {
            edge.addClass("is-filtered-out");
          }
        }
      });

      if (neighbors) {
        const firstDegreeNodeIds = new Set(neighbors.firstDegreeNodeIds);
        const secondDegreeNodeIds = new Set(neighbors.secondDegreeNodeIds);
        const firstDegreeEdgeIds = new Set(neighbors.firstDegreeEdgeIds);
        cy.nodes().forEach((node) => {
          if (node.id() === neighbors.selectedNodeId) {
            node.addClass("is-selected");
          } else if (firstDegreeNodeIds.has(node.id())) {
            node.addClass("is-neighbor");
          } else if (secondDegreeNodeIds.has(node.id())) {
            node.addClass("is-second-neighbor");
          } else {
            node.addClass("is-dimmed");
          }
        });
        cy.edges().forEach((edge) => {
          if (firstDegreeEdgeIds.has(edge.id())) {
            edge.addClass("is-active");
          } else {
            edge.addClass("is-dimmed");
          }
        });

        const positions = getFocusedPositions(graph, basePositionsRef.current, neighbors.selectedNodeId, neighbors);
        cy.nodes().forEach((node) => {
          const position = positions[node.id()];
          if (position) {
            node.stop();
            node.animate({ position }, { duration: 240, easing: "ease-out" });
          }
        });
        let focusElements = cy.getElementById(neighbors.selectedNodeId);
        neighbors.firstDegreeNodeIds.forEach((nodeId) => {
          focusElements = focusElements.union(cy.getElementById(nodeId));
        });
        cy.animate({ fit: { eles: focusElements, padding: 84 } }, { duration: 240, easing: "ease-out" });
      } else if (selectedEdge) {
        cy.nodes().forEach((node) => {
          node.addClass(selectedEdgeNodeIds.has(node.id()) ? "is-related" : "is-dimmed");
        });
        cy.edges().forEach((edge) => {
          edge.addClass(edge.id() === selectedEdge.id ? "is-selected" : "is-dimmed");
        });
      } else if (selection?.type === "diagnostic") {
        cy.nodes().forEach((node) => {
          node.addClass(diagnosticNodeIdSet.has(node.id()) ? "is-diagnostic" : "is-dimmed");
        });
        cy.edges().forEach((edge) => {
          edge.addClass(diagnosticEdgeIdSet.has(edge.id()) ? "is-diagnostic" : "is-dimmed");
        });
      } else {
        cy.nodes().forEach((node) => {
          const position = basePositionsRef.current[node.id()] ?? defaultPositions[node.id()];
          if (position) {
            node.stop();
            node.animate({ position }, { duration: 220, easing: "ease-out" });
          }
        });
      }

      if (hoveredNodeId) {
        cy.getElementById(hoveredNodeId).addClass("is-hovered");
      }
    }, [
      defaultPositions,
      diagnosticEdgeIds,
      diagnosticNodeIds,
      graph,
      hoveredNodeId,
      isLayoutReady,
      matchingNodeIds,
      onlyShowMatches,
      selection,
    ]);

    return (
      <div className="relative min-h-[520px] min-w-0 flex-1 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm lg:min-h-0">
        <div className="absolute inset-0">
          <div
            ref={containerRef}
            className="h-full w-full bg-[radial-gradient(circle_at_1px_1px,_rgba(148,163,184,0.22)_1px,_transparent_0)] bg-[size:18px_18px]"
            aria-label="指导层自由知识图"
          />
        </div>
        {edgeTooltip ? (
          <div
            className="pointer-events-none absolute z-30 max-w-64 rounded-md border border-zinc-200 bg-white/95 px-3 py-2 text-xs leading-5 text-zinc-700 shadow-lg backdrop-blur"
            style={{ left: edgeTooltip.x + 14, top: edgeTooltip.y + 14 }}
          >
            <p className="font-semibold text-zinc-900">关系说明</p>
            <p className="mt-1">{edgeTooltip.edge.note ?? "未填写关系说明"}</p>
          </div>
        ) : null}
      </div>
    );
  },
);

GuidanceGraphCanvas.displayName = "GuidanceGraphCanvas";
