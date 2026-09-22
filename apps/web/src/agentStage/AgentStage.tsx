import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  BookOpen,
  Bot,
  Brain,
  Clock,
  Coffee,
  Eye,
  EyeOff,
  Globe,
  Hand,
  MessageSquare,
  MessagesSquare,
  PencilLine,
  Search,
  Terminal,
  TriangleAlert,
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

import { cn } from "~/lib/utils";

import { ComposerPendingApprovalActions } from "../components/chat/ComposerPendingApprovalActions";
import { ProjectFavicon } from "../components/ProjectFavicon";
import {
  deriveStageRecap,
  stageElapsedMs,
  stageStationTimes,
  stageStuckAfterMs,
  STAGE_STATIONS,
  type StageAgent,
  type StageAttention,
  type StageModel,
  type StageStation,
} from "./agentStage.logic";
import type { AgentStageMode } from "./agentStageStore";

export interface StageApprovalHandlers {
  readonly respondingRequestIds: ReadonlyArray<ApprovalRequestId>;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

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
/** How long a sprite stays put before it may move on, so a quick tool call is still seen. */
const DWELL_MS = 1600;
const MOVE_MS = 700;
const ORBIT_PERIOD_S = 10;
const SUBAGENT_HUES = [205, 285, 25, 145, 335, 55, 175, 255];
const NO_AGENTS: ReadonlyArray<StageAgent> = [];

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

/** The first sprite (main agent, or the open thread) wears the primary colour. */
function spriteColor(agent: StageAgent, index: number): string {
  if (agent.kind === "main" || index < 0) return "var(--primary)";
  return `hsl(${SUBAGENT_HUES[index % SUBAGENT_HUES.length]} 55% 48%)`;
}

function stationLabel(station: StageStation): string {
  return STAGE_STATIONS.find((candidate) => candidate.id === station)?.label ?? "Working";
}

/**
 * A clock the scene can read. It runs only while something is actually
 * moving, and each reader picks its own interval so a ticking duration never
 * repaints the whole stage.
 */
function useStageTick(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** Arc centred on a station, drawn clockwise from its middle outwards. */
function arcPath(half: number, radius: number, angle: number, halfWidth: number): string {
  const from = {
    x: half + Math.cos(angle - halfWidth) * radius,
    y: half + Math.sin(angle - halfWidth) * radius,
  };
  const to = {
    x: half + Math.cos(angle + halfWidth) * radius,
    y: half + Math.sin(angle + halfWidth) * radius,
  };
  return `M ${from.x} ${from.y} A ${radius} ${radius} 0 0 1 ${to.x} ${to.y}`;
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
  onSelect,
  approvals = null,
  mode = "thread",
  onModeChange = null,
  hidden = NO_AGENTS,
  onHide = null,
  onShow = null,
  onShowAll = null,
}: {
  model: StageModel;
  selectedId: string;
  onSelect: (agentId: string) => void;
  /** Present when the stage may answer approvals itself. */
  approvals?: StageApprovalHandlers | null;
  mode?: AgentStageMode;
  /** Present when the stage offers the everything view. */
  onModeChange?: ((mode: AgentStageMode) => void) | null;
  /** Agents the user took off the stage; they still work, and the roster brings them back. */
  hidden?: ReadonlyArray<StageAgent>;
  onHide?: ((agentId: string) => void) | null;
  onShow?: ((agentId: string) => void) | null;
  onShowAll?: (() => void) | null;
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
  const needsUser = new Set(model.attention.map((item) => item.agentId));
  const half = side / 2;
  const ring = Math.max(half - LABEL_MARGIN, 0);
  // Up to the orbits' inner edge, never below what a narrow panel can spare.
  const cardWidth = Math.round(Math.max(2 * (ring - ORBIT - SPRITE / 2 - 12), side * 0.4));
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
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {mode === "everything"
            ? `${model.agents.filter((agent) => agent.live).length} ${model.agents.filter((agent) => agent.live).length === 1 ? "thread" : "threads"} working`
            : model.running
              ? "Working"
              : "Resting"}
        </span>
        {onModeChange !== null ? <StageModeToggle mode={mode} onChange={onModeChange} /> : null}
      </div>
      {model.attention.length > 0 ? (
        <StageAttentionBar items={model.attention} approvals={approvals} onSelect={onSelect} />
      ) : null}

      <div ref={sceneRef} className="flex min-h-0 flex-1 items-center justify-center p-3">
        {side > 0 ? (
          <div className="relative" style={{ width: side, height: side }}>
            <StationRing
              side={side}
              half={half}
              ring={ring}
              agent={selected}
              occupied={occupied}
              waiting={model.attention.length}
            />

            <SelectedAgentCard agent={selected} width={cardWidth} />

            {model.agents.map((agent, index) => {
              const station = drawn.get(agent.id) ?? agent.station;
              const slot = placed.get(station) ?? 0;
              placed.set(station, slot + 1);
              const count = crowd.get(station) ?? 1;
              const point = ringPoint(stationAngle(station), half, ring);
              const slotDeg = (slot / count) * 360 - 90;
              const isSelected = agent.id === selected.id;
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
                            "absolute top-0 left-0 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-xs font-semibold shadow-md transition-[scale,opacity] duration-300",
                            "ring-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            // A session wears its project's icon on a plain face; a subagent is a coloured dot.
                            agent.project !== null ? "border-2 bg-background" : "text-white",
                            isSelected && "ring-2 ring-foreground",
                            !agent.live && "opacity-50",
                            needsUser.has(agent.id) && "ring-2 ring-warning",
                          )}
                          style={{
                            width: SPRITE,
                            height: SPRITE,
                            rotate: `${-slotDeg}deg`,
                            scale: isSelected ? "1.15" : "1",
                            ...(agent.project !== null
                              ? { borderColor: spriteColor(agent, index - 1) }
                              : { backgroundColor: spriteColor(agent, index - 1) }),
                          }}
                        >
                          {agent.project !== null ? (
                            <ProjectFavicon project={agent.project} className="size-4" />
                          ) : agent.kind === "main" ? (
                            <Bot className="size-4" />
                          ) : (
                            agent.label.trim().charAt(0).toUpperCase() || "A"
                          )}
                          {agent.initials ? (
                            <span
                              aria-hidden
                              className="absolute -right-1.5 -bottom-1 rounded-full border border-background px-1 text-[8px] leading-[12px] font-semibold text-white"
                              style={{ backgroundColor: spriteColor(agent, index - 1) }}
                            >
                              {agent.initials}
                            </span>
                          ) : null}
                          {agent.alerts.length > 0 ? (
                            <span
                              aria-hidden
                              className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border border-background bg-warning"
                            />
                          ) : null}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
        {model.agents.map((agent, index) => (
          <div
            key={agent.id}
            className={cn(
              "flex max-w-52 shrink-0 items-center rounded-full border text-[11px] transition-colors",
              agent.id === selected.id
                ? "border-foreground/40 bg-accent text-foreground"
                : "border-border text-muted-foreground",
              !agent.live && "opacity-70",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(agent.id)}
              aria-pressed={agent.id === selected.id}
              className="flex min-w-0 items-center gap-1.5 py-0.5 pl-2 pr-1.5 hover:text-foreground"
            >
              {agent.project !== null ? (
                <ProjectFavicon project={agent.project} className="size-3" />
              ) : (
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: spriteColor(agent, index - 1) }}
                />
              )}
              {agent.initials ? (
                <span className="shrink-0 font-semibold tabular-nums opacity-70">
                  {agent.initials}
                </span>
              ) : null}
              <span className="truncate">{agent.label}</span>
            </button>
            {/* The first agent anchors the stage and cannot be hidden. */}
            {onHide !== null && index > 0 ? (
              <button
                type="button"
                aria-label={`Hide ${agent.label} from the stage`}
                onClick={() => onHide(agent.id)}
                className="flex shrink-0 items-center pr-1.5 pl-0.5 text-muted-foreground/60 hover:text-foreground"
              >
                <EyeOff className="size-3" />
              </button>
            ) : null}
          </div>
        ))}
        {hidden.map((agent) => (
          <button
            key={agent.id}
            type="button"
            aria-label={`Show ${agent.label} on the stage`}
            onClick={() => onShow?.(agent.id)}
            className="flex max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground/60 hover:text-foreground"
          >
            <Eye className="size-3 shrink-0" />
            <span className="truncate">{agent.label}</span>
          </button>
        ))}
        {hidden.length > 0 && onShowAll !== null ? (
          <button
            type="button"
            onClick={onShowAll}
            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-primary hover:underline"
          >
            Show all
          </button>
        ) : null}
      </div>
    </div>
  );
});

/** This thread alone, or every thread with live work. */
function StageModeToggle({
  mode,
  onChange,
}: {
  mode: AgentStageMode;
  onChange: (mode: AgentStageMode) => void;
}) {
  const option = (value: AgentStageMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => onChange(value)}
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] transition-colors",
        mode === value
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Stage scope"
      className="flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5"
    >
      {option("thread", "This thread")}
      {option("everything", "Everything")}
    </div>
  );
}

