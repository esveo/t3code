import {
  BookOpen,
  Bot,
  Brain,
  Coffee,
  Globe,
  Hand,
  MessageSquare,
  PencilLine,
  Search,
  Terminal,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
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

/** Ring radius and the sprites' track, as fractions of half the scene's side. */
const RING = 0.8;
const TRACK = 0.62;
const SPRITE = 40;
const SPRITE_GAP = 30;
const SUBAGENT_HUES = [205, 285, 25, 145, 335, 55, 175, 255];

interface Point {
  readonly x: number;
  readonly y: number;
}

function ringPoint(index: number, half: number, radius: number): Point {
  const angle = -Math.PI / 2 + (index / STAGE_STATIONS.length) * Math.PI * 2;
  return { x: half + Math.cos(angle) * half * radius, y: half + Math.sin(angle) * half * radius };
}

function spriteColor(agent: StageAgent, index: number): string {
  if (agent.kind === "main") return "var(--primary)";
  return `hsl(${SUBAGENT_HUES[index % SUBAGENT_HUES.length]} 55% 48%)`;
}

/**
 * The scene: stations on a ring, one sprite per agent standing at the station
 * of its current work, the selected agent's doings in the middle. Sprites
 * move by a transform transition only, so a still stage costs nothing.
 */
export const AgentStage = memo(function AgentStage({
  model,
  selectedId,
  onSelect,
  onClose,
}: {
  model: StageModel;
  selectedId: string;
  onSelect: (agentId: string) => void;
  onClose: () => void;
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

  const half = side / 2;
  const selected = model.agents.find((agent) => agent.id === selectedId) ?? model.agents[0]!;
  const occupied = new Set(
    model.agents.filter((agent) => agent.live).map((agent) => agent.station),
  );
  const stationIndex = new Map(STAGE_STATIONS.map((station, index) => [station.id, index]));
  const crowd = new Map<StageStation, number>();
  for (const agent of model.agents) crowd.set(agent.station, (crowd.get(agent.station) ?? 0) + 1);
  const placed = new Map<StageStation, number>();

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background text-foreground"
      data-agent-stage
      role="region"
      aria-label="Agent stage"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
        <span className="text-sm font-medium">Agent stage</span>
        <span className="text-xs text-muted-foreground">
          {model.running ? "Working" : "Resting"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Back to the chat"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div ref={sceneRef} className="flex min-h-0 flex-1 items-center justify-center p-4">
        {side > 0 ? (
          <div className="relative" style={{ width: side, height: side }}>
            <svg className="absolute inset-0 text-border" viewBox="0 0 100 100" aria-hidden>
              <circle
                cx="50"
                cy="50"
                r={50 * RING}
                fill="none"
                stroke="currentColor"
                strokeWidth="0.35"
                strokeDasharray="0.8 1.4"
              />
            </svg>

            {STAGE_STATIONS.map((station, index) => {
              const point = ringPoint(index, half, RING);
              const Icon = STATION_ICONS[station.id];
              const active = occupied.has(station.id);
              return (
                <div
                  key={station.id}
                  className="absolute flex w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
                  style={{ left: point.x, top: point.y }}
                >
                  <div
                    className={cn(
                      "flex size-10 items-center justify-center rounded-full border bg-background transition-colors duration-300",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </div>
                  <span
                    className={cn(
                      "text-center text-[11px] leading-tight",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {station.label}
                  </span>
                </div>
              );
            })}

            {model.agents.map((agent, index) => {
              const slot = placed.get(agent.station) ?? 0;
              placed.set(agent.station, slot + 1);
              const count = crowd.get(agent.station) ?? 1;
              const point = ringPoint(stationIndex.get(agent.station) ?? 0, half, TRACK);
              // Fan agents sharing a station out along the ring's tangent.
              const angle =
                -Math.PI / 2 +
                ((stationIndex.get(agent.station) ?? 0) / STAGE_STATIONS.length) * Math.PI * 2;
              const spread = (slot - (count - 1) / 2) * SPRITE_GAP;
              const x = point.x - Math.sin(angle) * spread - SPRITE / 2;
              const y = point.y + Math.cos(angle) * spread - SPRITE / 2;
              const isSelected = agent.id === selected.id;
              return (
                <button
                  key={agent.id}
                  type="button"
                  aria-label={`${agent.label}, ${agent.headline}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelect(agent.id)}
                  className={cn(
                    "absolute top-0 left-0 flex size-10 items-center justify-center rounded-full text-sm font-semibold text-white shadow-md transition-transform duration-700 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
                    "ring-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected && "ring-2 ring-foreground",
                    !agent.live && "opacity-50",
                  )}
                  style={{
                    transform: `translate(${x}px, ${y}px)${isSelected ? " scale(1.15)" : ""}`,
                    backgroundColor: spriteColor(agent, index - 1),
                    zIndex: isSelected ? 2 : 1,
                  }}
                >
                  {agent.kind === "main" ? (
                    <Bot className="size-5" />
                  ) : (
                    agent.label.trim().charAt(0).toUpperCase() || "A"
                  )}
                </button>
              );
            })}

            <SelectedAgentCard agent={selected} width={Math.round(side * 0.44)} />
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 px-4 pb-3">
        {model.agents.map((agent, index) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent.id)}
            aria-pressed={agent.id === selected.id}
            className={cn(
              "flex max-w-56 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
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
            <span className="shrink-0 text-muted-foreground">
              · {STAGE_STATIONS.find((station) => station.id === agent.station)?.label}
            </span>
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
      className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3 text-card-foreground shadow-sm"
      style={{ width }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {agent.kind === "main" ? (
          <Bot className="size-4 shrink-0 text-primary" />
        ) : (
          <Users className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-sm font-medium">{agent.label}</span>
        {agent.role && agent.role !== agent.label ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {agent.role}
          </span>
        ) : null}
      </div>
      <div
        className={cn("flex items-center gap-2 text-sm", !agent.live && "text-muted-foreground")}
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{agent.headline}</span>
      </div>
      {agent.detail ? (
        <p
          className={cn(
            "line-clamp-3 text-xs break-words text-muted-foreground",
            monospace && "font-mono",
          )}
        >
          {agent.detail}
        </p>
      ) : null}
      {recent.length > 0 ? (
        <ol className="flex flex-col gap-0.5 border-t border-border pt-2 text-[11px] text-muted-foreground">
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
