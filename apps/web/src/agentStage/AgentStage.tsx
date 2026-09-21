import {
  BookOpen,
  Bot,
  Brain,
  Coffee,
  Globe,
  Hand,
  MessageSquare,
  MessageSquareText,
  PencilLine,
  Search,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import {
  STAGE_STATIONS,
  type StageAgent,
  type StageModel,
  type StageStation,
} from "./agentStage.logic";

const STATION_ICONS: Record<StageStation, LucideIcon> = {
  idle: Coffee,
  thinking: Brain,
  writing: MessageSquare,
  read: BookOpen,
  search: Search,
  edit: PencilLine,
  command: Terminal,
  browser: Globe,
  tool: Wrench,
  delegate: Users,
  waiting: Hand,
};

/** Room outside the ring for the orbiting sprites and the station labels, in px. */
const LABEL_MARGIN = 72;
const LABEL_WIDTH = 72;
/** Sprites circle their station on this radius, in px. */
const ORBIT = 28;
const SPRITE = 30;
const BUBBLE_WIDTH = 200;
/** How long a sprite stays put before it may move on, so a quick tool call is still seen. */
const DWELL_MS = 1600;
const MOVE_MS = 700;
const ORBIT_PERIOD_S = 10;
const SUBAGENT_HUES = [205, 285, 25, 145, 335, 55, 175, 255];

/**
 * Sprites circle their station while they work there. Transform-only
 * keyframes stay on the compositor, and the animation is paused for agents
 * at rest, so an idle stage draws nothing.
 */
const ORBIT_STYLE = `
@keyframes agent-stage-orbit { to { transform: rotate(360deg); } }
[data-agent-stage-spin] { animation: agent-stage-orbit ${ORBIT_PERIOD_S}s linear infinite; }
[data-agent-stage-spin="reverse"] { animation-direction: reverse; }
[data-agent-stage-spin][data-paused="true"] { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) { [data-agent-stage-spin] { animation: none; } }
`;

interface Point {
  readonly x: number;
  readonly y: number;
}

function stationAngle(station: StageStation): number {
  const index = STAGE_STATIONS.findIndex((candidate) => candidate.id === station);
  return -Math.PI / 2 + (Math.max(index, 0) / STAGE_STATIONS.length) * Math.PI * 2;
}

function ringPoint(angle: number, half: number, radius: number): Point {
  return { x: half + Math.cos(angle) * radius, y: half + Math.sin(angle) * radius };
}

function spriteColor(agent: StageAgent, index: number): string {
  if (agent.kind === "main") return "var(--primary)";
  return `hsl(${SUBAGENT_HUES[index % SUBAGENT_HUES.length]} 55% 48%)`;
}

/** What the bubble says: the current step, or the current thought while thinking. */
function bubbleText(agent: StageAgent): string | null {
  // Nothing to say once the agent is done, failed or waits for a prompt.
  if (!agent.live) return null;
  if (agent.station === "thinking") return agent.thought ?? agent.headline;
  if (agent.station === "writing") return agent.detail ?? agent.headline;
  return agent.detail ? `${agent.headline}: ${agent.detail}` : agent.headline;
}

interface DwellEntry {
  station: StageStation;
  target: StageStation;
  since: number;
  timer: number | null;
}

/**
 * Where each sprite is drawn. A sprite follows its agent's station, but only
 * after it has stood at the current one for a while: a call that finishes in
 * a hundred milliseconds would otherwise flick out and back before the move
 * is even visible. Timers fire only for pending moves; a still stage runs none.
 */
function createDwellStore() {
  const entries = new Map<string, DwellEntry>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, StageStation> = new Map();

  const publish = () => {
    snapshot = new Map([...entries].map(([id, entry]) => [id, entry.station]));
    for (const listener of listeners) listener();
  };

  const settle = (entry: DwellEntry) => {
    entry.timer = null;
    if (entry.station === entry.target) return;
    entry.station = entry.target;
    entry.since = performance.now();
    publish();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    update(agents: ReadonlyArray<StageAgent>) {
      const now = performance.now();
      let changed = false;
      const present = new Set<string>();
      for (const agent of agents) {
        present.add(agent.id);
        const entry = entries.get(agent.id);
        if (entry === undefined) {
          entries.set(agent.id, {
            station: agent.station,
            target: agent.station,
            since: now,
            timer: null,
          });
          changed = true;
          continue;
        }
        entry.target = agent.station;
        if (entry.station === entry.target) {
          if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          continue;
        }
        const remaining = DWELL_MS + MOVE_MS - (now - entry.since);
        if (remaining <= 0) {
          entry.station = entry.target;
          entry.since = now;
          changed = true;
        } else if (entry.timer === null) {
          entry.timer = window.setTimeout(() => settle(entry), remaining);
        }
      }
      for (const [id, entry] of entries) {
        if (present.has(id)) continue;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entries.delete(id);
        changed = true;
      }
      if (changed) publish();
    },
    dispose() {
      for (const entry of entries.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer);
      }
      entries.clear();
    },
  };
}