/**
 * The ring: the stations, and how the selected agent's turn divides between
 * them. An arc grows with the time spent at its station, so a turn that sat
 * ten minutes in the terminal says so without anyone reading the work log.
 */
function StationRing({
  side,
  half,
  ring,
  agent,
  occupied,
  waiting,
}: {
  side: number;
  half: number;
  ring: number;
  agent: StageAgent;
  occupied: ReadonlySet<StageStation>;
  waiting: number;
}) {
  // Slow on purpose: the arcs are a shape, not a stopwatch.
  const now = useStageTick(agent.live && agent.since !== null, 5_000);
  const times = stageStationTimes(agent, now);
  const busiest = times[0]?.ms ?? 0;
  const byStation = new Map(times.map((entry) => [entry.station, entry.ms] as const));
  const widest = (Math.PI / STAGE_STATIONS.length) * 0.85;

  return (
    <>
      <svg
        className="absolute inset-0"
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
          className="text-border"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 5"
        />
        {STAGE_STATIONS.map((station) => {
          const ms = byStation.get(station.id) ?? 0;
          if (ms <= 0 || busiest <= 0) return null;
          // Even a moment at a station stays visible; the busiest one fills its share.
          const halfWidth = widest * Math.max(0.12, ms / busiest);
          return (
            <path
              key={station.id}
              d={arcPath(half, ring, stationAngle(station.id), halfWidth)}
              fill="none"
              stroke="currentColor"
              strokeWidth={5}
              strokeLinecap="round"
              className={
                station.id === agent.station && agent.live ? "text-primary" : "text-primary/30"
              }
            />
          );
        })}
      </svg>

      {STAGE_STATIONS.map((station) => {
        const angle = stationAngle(station.id);
        const point = ringPoint(angle, half, ring);
        const labelPoint = ringPoint(angle, half, ring + ORBIT + SPRITE / 2 + 14);
        // Keep the label inside the scene: the panel clips anything beyond it.
        const label = {
          x: Math.min(Math.max(labelPoint.x, LABEL_WIDTH / 2), side - LABEL_WIDTH / 2),
          y: Math.min(Math.max(labelPoint.y, 10), side - 10),
        };
        const Icon = STATION_ICONS[station.id];
        const active = occupied.has(station.id);
        const calling = station.id === "waiting" && waiting > 0;
        const ms = byStation.get(station.id) ?? 0;
        return (
          <div key={station.id} className="contents">
            <div
              className={cn(
                "absolute flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background transition-colors duration-300",
                calling
                  ? "border-warning/50 bg-warning/15 text-warning"
                  : active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground",
              )}
              style={{ left: point.x, top: point.y }}
            >
              <Icon className="size-3.5" />
              {calling ? (
                <span className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-warning/40 bg-warning/20 text-[9px] font-semibold text-warning-foreground">
                  {waiting}
                </span>
              ) : null}
            </div>
            <span
              className={cn(
                "absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 text-center text-[10px] leading-none",
                calling
                  ? "text-warning-foreground"
                  : active
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
              style={{ left: label.x, top: label.y, width: LABEL_WIDTH }}
            >
              <span className="w-full truncate">{station.label}</span>
              {ms >= 1_000 ? (
                <span className="tabular-nums opacity-70">{formatDuration(ms)}</span>
              ) : null}
            </span>
          </div>
        );
      })}
    </>
  );
}

/**
 * What the thread is stuck on, and, for an approval, the answer to it. The
 * stage is where the user is looking while agents run, so a decision it can
 * show is a decision it should be able to take.
 */
function StageAttentionBar({
  items,
  approvals,
  onSelect,
}: {
  items: ReadonlyArray<StageAttention>;
  approvals: StageApprovalHandlers | null;
  onSelect: (agentId: string) => void;
}) {
  const lead = items[0]!;
  const waited = useStageTick(true, 1_000) - Date.parse(lead.since);
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-warning/32 bg-warning-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Hand className="size-3.5 shrink-0 text-warning" />
        <button
          type="button"
          onClick={() => onSelect(lead.agentId)}
          className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
        >
          {lead.title}
        </button>
        {Number.isFinite(waited) && waited >= 1_000 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {formatDuration(waited)}
          </span>
        ) : null}
        {items.length > 1 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">+{items.length - 1}</span>
        ) : null}
      </div>
      {lead.detail ? (
        <p className="line-clamp-3 font-mono text-[11px] break-words text-muted-foreground">
          {lead.detail}
        </p>
      ) : null}
      {lead.approval !== null && approvals !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <ComposerPendingApprovalActions
            requestId={lead.approval.requestId}
            isResponding={approvals.respondingRequestIds.includes(lead.approval.requestId)}
            options={lead.approval.options}
            onRespondToApproval={approvals.onRespondToApproval}
          />
        </div>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          Answer it in the chat to let the work continue.
        </span>
      )}
    </div>
  );
}

/**
 * How long the agent has stood where it stands. Past what its station makes
 * sense for, it turns into the one thing the stage can say that the timeline
 * cannot: this is not moving.
 */
function StationElapsed({ agent }: { agent: StageAgent }) {
  const now = useStageTick(agent.live && agent.since !== null, 1_000);
  const elapsed = stageElapsedMs(agent, now);
  if (elapsed === null || elapsed < 1_000) return null;
  const stuck = elapsed >= stageStuckAfterMs(agent.station);
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[11px]",
        stuck ? "text-warning-foreground" : "text-muted-foreground",
      )}
    >
      {stuck ? (
        <TriangleAlert className="size-3 shrink-0" />
      ) : (
        <Clock className="size-3 shrink-0" />
      )}
      <span className="truncate tabular-nums">
        {stationLabel(agent.station)} for {formatDuration(elapsed)}
      </span>
    </div>
  );
}

/**
 * What the turn came to, once the agent rests: how long, how many steps, how
 * many broke, and where the time went. The arcs already say the last part
 * in shape; this says it in numbers.
 */
function StageRecapLine({ agent }: { agent: StageAgent }) {
  const recap = deriveStageRecap(agent);
  if (recap === null) return null;
  const breakdown = recap.stationTimes
    .filter((entry) => entry.ms >= 1_000)
    .slice(0, 3)
    .map((entry) => `${stationLabel(entry.station)} ${formatDuration(entry.ms)}`)
    .join(" · ");
  return (
    <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Clock className="size-3 shrink-0" />
        <span className="truncate tabular-nums">
          {recap.totalMs >= 1_000 ? `${formatDuration(recap.totalMs)} · ` : ""}
          {recap.steps} {recap.steps === 1 ? "step" : "steps"}
          {recap.failedSteps > 0 ? (
            <span className="text-warning-foreground">, {recap.failedSteps} failed</span>
          ) : null}
        </span>
      </div>
      {breakdown.length > 0 ? <span className="truncate tabular-nums">{breakdown}</span> : null}
    </div>
  );
}

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
        {agent.project !== null ? (
          <ProjectFavicon project={agent.project} className="size-3.5" />
        ) : agent.kind === "main" ? (
          <Bot className="size-3.5 shrink-0 text-primary" />
        ) : agent.kind === "thread" ? (
          <MessagesSquare className="size-3.5 shrink-0 text-primary" />
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
            "line-clamp-4 text-[11px] break-words text-muted-foreground",
            monospace && "font-mono",
          )}
        >
          {agent.detail}
        </p>
      ) : null}
      <StationElapsed agent={agent} />
      <StageRecapLine agent={agent} />
      {agent.alerts.map((alert) => (
        <div
          key={alert.kind}
          className="flex items-center gap-1.5 text-[11px] text-warning-foreground"
        >
          <TriangleAlert className="size-3 shrink-0 text-warning" />
          <span className="truncate">{alert.text}</span>
        </div>
      ))}
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