function useDrawnStations(agents: ReadonlyArray<StageAgent>): ReadonlyMap<string, StageStation> {
  const store = useMemo(() => createDwellStore(), []);
  useEffect(() => {
    store.update(agents);
  }, [agents, store]);
  useEffect(() => () => store.dispose(), [store]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * The scene: stations on a ring, the agents circling the station of their
 * current work, the selected agent's doings in the middle. A sprite changes
 * station by a transform transition; while it works it orbits its station,
 * and agents sharing one form a circle around it.
 */
export const AgentStage = memo(function AgentStage({
  model,
  selectedId,
  showThoughts,
  onSelect,
  onToggleThoughts,
}: {
  model: StageModel;
  selectedId: string;
  showThoughts: boolean;
  onSelect: (agentId: string) => void;
  onToggleThoughts: (show: boolean) => void;
}) {
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [side, setSide] = useState(0);
  useLayoutEffect(() => {
    const element = sceneRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSide(Math.floor(Math.min(rect.width, rect.height)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const drawn = useDrawnStations(model.agents);
  const half = side / 2;
  const ring = Math.max(half - LABEL_MARGIN, 0);
  const selected = model.agents.find((agent) => agent.id === selectedId) ?? model.agents[0]!;
  const occupied = new Set<StageStation>();
  const crowd = new Map<StageStation, number>();
  for (const agent of model.agents) {
    const station = drawn.get(agent.id) ?? agent.station;
    if (agent.live) occupied.add(station);
    crowd.set(station, (crowd.get(station) ?? 0) + 1);
  }
  const placed = new Map<StageStation, number>();
  const motion =
    "transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none";
  // A point, not a box: rotations must pivot exactly on the station.
  const pivot = "absolute top-0 left-0 size-0 [transform-origin:0_0]";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-agent-stage>
      <style>{ORBIT_STYLE}</style>
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <span className="text-xs text-muted-foreground">
          {model.running ? "Working" : "Resting"}
        </span>
        <Tooltip>
          <TooltipTrigger render={<span className="ml-auto flex shrink-0" />}>
            <Toggle
              pressed={showThoughts}
              onPressedChange={onToggleThoughts}
              aria-label="Show what the selected agent is doing"
              variant="ghost"
              size="sm"
            >
              <MessageSquareText className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {showThoughts ? "Hide the bubble" : "Show what the selected agent is doing in a bubble"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <div ref={sceneRef} className="flex min-h-0 flex-1 items-center justify-center p-3">
        {side > 0 ? (
          <div className="relative" style={{ width: side, height: side }}>
            <svg
              className="absolute inset-0 text-border"
              width={side}
              height={side}
              viewBox={`0 0 ${side} ${side}`}
              aria-hidden
            >
              <circle
                cx={half}
                cy={half}
                r={ring}
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                strokeDasharray="3 5"
              />
            </svg>

            {STAGE_STATIONS.map((station) => {
              const angle = stationAngle(station.id);
              const point = ringPoint(angle, half, ring);
              const labelPoint = ringPoint(angle, half, ring + ORBIT + SPRITE / 2 + 14);
              // Keep the label inside the scene: the panel clips anything beyond it.
              const label = {
                x: Math.min(Math.max(labelPoint.x, LABEL_WIDTH / 2), side - LABEL_WIDTH / 2),
                y: Math.min(Math.max(labelPoint.y, 6), side - 6),
              };
              const Icon = STATION_ICONS[station.id];
              const active = occupied.has(station.id);
              return (
                <div key={station.id} className="contents">
                  <div
                    className={cn(
                      "absolute flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background transition-colors duration-300",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground",
                    )}
                    style={{ left: point.x, top: point.y }}
                  >
                    <Icon className="size-3.5" />
                  </div>
                  <span
                    className={cn(
                      "absolute -translate-x-1/2 -translate-y-1/2 truncate text-center text-[10px] leading-none whitespace-nowrap",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                    style={{ left: label.x, top: label.y, width: LABEL_WIDTH }}
                  >
                    {station.label}
                  </span>
                </div>
              );
            })}

            <SelectedAgentCard agent={selected} width={Math.round(side * 0.42)} />

            {model.agents.map((agent, index) => {
              const station = drawn.get(agent.id) ?? agent.station;
              const slot = placed.get(station) ?? 0;
              placed.set(station, slot + 1);
              const count = crowd.get(station) ?? 1;
              const point = ringPoint(stationAngle(station), half, ring);
              const slotDeg = (slot / count) * 360 - 90;
              const isSelected = agent.id === selected.id;
              const bubble = isSelected && showThoughts ? bubbleText(agent) : null;
              return (
                // The orbit's centre travels between stations; everything
                // inside is relative to it.
                <div
                  key={agent.id}
                  className={cn("absolute top-0 left-0 size-0", motion)}
                  style={{
                    transform: `translate(${point.x}px, ${point.y}px)`,
                    zIndex: isSelected ? 3 : 2,
                  }}
                >
                  <div
                    className={pivot}
                    data-agent-stage-spin
                    data-paused={agent.live ? "false" : "true"}
                  >
                    <div
                      className={cn(pivot, motion)}
                      style={{ transform: `rotate(${slotDeg}deg) translate(${ORBIT}px)` }}
                    >
                      <div
                        className={pivot}
                        data-agent-stage-spin="reverse"
                        data-paused={agent.live ? "false" : "true"}
                      >
                        <button
                          type="button"
                          aria-label={`${agent.label}, ${agent.headline}`}
                          aria-pressed={isSelected}
                          onClick={() => onSelect(agent.id)}
                          className={cn(
                            "absolute top-0 left-0 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-xs font-semibold text-white shadow-md transition-[scale,opacity] duration-300",
                            "ring-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            isSelected && "ring-2 ring-foreground",
                            !agent.live && "opacity-50",
                          )}
                          style={{
                            width: SPRITE,
                            height: SPRITE,
                            rotate: `${-slotDeg}deg`,
                            scale: isSelected ? "1.15" : "1",
                            backgroundColor: spriteColor(agent, index - 1),
                          }}
                        >
                          {agent.kind === "main" ? (
                            <Bot className="size-4" />
                          ) : (
                            agent.label.trim().charAt(0).toUpperCase() || "A"
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                  {bubble ? (
                    <div
                      aria-live="polite"
                      className="pointer-events-none absolute top-0 left-0 rounded-lg border border-border bg-popover px-2 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md"
                      style={{
                        width: BUBBLE_WIDTH,
                        transform: `translate(${-BUBBLE_WIDTH / 2}px, ${-(ORBIT + SPRITE / 2 + 10)}px) translateY(-100%)`,
                      }}
                    >
                      <p className="line-clamp-3 break-words">{bubble}</p>
                      <span
                        aria-hidden
                        className="absolute -bottom-1.5 left-1/2 size-3 -translate-x-1/2 rotate-45 border-r border-b border-border bg-popover"
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
        {model.agents.map((agent, index) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent.id)}
            aria-pressed={agent.id === selected.id}
            className={cn(
              "flex max-w-48 shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              agent.id === selected.id
                ? "border-foreground/40 bg-accent text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
              !agent.live && "opacity-70",
            )}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: spriteColor(agent, index - 1) }}
            />
            <span className="truncate">{agent.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
});

function SelectedAgentCard({ agent, width }: { agent: StageAgent; width: number }) {
  const Icon = STATION_ICONS[agent.station];
  const monospace =
    agent.station === "command" || agent.station === "edit" || agent.station === "read";
  // The same step can repeat (two reads of one file), so keys count occurrences.
  const seen = new Map<string, number>();
  const recent = agent.recent.map((line) => {
    const occurrence = (seen.get(line) ?? 0) + 1;
    seen.set(line, occurrence);
    return { key: `${line}#${occurrence}`, line };
  });
  return (
    <div
      className="absolute top-1/2 left-1/2 z-[1] flex -translate-x-1/2 -translate-y-1/2 flex-col gap-1.5 overflow-hidden rounded-xl border border-border bg-card p-2.5 text-card-foreground shadow-sm"
      style={{ width }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {agent.kind === "main" ? (
          <Bot className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Users className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-xs font-medium">{agent.label}</span>
        {agent.role && agent.role !== agent.label ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {agent.role}
          </span>
        ) : null}
      </div>
      <div
        className={cn("flex items-center gap-1.5 text-xs", !agent.live && "text-muted-foreground")}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{agent.headline}</span>
      </div>
      {agent.detail ? (
        <p
          className={cn(
            "line-clamp-3 text-[11px] break-words text-muted-foreground",
            monospace && "font-mono",
          )}
        >
          {agent.detail}
        </p>
      ) : null}
      {recent.length > 0 ? (
        <ol className="flex flex-col gap-0.5 border-t border-border pt-1.5 text-[10px] text-muted-foreground">
          {recent.map((entry) => (
            <li key={entry.key} className="truncate">
              {entry.line}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
